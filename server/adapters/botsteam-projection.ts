import type { Item } from "../types.ts";
import { StreamLimitError } from "./botsteam-api.ts";

export type Row = Record<string, any>;
export type Scope = { project: string; conversation?: string; bot?: string };
export const text = (row: Row | undefined, key: string): string => typeof row?.[key] === "string" ? row[key] : "";
export const terminal = (status: string): boolean => ["completed", "failed", "cancelled", "interrupted"].includes(status);
export function json(value: unknown): Row {
  try { const data = typeof value === "string" ? JSON.parse(value) : value; return data && typeof data === "object" && !Array.isArray(data) ? data : {}; } catch { return {}; }
}
export const timestamp = (value: unknown): number => typeof value === "string" && Number.isFinite(Date.parse(value)) ? Date.parse(value) : 0;

type Run = { task: string; id: string; first: number; ts: number; employee: string; text: string; reasoning: string; reply: string; summary: string; status: string; tools: Map<string, Row> };

/** Derived entirely from server task snapshots and persistent event identities. */
export class BotsTeamProjection {
  cursor = 0;
  tasks = new Map<string, Row>();
  private runs = new Map<string, Run>();
  private bytes = 0;
  setTasks(rows: Row[]): void { this.tasks = new Map(rows.filter((row) => text(row, "id")).map((row) => [text(row, "id"), row])); }
  root(id: string): string {
    const seen = new Set<string>(); let current = id;
    for (let i = 0; i < 40; i++) { if (seen.has(current)) return ""; seen.add(current); const parent = text(this.tasks.get(current), "parent_id"); if (!parent) return current; if (!this.tasks.has(parent)) return ""; current = parent; }
    return "";
  }
  belongs(task: Row | undefined, scope: Scope): boolean {
    if (!task || text(task, "project_id") !== scope.project) return false;
    const owner = this.tasks.get(this.root(text(task, "id")));
    if (!owner) return false;
    return scope.bot ? text(owner, "channel") === "direct" && text(owner, "assigned_employee_id") === scope.bot
      : text(owner, "channel") !== "direct" && text(owner, "conversation_id") === scope.conversation;
  }
  active(scope: Scope): Row[] { return [...this.tasks.values()].filter((row) => this.belongs(row, scope) && !terminal(text(row, "status"))); }
  event(event: Row): void {
    const id = event.id;
    if (!Number.isSafeInteger(id) || id <= this.cursor) return;
    const task = text(event, "task_id"), runId = text(event, "run_id"), kind = text(event, "type"), payload = text(event, "payload");
    if (!task || !runId) { this.cursor = id; return; }
    const key = `${task}:${runId}`;
    let run = this.runs.get(key);
    if (!run) {
      if (this.runs.size >= 20_000) throw new StreamLimitError();
      run = { task, id: runId, first: id, ts: timestamp(event.created_at), employee: "", text: "", reasoning: "", reply: "", summary: "", status: "", tools: new Map() }; this.runs.set(key, run);
    }
    const data = json(payload);
    if (kind === "run_starting") run.employee = payload;
    if (kind === "text_delta" || kind === "thinking_delta") {
      this.bytes += Buffer.byteLength(payload);
      if (this.bytes > 32 * 1024 * 1024) throw new StreamLimitError();
      if (kind === "text_delta") run.text += payload; else run.reasoning += payload;
    }
    if (kind === "tool_execution_start" || kind === "tool_execution_end") {
      const call = text(data, "toolCallId");
      if (call) { this.bytes += Buffer.byteLength(payload); if (this.bytes > 32 * 1024 * 1024) throw new StreamLimitError(); const previous = run.tools.get(call);
        run.tools.set(call, { ...previous, ...data, args: { ...json(previous?.args), ...json(data.args) }, pending: kind === "tool_execution_start" }); }
    }
    if (["task_completed", "task_failed", "task_cancelled", "task_interrupted"].includes(kind)) {
      this.bytes += Buffer.byteLength(payload); if (this.bytes > 32 * 1024 * 1024) throw new StreamLimitError();
      run.reply = text(data, "reply"); run.summary = text(data, "summary"); run.status = text(data, "status") || kind.slice(5);
    }
    this.cursor = id;
  }
  items(scope: Scope, employees: Map<string, Row>): Item[] {
    const result: Item[] = [];
    const ordered = [...this.tasks.values()].sort((a, b) => timestamp(a.created_at) - timestamp(b.created_at) || text(a, "id").localeCompare(text(b, "id")));
    for (const owner of ordered) {
      if (text(owner, "parent_id") || !this.belongs(owner, scope)) continue;
      const taskId = text(owner, "id"), ts = timestamp(owner.created_at);
      result.push({ id: `user:${taskId}`, kind: "user", text: text(owner, "description") || text(owner, "title"), ts, taskId });
      const runs = [...this.runs.values()].filter((run) => this.root(run.task) === taskId).sort((a, b) => a.first - b.first);
      for (const run of runs) {
        const task = this.tasks.get(run.task)!;
        const employee = run.employee || text(task, "assigned_employee_id");
        const speaker = { id: employee, name: text(employees.get(employee), "name") || employee || "Bot" };
        const key = `${run.task}:${run.id}`, stamp = run.ts || timestamp(task.created_at) || ts;
        const active = !terminal(run.status || text(task, "status")) && (!task.run_id || task.run_id === run.id);
        const common = { ts: stamp, taskId: run.task, runId: run.id, speaker };
        if (run.reasoning) result.push({ ...common, id: `reasoning:${key}`, kind: "reasoning", text: run.reasoning, streaming: active });
        for (const [call, tool] of run.tools) {
          const args = json(tool.args), changes = json(tool.changes);
          const input = text(args, "command") || text(args, "path") || (Object.keys(args).length ? JSON.stringify(args) : "");
          result.push({ ...common, id: `tool:${key}:${call}`, kind: "tool", text: "", tool: {
            name: text(tool, "toolName") || "tool", input,
            output: text(tool, "output") || text(tool, "error") || text(tool, "summary"),
            status: tool.pending && active ? "running" : tool.isError === true ? "error" : tool.pending ? undefined : "ok",
            ...(typeof tool.exitCode === "number" ? { exitCode: tool.exitCode } : {}),
            ...(typeof changes.added === "number" ? { additions: changes.added } : {}),
            ...(typeof changes.removed === "number" ? { deletions: changes.removed } : {}),
          } });
        }
        const message = run.reply || run.text || run.summary;
        result.push({ ...common, id: `assistant:${key}`, kind: "assistant", text: message || (active ? "正在执行…" : run.status === "cancelled" || run.status === "interrupted" ? "已停止" : ""), streaming: active });
      }
      for (const task of ordered) {
        const id = text(task, "id");
        if (this.root(id) !== taskId || runs.some((run) => run.task === id)) continue;
        const employee = text(task, "assigned_employee_id"), summary = text(task, "result_summary");
        result.push({ id: `summary:${id}`, kind: "assistant", text: summary ? `历史摘要：${summary}` : terminal(text(task, "status")) ? "（旧记录没有回复原文）" : "正在执行…", taskId: id, ts: timestamp(task.created_at), speaker: { id: employee, name: text(employees.get(employee), "name") || employee || "Bot" }, streaming: !terminal(text(task, "status")) });
      }
    }
    return result;
  }
}
