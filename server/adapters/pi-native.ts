import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { readFile, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
import type { Adapter, Hub } from "../hub.ts";
import type { AgentAvailability, ApprovalAnswer, History, Item, SessionSummary, ToolInfo } from "../types.ts";
import { invalidConfig, type SessionConfig, type SessionConfigPatch } from "../session-config.ts";
import { diffStats, extractImages } from "../artifacts.ts";
import { moveToTrash } from "../trash.ts";
import { formatArgs } from "../util.ts";

type Json = Record<string, any>;
const TIMEOUT = 20_000;
const PAGE = 60;
const NOTICE = "原生 Pi 内置工具直接执行，没有逐次权限审批或权限模式；仅扩展主动请求的确认、选择和输入会显示交互。";
const busy = () => Object.assign(new Error("Pi 会话正在运行，请先停止或等待完成"), { status: 409 });
const key = (id: string) => `pi-native:${id}`;
const modelKey = (model: Json) => JSON.stringify([model.provider, model.id]);
const text = (content: any): string => typeof content === "string" ? content : Array.isArray(content) ? content.filter((v) => v.type === "text").map((v) => v.text ?? "").join("\n") : "";
const hash = (value: string) => createHash("sha256").update(value).digest("hex").slice(0, 20);
const expand = (path: string) => resolve(path === "~" ? homedir() : path.startsWith("~/") ? join(homedir(), path.slice(2)) : path);

/** Pi v1.2 JSONL: LF only (readline incorrectly splits U+2028/U+2029). */
class Rpc {
  readonly child: ChildProcessWithoutNullStreams;
  private pending = new Map<string, { resolve: (data: Json) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();
  private sequence = 0;
  private ended = false;
  private closing = false;
  private failure: Error | null = null;
  private notified = false;
  private closed: Promise<void>;
  private stderr = "";
  onEvent: (event: Json) => void = () => {};
  onExit: (error: Error) => void = () => {};

  constructor(bin: string, args: string[], cwd: string, agentDir: string) {
    this.child = spawn(bin, args, {
      cwd, env: { ...process.env, PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: "1", PI_TELEMETRY: "0" },
      stdio: ["pipe", "pipe", "pipe"], detached: process.platform !== "win32",
    });
    this.closed = new Promise((done) => {
      this.child.once("close", (code, signal) => {
        this.ended = true;
        const error = this.failure ?? new Error(`Pi RPC 退出 (${signal ?? code})${this.stderr ? `: ${this.stderr}` : ""}`);
        this.fail(error);
        if (!this.closing) { this.signal("SIGKILL"); this.notifyExit(error); }
        done();
      });
    });
    this.child.once("exit", () => this.signal("SIGKILL"));
    this.child.on("error", (error) => this.terminate(error));
    this.child.stdin.on("error", (error) => this.terminate(error));
    this.child.stderr.setEncoding("utf8");
    this.child.stderr.on("data", (chunk: string) => { this.stderr = (this.stderr + chunk).slice(-4000); });
    this.child.stdout.setEncoding("utf8");
    let buffer = "";
    this.child.stdout.on("data", (chunk: string) => {
      buffer += chunk;
      if (buffer.length > 64_000_000) { this.terminate(new Error("Pi RPC record too large")); return; }
      let cut: number;
      while ((cut = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, cut).replace(/\r$/, ""); buffer = buffer.slice(cut + 1);
        if (!line) continue;
        try {
          const event = JSON.parse(line);
          if (event.type === "response") {
            const request = this.pending.get(event.id);
            if (!request) continue;
            clearTimeout(request.timer); this.pending.delete(event.id);
            if (event.success) request.resolve(event.data ?? {});
            else request.reject(new Error(event.error ?? `Pi ${event.command} failed`));
          } else this.onEvent(event);
        } catch (error) {
          this.terminate(new Error(`Pi RPC 协议错误: ${String(error)}`)); return;
        }
      }
    });
  }

  private fail(error: Error): void {
    this.failure ??= error;
    for (const request of this.pending.values()) { clearTimeout(request.timer); request.reject(error); }
    this.pending.clear();
  }

  private notifyExit(error: Error): void {
    if (!this.notified) { this.notified = true; this.onExit(error); }
  }

  private terminate(error: Error): void {
    this.fail(error);
    if (!this.closing) this.notifyExit(error);
    void this.close();
  }

  private signal(signal: NodeJS.Signals): void {
    try {
      if (process.platform !== "win32" && this.child.pid) process.kill(-this.child.pid, signal);
      else this.child.kill(signal);
    } catch { /* The owned process already exited. */ }
  }

  write(record: Json): Promise<void> {
    if (this.ended || this.failure || this.closing) return Promise.reject(this.failure ?? new Error("Pi RPC 已关闭"));
    return new Promise((done, reject) => {
      const timer = setTimeout(() => {
        const error = new Error("Pi RPC stdin 写入超时"); reject(error); this.terminate(error);
      }, TIMEOUT);
      this.child.stdin.write(`${JSON.stringify(record)}\n`, (error) => {
        clearTimeout(timer);
        if (error) { reject(error); this.terminate(error); } else done();
      });
    });
  }

  request(type: string, args: Json = {}, timeout = TIMEOUT): Promise<Json> {
    if (this.ended || this.failure || this.closing) return Promise.reject(this.failure ?? new Error("Pi RPC 已关闭"));
    const id = String(++this.sequence);
    return new Promise((done, reject) => {
      const timer = setTimeout(() => {
        const error = new Error(`Pi RPC ${type} 超时`);
        this.terminate(error);
      }, timeout);
      this.pending.set(id, { resolve: done, reject, timer });
      void this.write({ ...args, id, type }).catch((error) => this.terminate(error));
    });
  }

  async close(): Promise<void> {
    if (!this.closing) {
      this.closing = true;
      this.fail(new Error("Pi RPC 已关闭"));
      this.child.stdin.end();
    }
    if (this.ended) { this.signal("SIGKILL"); return; }
    const term = setTimeout(() => this.signal("SIGTERM"), 300);
    const kill = setTimeout(() => this.signal("SIGKILL"), 1000);
    try { await this.closed; } finally { clearTimeout(term); clearTimeout(kill); this.signal("SIGKILL"); }
  }
}

type SessionFile = { path: string; header: Json; entries: Json[]; updatedAt: number };

function parseFile(raw: string, path: string, updatedAt: number): SessionFile | null {
  const records: Json[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try { const entry = JSON.parse(line); if (entry && typeof entry === "object") records.push(entry); }
    catch { /* A writer may not have finished the last line. */ }
  }
  const header = records[0];
  if (header?.type !== "session" || typeof header.id !== "string") return null;
  const entries = records.slice(1);
  // v1 linear logs have no tree IDs. Reading them must not migrate the user's file.
  for (let i = 0; i < entries.length; i++) {
    entries[i].id ??= `legacy-${i}`;
    if (!("parentId" in entries[i])) entries[i].parentId = i ? entries[i - 1].id : null;
  }
  return { path, header, entries, updatedAt };
}

function branch(entries: Json[], leafId?: string | null): Json[] {
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  let entry = byId.get(leafId === undefined ? entries.at(-1)?.id : leafId);
  const selected: Json[] = [], seen = new Set<string>();
  while (entry && !seen.has(entry.id)) {
    selected.push(entry); seen.add(entry.id); entry = byId.get(entry.parentId);
  }
  return selected.reverse();
}

/** Message events have no entry ID; role + timestamp + occurrence survives a history reload. */
function messageId(message: Json, counts: Map<string, number>): string {
  if (message.role === "toolResult") return `tool:${message.toolCallId}`;
  const base = `${message.role}:${message.timestamp ?? hash(JSON.stringify(message))}`;
  const count = counts.get(base) ?? 0;
  counts.set(base, count + 1);
  return `message:${base}:${count}`;
}

function toolItem(call: Json, result?: Json, durationMs?: number): Item {
  const args = call.arguments ?? {}, details = result?.details ?? {};
  const tool: ToolInfo = {
    name: call.name ?? result?.toolName ?? "tool", input: formatArgs(args),
    output: text(result?.content), status: result ? result.isError ? "error" : "ok" : "running",
    ...(typeof durationMs === "number" ? { durationMs } : {}),
    ...(typeof details.exitCode === "number" ? { exitCode: details.exitCode } : {}),
  };
  // edit returns a numbered display diff; patch (when present) is a unified diff.
  if (result && !result.isError && typeof (details.patch ?? details.diff) === "string") {
    const counts = diffStats(details.patch ?? details.diff);
    Object.assign(tool, counts, { files: [{ path: args.path ?? "", ...counts }] });
  }
  return { id: `tool:${call.id}`, kind: "tool", text: "", tool, images: extractImages(result), ...(result?.timestamp ? { ts: result.timestamp } : {}) };
}

function mapMessage(message: Json, id: string): Item[] {
  const base = { ...(typeof message.timestamp === "number" ? { ts: message.timestamp } : {}) };
  if (message.role === "user") return [{ id, kind: "user", text: text(message.content), images: extractImages(message.content), ...base }];
  if (message.role === "assistant") {
    const items: Item[] = [];
    const thinking = (message.content ?? []).filter((v: Json) => v.type === "thinking").map((v: Json) => v.thinking ?? "").join("\n");
    if (thinking) items.push({ id: `${id}:thinking`, kind: "reasoning", text: thinking, ...base });
    if (text(message.content)) items.push({ id, kind: "assistant", text: text(message.content), ...base });
    for (const call of message.content ?? []) if (call.type === "toolCall") items.push(toolItem(call));
    if (message.errorMessage) items.push({ id: `${id}:error`, kind: "error", text: message.errorMessage, ...base });
    return items;
  }
  if (message.role === "custom" && message.display !== false) return [{ id, kind: "system", text: text(message.content), images: extractImages(message.content), ...base }];
  if (message.role === "bashExecution") return [{ id, kind: "tool", text: "", tool: { name: "bash", input: message.command, output: message.output, exitCode: message.exitCode, status: message.cancelled || message.exitCode ? "error" : "ok" }, ...base }];
  return [];
}

function historyItems(entries: Json[], leafId?: string | null): Item[] {
  const counts = new Map<string, number>(), ids = new Map<string, string>();
  for (const entry of entries) if (entry.type === "message") ids.set(entry.id, messageId(entry.message, counts));
  const items = new Map<string, Item>(), calls = new Map<string, Json>();
  for (const entry of branch(entries, leafId)) {
    if (entry.type === "message") {
      const message = entry.message;
      if (message.role === "assistant") for (const call of message.content ?? []) if (call.type === "toolCall") calls.set(call.id, call);
      if (message.role === "toolResult") {
        const item = toolItem(calls.get(message.toolCallId) ?? { id: message.toolCallId, name: message.toolName }, message, message.durationMs);
        items.set(item.id, item);
      } else for (const item of mapMessage(message, ids.get(entry.id)!)) items.set(item.id, item);
    } else if (entry.type === "compaction" || entry.type === "branch_summary") {
      items.set(entry.id, { id: `entry:${entry.id}`, kind: "system", text: entry.summary ?? "", ts: Date.parse(entry.timestamp) });
    } else if (entry.type === "custom_message" && entry.display !== false) {
      items.set(entry.id, { id: `entry:${entry.id}`, kind: "system", text: text(entry.content), images: extractImages(entry.content) });
    }
  }
  return [...items.values()];
}

type Live = {
  rpc: Rpc; id: string; cwd: string; path: string; busy: boolean; locked: boolean;
  counts: Map<string, number>; message: { id: string; value: Json } | null;
  items: Map<string, Item>; tools: Map<string, Json>; started: Map<string, number>;
  ready: boolean;
};
type Dialog = { live: Live; request: Json; timer?: NodeJS.Timeout };

export class PiNativeAdapter implements Adapter {
  readonly agent = "pi-native" as const;
  private readonly hub: Hub;
  private readonly bin: string;
  private readonly agentDir: string;
  private readonly sessionRoot: string;
  private error: string | null = "原生 Pi 尚未检测";
  private stopped = false;
  private processes = new Set<Rpc>();
  private live = new Map<string, Live>();
  private opening = new Map<string, Promise<Live>>();
  private files = new Map<string, SessionFile>();
  private dialogs = new Map<string, Dialog>();

  constructor(hub: Hub, bin?: string, agentDir?: string) {
    this.hub = hub;
    this.bin = bin ?? "pi";
    this.agentDir = expand(agentDir ?? process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent"));
    this.sessionRoot = expand(process.env.PI_CODING_AGENT_SESSION_DIR ?? join(this.agentDir, "sessions"));
  }

  availability(): AgentAvailability {
    return { agent: this.agent, ok: this.error === null, ...(this.error ? { reason: this.error } : {}) };
  }

  private launch(cwd: string, args: string[], probe = false): Rpc {
    if (this.stopped) throw new Error("Pi adapter 已停止");
    const rpc = new Rpc(this.bin, ["--mode", "rpc", "--offline", ...(probe ? ["--no-session", "--no-extensions", "--no-mcp", "--no-skills", "--no-context-files", "--no-prompt-templates"] : args)], cwd, this.agentDir);
    this.processes.add(rpc);
    rpc.child.once("close", () => this.processes.delete(rpc));
    // Discovery must never leave startup dialogs waiting on a UI.
    rpc.onEvent = (event) => {
      if (event.type === "extension_ui_request" && ["confirm", "select", "input", "editor"].includes(event.method)) void rpc.write({ type: "extension_ui_response", id: event.id, cancelled: true }).catch(() => {});
    };
    return rpc;
  }

  async start(): Promise<void> {
    this.stopped = false;
    let rpc: Rpc | undefined;
    try { rpc = this.launch(homedir(), [], true); await rpc.request("get_state"); this.error = null; }
    catch (error) { this.error = `原生 Pi 不可用: ${String(error)}`; }
    finally { await rpc?.close(); }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    for (const live of this.live.values()) this.cancelDialogs(live, true);
    await Promise.all([...this.processes].map((rpc) => rpc.close()));
    for (const live of this.live.values()) this.hub.status(key(live.id), "idle");
    this.live.clear(); this.opening.clear();
    this.error = "原生 Pi adapter 已停止";
  }

  private async scan(): Promise<SessionFile[]> {
    const result: SessionFile[] = [];
    const visit = async (dir: string, depth: number): Promise<void> => {
      let names;
      try { names = await readdir(dir, { withFileTypes: true }); }
      catch (error: any) { if (error.code === "ENOENT") return; throw error; }
      for (const name of names) {
        const path = join(dir, name.name);
        if (name.isDirectory() && depth < 3) await visit(path, depth + 1);
        else if (name.isFile() && name.name.endsWith(".jsonl")) {
          try {
            const [raw, info] = await Promise.all([readFile(path, "utf8"), stat(path)]);
            const file = parseFile(raw, path, info.mtimeMs); if (file) result.push(file);
          } catch (error: any) { if (error.code !== "ENOENT") this.hub.notice("error", `无法读取 Pi 会话 ${path}: ${String(error)}`); }
        }
      }
    };
    await visit(this.sessionRoot, 0);
    this.files.clear();
    for (const file of result) this.files.set(file.header.id, file);
    return result;
  }

  async listSessions(): Promise<SessionSummary[]> {
    const files = await this.scan();
    const summaries = new Map<string, SessionSummary>();
    for (const file of files) {
      const nativeId = file.header.id, active = this.live.get(nativeId);
      const name = file.entries.filter((e) => e.type === "session_info").at(-1)?.name;
      const first = branch(file.entries).find((e) => e.type === "message" && e.message.role === "user");
      summaries.set(nativeId, { id: key(nativeId), nativeId, agent: this.agent, title: name || text(first?.message.content).slice(0, 120) || "Pi 会话", cwd: file.header.cwd ?? null, updatedAt: file.updatedAt, status: this.hub.liveStatus(key(nativeId)) ?? (active?.busy ? "running" : "idle") });
    }
    for (const live of this.live.values()) if (!summaries.has(live.id)) summaries.set(live.id, { id: key(live.id), nativeId: live.id, agent: this.agent, title: [...live.items.values()].find((i) => i.kind === "user")?.text.slice(0, 120) || "Pi 会话", cwd: live.cwd, updatedAt: Date.now(), status: this.hub.liveStatus(key(live.id)) ?? (live.busy ? "running" : "idle") });
    return [...summaries.values()].sort((a, b) => b.updatedAt - a.updatedAt);
  }

  private async file(id: string): Promise<SessionFile> {
    await this.scan();
    const file = this.files.get(id);
    if (!file) throw Object.assign(new Error("原生 Pi 会话不存在"), { status: 404 });
    return file;
  }

  async history(nativeId: string, before: string | null): Promise<History> {
    const live = this.live.get(nativeId);
    let items: Item[];
    if (live) {
      const data = await live.rpc.request("get_entries");
      const persisted = historyItems(data.entries ?? [], data.leafId);
      const merged = new Map(persisted.map((i) => [i.id, i]));
      // Never resurrect messages from a branch an extension has left.
      for (const item of live.items.values()) {
        if (merged.has(item.id) || item.streaming || (live.busy && item.tool?.status === "running")) merged.set(item.id, item);
      }
      items = [...merged.values()];
    } else items = historyItems((await this.file(nativeId)).entries);
    const cut = before === null ? items.length : items.findIndex((i) => i.id === before);
    if (cut < 0) throw invalidConfig("历史游标已失效，请刷新会话");
    const start = Math.max(0, cut - PAGE);
    return { items: items.slice(start, cut), before: start > 0 ? items[start].id : null };
  }

  private attach(rpc: Rpc, state: Json, cwd: string, entries: Json[]): Live {
    if (this.stopped) throw new Error("Pi adapter 已停止");
    if (typeof state.sessionId !== "string" || typeof state.sessionFile !== "string") throw new Error("Pi 未返回持久会话 ID/文件");
    const counts = new Map<string, number>();
    for (const e of entries) if (e.type === "message") messageId(e.message, counts);
    const live: Live = { rpc, id: state.sessionId, cwd, path: resolve(state.sessionFile), busy: !!(state.isStreaming || state.isCompacting), locked: false, counts, message: null, items: new Map(), tools: new Map(), started: new Map(), ready: true };
    rpc.onEvent = (event) => this.event(live, event);
    rpc.onExit = (error) => {
      live.ready = false; live.busy = false;
      this.cancelDialogs(live, false);
      for (const item of live.items.values()) if (item.streaming) this.publish(live, { ...item, streaming: false });
      this.hub.status(key(live.id), "idle");
      this.hub.notice("error", error.message, key(live.id));
      if (this.live.get(live.id) === live) this.live.delete(live.id);
    };
    this.live.set(live.id, live);
    this.hub.notice("info", NOTICE, key(live.id));
    return live;
  }

  private async ensure(nativeId: string): Promise<Live> {
    const current = this.live.get(nativeId);
    if (current?.ready) return current;
    const opening = this.opening.get(nativeId); if (opening) return opening;
    const promise = (async () => {
      const file = await this.file(nativeId);
      const rpc = this.launch(file.header.cwd || homedir(), ["--session", file.path]);
      try {
        const state = await rpc.request("get_state");
        if (state.sessionId !== nativeId || resolve(state.sessionFile ?? "") !== resolve(file.path)) throw new Error("Pi 恢复了不同的会话文件，已停止");
        const data = await rpc.request("get_entries");
        return this.attach(rpc, state, file.header.cwd || homedir(), data.entries ?? []);
      } catch (error) { await rpc.close(); throw error; }
    })();
    this.opening.set(nativeId, promise);
    try { return await promise; } finally { this.opening.delete(nativeId); }
  }

  private publish(live: Live, item: Item): void {
    live.items.set(item.id, item); this.hub.item(key(live.id), item);
  }

  private event(live: Live, event: Json): void {
    if (event.type === "extension_ui_request") { this.dialog(live, event); return; }
    if (event.type === "agent_start") { live.busy = true; this.hub.status(key(live.id), "running"); }
    if (event.type === "agent_settled") {
      live.busy = false; this.cancelDialogs(live, true);
      for (const item of live.items.values()) if (item.streaming) this.publish(live, { ...item, streaming: false });
      this.hub.status(key(live.id), "idle"); this.hub.sessionsChanged();
    }
    if (event.type === "message_start") {
      const value = structuredClone(event.message);
      live.message = { id: messageId(value, live.counts), value };
      if (value.role !== "toolResult") for (const item of mapMessage(value, live.message.id)) this.publish(live, { ...item, ...(value.role === "assistant" ? { streaming: true } : {}) });
    }
    if (event.type === "message_update" && live.message) {
      const update = event.assistantMessageEvent, current = live.message;
      if (!update || !["text_delta", "text_end", "thinking_delta", "thinking_end"].includes(update.type)) return;
      const thinking = update.type.startsWith("thinking"), field = thinking ? "thinking" : "text";
      current.value.content ??= [];
      const block = current.value.content[update.contentIndex] ??= { type: thinking ? "thinking" : "text", [field]: "" };
      block[field] = update.type.endsWith("_delta") ? (block[field] ?? "") + (update.delta ?? "") : update.content ?? block[field];
      // Sparse arrays are possible when tool-call deltas were skipped.
      const value = { ...current.value, content: current.value.content.filter(Boolean) };
      for (const item of mapMessage(value, current.id)) this.publish(live, { ...item, streaming: true });
    }
    if (event.type === "message_end") {
      const message = event.message;
      const id = live.message && live.message.value.role === message.role ? live.message.id : messageId(message, live.counts);
      if (message.role === "toolResult") {
        const call = live.tools.get(message.toolCallId) ?? { id: message.toolCallId, name: message.toolName };
        const previous = live.items.get(`tool:${message.toolCallId}`);
        this.publish(live, toolItem(call, message, previous?.tool?.durationMs));
      } else {
        if (message.role === "assistant") for (const call of message.content ?? []) if (call.type === "toolCall") live.tools.set(call.id, call);
        for (const item of mapMessage(message, id)) this.publish(live, { ...item, streaming: false });
      }
      live.message = null;
    }
    if (event.type.startsWith("tool_execution_")) {
      const call = live.tools.get(event.toolCallId) ?? { id: event.toolCallId, name: event.toolName, arguments: event.args ?? {} };
      if (event.args) call.arguments = event.args;
      live.tools.set(call.id, call);
      if (event.type === "tool_execution_start") { live.started.set(call.id, Date.now()); this.publish(live, toolItem(call)); }
      if (event.type === "tool_execution_update") {
        const item = toolItem(call, event.partialResult); item.tool!.status = "running"; this.publish(live, item);
      }
      if (event.type === "tool_execution_end") {
        const duration = event.durationMs ?? (live.started.has(call.id) ? Date.now() - live.started.get(call.id)! : undefined);
        this.publish(live, toolItem(call, { ...event.result, isError: !!event.isError }, duration)); live.started.delete(call.id);
      }
    }
    if (event.type === "extension_error") this.hub.notice("error", String(event.error), key(live.id));
    if (event.type === "session_info_changed") this.hub.sessionsChanged();
  }

  private clearDialog(id: string): void {
    const dialog = this.dialogs.get(id); if (!dialog) return;
    clearTimeout(dialog.timer); this.dialogs.delete(id); this.hub.resolveApproval(id);
  }

  private cancelDialogs(live: Live, respond: boolean): void {
    for (const [id, dialog] of this.dialogs) if (dialog.live === live) {
      if (respond) void live.rpc.write({ type: "extension_ui_response", id: dialog.request.id, cancelled: true }).catch(() => {});
      this.clearDialog(id);
    }
  }

  private dialog(live: Live, request: Json): void {
    const method = request.method;
    if (!["confirm", "select", "input", "editor"].includes(method)) {
      if (method === "notify") this.hub.notice(request.notifyType === "error" ? "error" : "info", String(request.message ?? ""), key(live.id));
      return;
    }
    const id = `${key(live.id)}:ui:${request.id}`;
    this.clearDialog(id);
    const dialog: Dialog = { live, request };
    if (typeof request.timeout === "number" && request.timeout >= 0) {
      dialog.timer = setTimeout(() => {
        void live.rpc.write({ type: "extension_ui_response", id: request.id, cancelled: true }).catch(() => {});
        this.clearDialog(id);
      }, Math.min(request.timeout, 2_147_483_647));
    }
    this.dialogs.set(id, dialog);
    this.hub.addApproval({
      id, sessionId: key(live.id), agent: this.agent, title: request.title ?? "Pi 扩展交互", detail: request.message ?? request.placeholder ?? request.prefill ?? "", createdAt: Date.now(),
      choices: method === "confirm" ? [{ id: "yes", label: "确认", tone: "primary" }, { id: "no", label: "拒绝" }, { id: "cancel", label: "取消" }] : [{ id: "submit", label: "提交", tone: "primary" }, { id: "cancel", label: "取消" }],
      ...(method !== "confirm" ? { questions: [{ id: "value", header: request.title ?? "输入", question: request.title ?? "输入", options: method === "select" ? (request.options ?? []).map((label: string) => ({ label })) : [], allowOther: method !== "select" }] } : {}),
    });
  }

  async resolve(approvalId: string, answer: ApprovalAnswer): Promise<void> {
    const dialog = this.dialogs.get(approvalId);
    if (!dialog) throw invalidConfig("Pi 扩展交互已失效");
    const response: Json = { type: "extension_ui_response", id: dialog.request.id };
    if (answer.choice === "cancel") response.cancelled = true;
    else if (dialog.request.method === "confirm") {
      if (!["yes", "no"].includes(answer.choice)) throw invalidConfig("无效确认选项");
      response.confirmed = answer.choice === "yes";
    } else {
      const values = answer.answers?.value ?? answer.answers?.["0"];
      if (answer.choice !== "submit" || !values || values.length !== 1 || typeof values[0] !== "string") throw invalidConfig("请输入或选择一个值");
      if (dialog.request.method === "select" && !dialog.request.options?.includes(values[0])) throw invalidConfig("无效选择");
      response.value = values[0];
    }
    await dialog.live.rpc.write(response); this.clearDialog(approvalId);
  }

  private async idle(live: Live): Promise<void> {
    if (live.busy) throw busy();
    const state = await live.rpc.request("get_state");
    if (state.isStreaming || state.isCompacting || state.pendingMessageCount > 0) throw busy();
  }

  async send(nativeId: string, prompt: string): Promise<void> {
    const live = await this.ensure(nativeId);
    if (live.locked || live.busy) throw busy();
    live.locked = true;
    try {
      await this.idle(live); live.busy = true; this.hub.status(key(live.id), "running");
      const response = await live.rpc.request("prompt", { message: prompt });
      if (response.disposition === "handled" && !live.message) {
        const state = await live.rpc.request("get_state");
        if (!state.isStreaming && !state.isCompacting && !state.pendingMessageCount) { live.busy = false; this.hub.status(key(live.id), "idle"); }
      }
    } catch (error) { live.busy = false; this.hub.status(key(live.id), "idle"); throw error; }
    finally { live.locked = false; }
  }

  async create(cwd: string, prompt: string, patch?: SessionConfigPatch): Promise<string> {
    cwd = expand(cwd);
    const info = await stat(cwd); if (!info.isDirectory()) throw invalidConfig("工作目录不存在");
    const storage = this.sessionRoot === join(this.agentDir, "sessions") ? join(this.sessionRoot, `--${cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`) : this.sessionRoot;
    const rpc = this.launch(cwd, ["--session-dir", storage]);
    let live: Live | undefined;
    try {
      const state = await rpc.request("get_state");
      const data = await rpc.request("get_entries");
      live = this.attach(rpc, state, cwd, data.entries ?? []);
      if (patch) await this.configure(live.id, patch);
      await this.send(live.id, prompt); this.hub.sessionsChanged();
      return live.id;
    } catch (error) {
      if (live) { this.cancelDialogs(live, true); this.live.delete(live.id); this.hub.status(key(live.id), "idle"); }
      await rpc.close(); throw error;
    }
  }

  private async config(rpc: Rpc): Promise<SessionConfig> {
    const [state, available, thinking] = await Promise.all([rpc.request("get_state"), rpc.request("get_available_models"), rpc.request("get_available_thinking_levels")]);
    const current = state.model ? modelKey(state.model) : null;
    return {
      model: current, thinking: state.thinkingLevel ?? null, permissionMode: null, permissionModes: [], notice: NOTICE,
      models: (available.models ?? []).map((model: Json) => ({ value: modelKey(model), label: `${model.provider} · ${model.name ?? model.id}`, contextWindow: model.contextWindow,
        // Only the current model's supported levels are authoritative. Query again after set_model.
        thinkingLevels: modelKey(model) === current ? (thinking.levels ?? []).map((value: string) => ({ value, label: value })) : [],
      })),
      context: { usedTokens: null, windowTokens: state.model?.contextWindow ?? null, source: "Pi get_state（未提供当前上下文 token 数）" },
    };
  }

  async configuration(nativeId: string | null): Promise<SessionConfig> {
    if (nativeId !== null) return this.config((await this.ensure(nativeId)).rpc);
    const rpc = this.launch(homedir(), [], true);
    try { return await this.config(rpc); } finally { await rpc.close(); }
  }

  async configure(nativeId: string, patch: SessionConfigPatch): Promise<SessionConfig> {
    const live = await this.ensure(nativeId);
    if (live.locked || live.busy) throw busy();
    live.locked = true;
    try {
      await this.idle(live);
      if (patch.permissionMode != null) throw invalidConfig("原生 Pi 不支持权限模式；内置工具没有逐次审批");
      let config = await this.config(live.rpc);
      if (patch.model != null) {
        if (!config.models.some((model) => model.value === patch.model)) throw invalidConfig("模型不可用");
        const [provider, modelId] = JSON.parse(patch.model);
        await live.rpc.request("set_model", { provider, modelId });
        config = await this.config(live.rpc);
      }
      if (patch.thinking != null) {
        const model = config.models.find((model) => model.value === config.model);
        if (!model?.thinkingLevels.some((level) => level.value === patch.thinking)) throw invalidConfig("该模型不支持此思考程度");
        await live.rpc.request("set_thinking_level", { level: patch.thinking });
        config = await this.config(live.rpc);
      }
      return config;
    } finally { live.locked = false; }
  }

  /** Native set_session_name appends a session_info entry to the session file. */
  async rename(nativeId: string, title: string): Promise<void> {
    const live = await this.ensure(nativeId);
    if (live.locked || live.busy) throw busy();
    live.locked = true;
    try {
      await this.idle(live);
      await live.rpc.request("set_session_name", { name: title });
    } finally { live.locked = false; }
    this.hub.sessionsChanged();
  }

  /** Close any RPC process for the session, then move its file to the relay trash. */
  async remove(nativeId: string): Promise<void> {
    const live = this.live.get(nativeId);
    if (live && (live.locked || live.busy)) throw busy();
    const file = await this.file(nativeId);
    if (live) {
      this.cancelDialogs(live, true);
      this.live.delete(nativeId);
      await live.rpc.close();
    }
    moveToTrash(file.path, this.agent);
    this.files.delete(nativeId);
    this.hub.forget(key(nativeId));
  }

  async interrupt(nativeId: string): Promise<void> {
    const live = this.live.get(nativeId);
    if (!live) return;
    this.cancelDialogs(live, true);
    // abort returns when accepted; only agent_settled proves the run finished.
    await live.rpc.request("abort");
    const state = await live.rpc.request("get_state");
    if (!state.isStreaming && !state.isCompacting && !state.pendingMessageCount) { live.busy = false; this.hub.status(key(live.id), "idle"); }
  }
}
