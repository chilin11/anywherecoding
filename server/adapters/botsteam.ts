import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { Hub, sessionKey, type Adapter } from "../hub.ts";
import type { AgentAvailability, Approval, ApprovalAnswer, History, Item, SessionSummary, SessionTarget } from "../types.ts";
import { invalidConfig, validateConfigPatch, type SessionConfig, type SessionConfigPatch } from "../session-config.ts";
import { BotsTeamApi, BotsTeamError, StreamLimitError, type BotsTeamOptions } from "./botsteam-api.ts";
import { BotsTeamProjection, json, terminal, text, timestamp, type Row, type Scope } from "./botsteam-projection.ts";

type Ref = { kind: "conversation"; project: string; conversation: string } | { kind: "bot"; bot: string };
type Pending = { project: string; kind: "permission" | "question"; row: Row; session: string };
type State = {
  project: string; directoryless: boolean; projection: BotsTeamProjection; permissions: Row[]; questions: Row[];
  until: number; controller: AbortController; streaming: boolean; blocked: boolean;
  ready: Promise<void>; readyDone: boolean; synced: boolean; resolve: () => void; reject: (error: Error) => void;
  refresh: Promise<void> | null; sent: Map<string, string>; publishTimer?: NodeJS.Timeout;
};
// Upstream SSH projects keep root_path empty and expose their directory in workspace.
// This is display metadata only: operations must retain the opaque project/conversation IDs.
function sshRoot(project: Row): string {
  const workspace = project.workspace;
  if (!workspace || typeof workspace !== "object" || Array.isArray(workspace)) return "";
  return workspace.kind === "ssh" && text(workspace, "authority_id") ? text(workspace, "canonical_root") : "";
}
const encode = (ref: Ref): string => Buffer.from(JSON.stringify(ref)).toString("base64url");
export function botsTeamRef(nativeId: string): Ref {
  if (!/^[A-Za-z0-9_-]{1,4096}$/.test(nativeId)) throw invalidConfig("无效的 BotsTeam 会话");
  const ref = json(Buffer.from(nativeId, "base64url").toString());
  const valid = (key: string) => typeof ref[key] === "string" && ref[key].length > 0 && ref[key].length <= 1024 && !/[\r\n\0]/.test(ref[key]);
  if (ref.kind === "bot" && valid("bot") && Object.keys(ref).length === 2) return ref as Ref;
  if (ref.kind === "conversation" && valid("project") && valid("conversation") && Object.keys(ref).length === 3) return ref as Ref;
  throw invalidConfig("无效的 BotsTeam 会话");
}
async function parallel<T, R>(values: T[], operation: (value: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(values.length); let index = 0;
  await Promise.all(Array.from({ length: Math.min(4, values.length) }, async () => { while (index < values.length) { const current = index++; results[current] = await operation(values[current]!); } }));
  return results;
}

/** Controls an existing workbench. stop() only disconnects; it never owns the engine. */
export class BotsTeamAdapter implements Adapter {
  readonly agent = "botsteam" as const;
  readonly capabilities = { externalExecution: true, directorySource: "backend" as const };
  private api: BotsTeamApi;
  private readonly options: BotsTeamOptions;
  private readonly hub: Hub;
  private readonly preferencesFile?: string;
  private preferences: Record<string, string> = {};
  private projects = new Map<string, Row>();
  private employees = new Map<string, Row>();
  private conversations = new Map<string, Row>();
  private directProjects = new Map<string, string>();
  private directRequests = new Map<string, Promise<string>>();
  private states = new Map<string, State>();
  private scopes = new Map<string, Scope>();
  private pending = new Map<string, Pending>();
  private resolved = new Map<string, string>();
  private sending = new Set<string>();
  private started = false;
  private generation = 0;
  private catalogAt = 0;
  private catalog: Promise<void> | null = null;
  private failure = "尚未连接";
  private timer?: NodeJS.Timeout;
  constructor(hub: Hub, options: BotsTeamOptions = {}, preferencesFile?: string) {
    this.hub = hub; this.options = options; this.api = new BotsTeamApi(options); this.preferencesFile = preferencesFile;
    if (preferencesFile && existsSync(preferencesFile)) {
      const data = JSON.parse(readFileSync(preferencesFile, "utf8"));
      if (!data || typeof data !== "object" || Array.isArray(data) || Object.keys(data).length > 5000 || Object.values(data).some((value) => typeof value !== "string")) throw invalidConfig("BotsTeam 会话目标配置无效");
      this.preferences = data;
    }
  }
  async start(): Promise<void> {
    if (this.started) return;
    this.api = new BotsTeamApi(this.options); this.started = true; this.generation++;
    try { await this.refreshCatalog(true); this.failure = ""; }
    catch (error) { await this.stop(); this.failure = this.message(error); throw error; }
    this.timer = setInterval(() => { void this.poll(); }, 2500); this.timer.unref();
  }
  async stop(): Promise<void> {
    this.started = false; this.generation++; clearInterval(this.timer); this.api.close();
    for (const state of this.states.values()) { state.controller.abort(); clearTimeout(state.publishTimer); if (!state.readyDone) { state.readyDone = true; state.reject(new BotsTeamError("BotsTeam 连接已断开", 503)); } }
    this.states.clear(); this.scopes.clear(); this.pending.clear(); this.resolved.clear(); this.sending.clear();
  }
  availability(): AgentAvailability { return { agent: this.agent, ok: this.started && !this.failure, ...(this.failure ? { reason: this.failure } : {}) }; }
  private message(error: unknown): string { return error instanceof BotsTeamError ? error.message : "BotsTeam 数据同步失败，请检查连接后刷新"; }
  private check(): void { if (!this.started) throw new BotsTeamError("请先连接 BotsTeam", 503); }
  private async refreshCatalog(force = false): Promise<void> {
    this.check(); if (!force && this.catalogAt > Date.now() - 15_000) return;
    if (this.catalog) return this.catalog;
    const generation = this.generation;
    const pending = (async () => {
      const [projects, employees] = await Promise.all([this.api.array("/api/projects"), this.api.array("/api/employees")]);
      if (!this.started || generation !== this.generation) throw new BotsTeamError("BotsTeam 连接已更换", 503);
      this.projects = new Map(projects.filter((p) => text(p, "id") && (text(p, "root_path") || sshRoot(p))).map((p) => [text(p, "id"), p]));
      this.employees = new Map(employees.filter((e) => text(e, "id")).map((e) => [text(e, "id"), e])); this.catalogAt = Date.now(); this.failure = "";
    })();
    this.catalog = pending;
    try { await pending; } finally { if (this.catalog === pending) this.catalog = null; }
  }
  private targets(): SessionTarget[] {
    return [{ id: "team", kind: "team", label: "Team · 项目团队", description: "使用该项目配置的 Leader 和成员", directory: "required" }, ...[...this.employees.values()].map((employee): SessionTarget => ({ id: `bot:${text(employee, "id")}`, kind: "bot", label: text(employee, "name") || text(employee, "id"), description: text(employee, "role"), directory: "optional" }))];
  }
  private preferenceKey(nativeId: string): string { return `${this.api.origin}\n${nativeId}`; }
  private select(nativeId: string, ref: Ref): SessionTarget | undefined {
    if (ref.kind === "bot") return this.targets().find((t) => t.id === `bot:${ref.bot}`);
    const project = this.projects.get(ref.project);
    const selected = this.preferences[this.preferenceKey(nativeId)] ?? (project?.mode === "direct" ? `bot:${text(project, "default_employee_id")}` : "team");
    return this.targets().find((target) => target.id === selected);
  }
  private saveTarget(nativeId: string, targetId: string | null): void {
    const next = { ...this.preferences }, key = this.preferenceKey(nativeId);
    if (targetId === null) delete next[key]; else next[key] = targetId;
    if (Object.keys(next).length > 5000) throw invalidConfig("保存的会话目标过多，请清理旧配置");
    if (this.preferencesFile) {
      mkdirSync(dirname(this.preferencesFile), { recursive: true, mode: 0o700 });
      const temp = this.preferencesFile + `.${randomUUID()}.tmp`;
      writeFileSync(temp, JSON.stringify(next, null, 2) + "\n", { mode: 0o600 }); renameSync(temp, this.preferencesFile);
    }
    this.preferences = next;
  }
  async configuration(nativeId: string | null): Promise<SessionConfig> {
    await this.refreshCatalog(Boolean(this.failure));
    const ref = nativeId ? botsTeamRef(nativeId) : null;
    const selected = ref ? this.select(nativeId!, ref) : this.targets()[0];
    return { model: null, thinking: null, permissionMode: null, models: [], permissionModes: [],
      targets: ref?.kind === "bot" ? this.targets().filter((target) => target.id === `bot:${ref.bot}`) : this.targets(), targetId: selected?.id ?? null,
      // The path-only creation API cannot distinguish SSH authorities; do not offer their roots here.
      directory: { source: "backend", projects: [...this.projects.values()].filter((p) => text(p, "root_path")).map((p) => ({ path: text(p, "root_path"), label: text(p, "name") })) },
      notice: "Team/Bot 是会话目标，不是模型。模型、思考和长期权限沿用 BotsTeam；断开本连接不会停止工作台任务。" };
  }
  async configure(nativeId: string, patch: SessionConfigPatch): Promise<SessionConfig> {
    const config = await this.configuration(nativeId); validateConfigPatch(patch, config);
    if (patch.model != null || patch.thinking != null || patch.permissionMode != null) throw invalidConfig("请在 BotsTeam 设置模型、思考和长期权限");
    const ref = botsTeamRef(nativeId);
    if (ref.kind === "bot" && patch.targetId != null && patch.targetId !== `bot:${ref.bot}`) throw invalidConfig("无目录会话固定绑定当前 Bot");
    if (patch.targetId !== undefined && ref.kind === "conversation") this.saveTarget(nativeId, patch.targetId);
    this.hub.sessionsChanged(); return this.configuration(nativeId);
  }
  async listSessions(): Promise<SessionSummary[]> {
    await this.refreshCatalog(); const generation = this.generation;
    const lists = await parallel([...this.projects.values()], async (project) => ({ project, rows: await this.api.array(`/api/conversations?project_id=${encodeURIComponent(text(project, "id"))}`) }));
    if (!this.started || generation !== this.generation) return [];
    const result: SessionSummary[] = []; const found = new Map<string, Row>();
    for (const { project, rows } of lists) for (const row of rows) {
      if (row.archived || !text(row, "id")) continue;
      const ref: Ref = { kind: "conversation", project: text(project, "id"), conversation: text(row, "id") }, nativeId = encode(ref), key = sessionKey(this.agent, nativeId);
      found.set(nativeId, row);
      const live = this.states.get(ref.project)?.until ?? 0;
      const remote = !text(project, "root_path") && Boolean(sshRoot(project));
      result.push({ id: key, agent: this.agent, nativeId, title: text(row, "title") || "BotsTeam 对话", cwd: text(project, "root_path") || sshRoot(project) || null, ...(remote ? { projectKey: `botsteam:ssh:${ref.project}`, projectLabel: `SSH · ${text(project, "name") || sshRoot(project)}`, createInProject: false } : {}), updatedAt: timestamp(row.updated_at), status: (live > Date.now() ? this.hub.liveStatus(key) : undefined) ?? (row.active_count > 0 ? "running" : "idle"), target: this.select(nativeId, ref), actions: { rename: true, remove: true } });
    }
    this.conversations = found;
    for (const employee of this.employees.values()) {
      const ref: Ref = { kind: "bot", bot: text(employee, "id") }, nativeId = encode(ref), key = sessionKey(this.agent, nativeId);
      const state = this.states.get(this.directProjects.get(ref.bot) ?? "");
      const latest = state ? [...state.projection.tasks.values()].filter((task) => text(task, "channel") === "direct" && text(task, "assigned_employee_id") === ref.bot).reduce((latest, task) => Math.max(latest, timestamp(task.updated_at)), 0) : 0;
      result.push({ id: key, agent: this.agent, nativeId, title: `${text(employee, "name") || ref.bot} · Bot 会话`, cwd: null, updatedAt: latest, status: state && state.until > Date.now() ? this.hub.liveStatus(key) ?? "unknown" : "unknown", target: this.select(nativeId, ref), actions: { rename: false, remove: false } });
    }
    return result;
  }
  private async scope(ref: Ref): Promise<Scope> {
    await this.refreshCatalog();
    if (ref.kind === "conversation") {
      if (!this.projects.has(ref.project)) throw invalidConfig("BotsTeam 项目不存在");
      return { project: ref.project, conversation: ref.conversation };
    }
    if (!this.employees.has(ref.bot)) throw invalidConfig("BotsTeam Bot 不存在");
    let project = this.directProjects.get(ref.bot);
    if (!project) {
      let request = this.directRequests.get(ref.bot);
      if (!request) {
        request = this.api.request("/api/direct", { employee_id: ref.bot }).then((value) => { if (!text(value, "id")) throw new BotsTeamError("BotsTeam 未返回 Bot 会话"); this.directProjects.set(ref.bot, value.id); return value.id as string; });
        this.directRequests.set(ref.bot, request);
      }
      try { project = await request; } finally { if (this.directRequests.get(ref.bot) === request) this.directRequests.delete(ref.bot); }
    }
    return { project, bot: ref.bot };
  }
  private async stateFor(nativeId: string): Promise<State> {
    this.check(); const generation = this.generation, scope = await this.scope(botsTeamRef(nativeId));
    if (!this.started || generation !== this.generation) throw new BotsTeamError("BotsTeam 连接已更换", 503);
    if (!this.scopes.has(nativeId) && this.scopes.size >= 200) throw new BotsTeamError("查看的会话过多，请重新连接后继续", 429);
    this.scopes.set(nativeId, scope);
    let state = this.states.get(scope.project);
    if (!state) {
      if (this.states.size >= 20) {
        const evict = [...this.states.values()].find((entry) => entry.until < Date.now());
        if (!evict) throw new BotsTeamError("同时查看的 BotsTeam 项目过多，请稍后重试", 429);
        evict.controller.abort(); clearTimeout(evict.publishTimer); this.states.delete(evict.project);
        for (const [id, cached] of this.scopes) if (cached.project === evict.project) this.scopes.delete(id);
      }
      let resolve!: () => void, reject!: (error: Error) => void;
      const ready = new Promise<void>((yes, no) => { resolve = yes; reject = no; }); ready.catch(() => undefined);
      state = { project: scope.project, directoryless: Boolean(scope.bot), projection: new BotsTeamProjection(), permissions: [], questions: [], until: Date.now() + 120_000, controller: new AbortController(), streaming: false, blocked: false, ready, readyDone: false, synced: false, resolve, reject, refresh: null, sent: new Map() };
      this.states.set(scope.project, state);
    }
    state.until = Date.now() + 120_000;
    try { await this.refreshState(state); this.openStream(state); }
    catch (error) { if (!state.readyDone) { state.readyDone = true; state.reject(new BotsTeamError(this.message(error))); } throw error; }
    return state;
  }
  watch(nativeId: string): void { void this.stateFor(nativeId).catch((error) => { if (this.started) this.hub.notice("error", this.message(error), sessionKey(this.agent, nativeId)); }); }
  private async refreshState(state: State): Promise<void> {
    if (state.refresh) return state.refresh;
    const generation = this.generation;
    const request = (async () => {
      const query = `?project_id=${encodeURIComponent(state.project)}`;
      const [tasks, permissions, questions] = await Promise.all([this.api.array("/api/tasks" + query), state.directoryless ? Promise.resolve([]) : this.api.array("/api/permissions" + query), this.api.array("/api/questions" + query)]);
      if (!this.started || generation !== this.generation || state.controller.signal.aborted) return;
      state.projection.setTasks(tasks.filter((task) => text(task, "project_id") === state.project)); state.permissions = permissions; state.questions = questions; this.publish(state); this.failure = "";
    })();
    state.refresh = request;
    try { await request; } finally { if (state.refresh === request) state.refresh = null; }
  }
  private openStream(state: State): void {
    if (!this.started || state.controller.signal.aborted || state.streaming || state.blocked || state.until < Date.now()) return;
    state.streaming = true; const generation = this.generation;
    void this.api.stream(state.project, state.projection.cursor, state.controller.signal, (_id, kind, raw) => {
      if (!this.started || generation !== this.generation || state.controller.signal.aborted) return;
      if (kind === "stream_ready") { state.synced = true; if (!state.readyDone) { state.readyDone = true; state.resolve(); } state.ready = Promise.resolve(); this.publish(state); return; }
      state.projection.event(json(raw));
      if (!state.publishTimer) state.publishTimer = setTimeout(() => { state.publishTimer = undefined; if (this.started && !state.controller.signal.aborted) this.publish(state); }, 80);
    }).catch((error) => {
      if (!this.started || generation !== this.generation || state.controller.signal.aborted) return;
      if (error instanceof StreamLimitError) state.blocked = true;
      if (!state.readyDone) { state.readyDone = true; state.reject(new BotsTeamError(this.message(error))); }
      for (const [id, scope] of this.scopes) if (scope.project === state.project) this.hub.notice("error", this.message(error), sessionKey(this.agent, id));
    }).finally(() => { if (generation === this.generation) state.streaming = false; });
  }
  private async poll(): Promise<void> {
    if (!this.started) return;
    await parallel([...this.states.values()].filter((state) => state.until >= Date.now()), async (state) => {
      try { await this.refreshState(state); this.openStream(state); }
      catch (error) { if (this.started) { this.failure = this.message(error); for (const [id, scope] of this.scopes) if (scope.project === state.project) this.hub.status(sessionKey(this.agent, id), "unknown"); } }
    });
    for (const state of this.states.values()) if (state.until < Date.now() && state.streaming) { state.controller.abort(); clearTimeout(state.publishTimer); this.states.delete(state.project); }
  }
  private publish(state: State): void {
    if (!this.started || state.controller.signal.aborted) return;
    for (const [id, scope] of this.scopes) {
      if (scope.project !== state.project) continue;
      const key = sessionKey(this.agent, id);
      if (state.synced) {
        const items = state.projection.items(scope, this.employees), wanted = new Set(items.map((item) => `${id}:${item.id}`));
        for (const previous of state.sent.keys()) if (previous.startsWith(id + ":") && !wanted.has(previous)) { state.sent.delete(previous); this.hub.removeItem(key, previous.slice(id.length + 1)); }
        for (const item of items) {
          const signature = JSON.stringify(item), previous = state.sent.get(`${id}:${item.id}`);
          if (signature === previous) continue;
          state.sent.set(`${id}:${item.id}`, signature); this.hub.item(key, item);
        }
      }
      this.hub.status(key, state.projection.active(scope).length ? "running" : "idle");
    }
    this.syncApprovals(state);
  }
  private approvalSession(state: State, row: Row): string | null {
    const task = state.projection.tasks.get(text(row, "task_id"));
    if (!task || terminal(text(task, "status")) || text(row, "run_id") !== text(task, "run_id")) return null;
    const root = state.projection.tasks.get(state.projection.root(text(task, "id"))); if (!root) return null;
    const ref: Ref = text(root, "channel") === "direct" ? { kind: "bot", bot: text(root, "assigned_employee_id") } : { kind: "conversation", project: state.project, conversation: text(root, "conversation_id") };
    return sessionKey(this.agent, encode(ref));
  }
  private syncApprovals(state: State): void {
    const seen = new Set<string>();
    for (const kind of ["permission", "question"] as const) for (const row of kind === "permission" ? state.permissions : state.questions) {
      if (text(row, "status") !== "pending" || !text(row, "id")) continue;
      const id = `botsteam:${kind}:${text(row, "id")}`, session = this.approvalSession(state, row); seen.add(id);
      if (!session || this.resolved.has(id)) continue;
      const approval: Approval = { id, agent: this.agent, sessionId: session, title: kind === "permission" ? `${text(row, "capability")} · ${text(row, "employee_id")}` : "Bot 提问", detail: kind === "permission" ? [text(row, "reason"), text(row, "resource")].filter(Boolean).join("\n") : text(row, "question"), createdAt: timestamp(row.created_at) || Date.now(),
        choices: kind === "permission" ? [{ id: "once", label: "允许一次", tone: "primary" }, { id: "project", label: "允许此项目" }, { id: "deny", label: "拒绝", tone: "danger" }] : [{ id: "submit", label: "提交答案", tone: "primary" }, { id: "cancel", label: "取消", tone: "danger" }],
        ...(kind === "question" ? { questions: [{ id: text(row, "id"), header: "", question: text(row, "question"), options: Array.isArray(row.options) ? row.options.map((option: Row) => ({ label: text(option, "label"), description: text(option, "description") })) : [], allowOther: true }] } : {}) };
      const old = this.pending.get(id);
      if (!old || JSON.stringify(old.row) !== JSON.stringify(row)) this.hub.addApproval(approval);
      this.pending.set(id, { project: state.project, kind, row, session });
    }
    for (const [id, entry] of this.pending) if (entry.project === state.project && (!seen.has(id) || !this.approvalSession(state, entry.row))) { this.pending.delete(id); this.hub.resolveApproval(id); }
    for (const [id, project] of this.resolved) if (project === state.project && !seen.has(id)) this.resolved.delete(id);
  }
  async history(nativeId: string, before: string | null): Promise<History> {
    const state = await this.stateFor(nativeId);
    let timeout: NodeJS.Timeout | undefined;
    try { await Promise.race([state.ready, new Promise<never>((_yes, no) => { timeout = setTimeout(() => no(new BotsTeamError("BotsTeam 历史仍在同步，请稍后重试", 504)), 20_000); })]); }
    finally { clearTimeout(timeout); }
    const items = state.projection.items(this.scopes.get(nativeId)!, this.employees);
    const end = before ? items.findIndex((item) => item.id === before) : items.length;
    if (end < 0) throw new BotsTeamError("历史分页已变化，请刷新当前会话", 409);
    const start = Math.max(0, end - 100), page = items.slice(start, end);
    return { items: page, before: start > 0 ? page[0]!.id : null };
  }
  async send(nativeId: string, message: string): Promise<void> {
    if (this.sending.has(nativeId)) throw new BotsTeamError("该会话的上一条发送尚未确认，请勿重复发送", 409);
    if (!message.trim()) throw invalidConfig("消息不能为空");
    if (/^\/compact(?:\s|$)/.test(message)) throw invalidConfig("请在 BotsTeam 工作台执行 /compact，不会将它作为普通消息发送");
    this.sending.add(nativeId);
    try {
      const config = await this.configuration(nativeId), target = config.targets?.find((entry) => entry.id === config.targetId);
      if (!target) throw invalidConfig("请选择有效的 Team 或 Bot 目标");
      const ref = botsTeamRef(nativeId), state = await this.stateFor(nativeId), scope = this.scopes.get(nativeId)!;
      const project = this.projects.get(scope.project);
      const employee = target.kind === "team" ? text(project, "leader_employee_id") : target.id.slice(4);
      if (!this.employees.has(employee)) throw invalidConfig("项目 Leader 或所选 Bot 已不存在，请在 BotsTeam 配置后刷新");
      const payload: Row = { project_id: scope.project, channel: ref.kind === "bot" ? "direct" : "project", mode: target.kind === "team" ? "leader" : "direct", assigned_employee_id: employee, title: message.slice(0, 60), description: message };
      if (ref.kind === "conversation") payload.conversation_id = ref.conversation;
      const task = await this.api.request("/api/tasks", payload);
      if (text(task, "id")) state.projection.tasks.set(task.id, task);
      this.publish(state); this.hub.sessionsChanged();
    } catch (error) {
      const state = this.states.get(this.scopes.get(nativeId)?.project ?? ""); if (state) void this.refreshState(state).catch(() => undefined);
      if (error instanceof BotsTeamError) throw new BotsTeamError(error.message + "；未自动重发，请先核对工作台状态", error.status);
      throw error;
    } finally { this.sending.delete(nativeId); }
  }
  async create(cwd: string, message: string, patch: SessionConfigPatch = {}): Promise<string> {
    if (/^\/compact(?:\s|$)/.test(message)) throw invalidConfig("请在 BotsTeam 工作台执行 /compact");
    const config = await this.configuration(null); validateConfigPatch(patch, config);
    if (patch.model != null || patch.thinking != null || patch.permissionMode != null) throw invalidConfig("请在 BotsTeam 配置模型、思考和长期权限");
    const target = config.targets!.find((entry) => entry.id === (patch.targetId ?? config.targetId));
    if (!target) throw invalidConfig("请选择 Team 或 Bot");
    if (!message.trim()) throw invalidConfig("消息不能为空");
    if (!cwd.trim()) {
      if (target.kind !== "bot") throw invalidConfig("Team 会话需要项目目录");
      const nativeId = encode({ kind: "bot", bot: target.id.slice(4) }); await this.send(nativeId, message); return nativeId;
    }
    if (cwd.length > 4096 || /[\r\n\0]/.test(cwd) || !(/^[A-Za-z]:[\\/]/.test(cwd) || cwd.startsWith("/"))) throw invalidConfig("请填写 BotsTeam 电脑上的绝对目录");
    let project = [...this.projects.values()].find((p) => text(p, "root_path") === cwd);
    if (!project) {
      const leader = [...this.projects.values()].filter((p) => text(p, "root_path")).map((p) => text(p, "leader_employee_id")).find((id) => this.employees.has(id)) || (this.employees.has("bot_leader") ? "bot_leader" : "");
      if (target.kind === "team" && !leader) throw invalidConfig("请先在 BotsTeam 配置项目 Leader，或选择 Bot 会话");
      const created = json(await this.api.request("/api/projects", { root_path: cwd, mode: target.kind === "team" ? "leader" : "direct", leader_employee_id: leader || target.id.slice(4), default_employee_id: target.kind === "bot" ? target.id.slice(4) : leader }));
      if (!text(created, "id")) throw new BotsTeamError("BotsTeam 未返回新项目"); this.projects.set(created.id, created); project = created;
    }
    const conversation = await this.api.request("/api/conversations", { project_id: text(project, "id") });
    if (!text(conversation, "id")) throw new BotsTeamError("BotsTeam 未返回新对话");
    const nativeId = encode({ kind: "conversation", project: text(project, "id"), conversation: conversation.id });
    this.saveTarget(nativeId, target.id); this.hub.sessionsChanged();
    await this.send(nativeId, message); return nativeId;
  }
  async interrupt(nativeId: string): Promise<void> {
    const ref = botsTeamRef(nativeId), state = await this.stateFor(nativeId), scope = this.scopes.get(nativeId)!;
    if (ref.kind === "conversation") await this.api.request("/api/team/stop", { project_id: ref.project, conversation_id: ref.conversation });
    else for (const task of state.projection.active(scope)) await this.api.request(`/api/tasks/${encodeURIComponent(text(task, "id"))}/cancel`, { expected_run_id: text(task, "run_id"), reason: "Stopped from AnywhereCoding" });
    await this.refreshState(state);
  }
  async rename(nativeId: string, title: string): Promise<void> {
    const ref = botsTeamRef(nativeId); this.check();
    if (ref.kind !== "conversation") throw invalidConfig("无目录 Bot 会话名称来自 Bot 配置，不能单独重命名");
    await this.api.request(`/api/conversations/${encodeURIComponent(ref.conversation)}`, { project_id: ref.project, title }); this.hub.sessionsChanged();
  }
  async remove(nativeId: string): Promise<void> {
    const ref = botsTeamRef(nativeId); this.check();
    if (ref.kind !== "conversation") throw invalidConfig("无目录 Bot 历史不支持归档；可在 BotsTeam 归入项目后管理");
    await this.api.request(`/api/conversations/${encodeURIComponent(ref.conversation)}`, { project_id: ref.project, archived: true });
    this.scopes.delete(nativeId); this.hub.forget(sessionKey(this.agent, nativeId)); this.hub.sessionsChanged();
  }
  async resolve(id: string, answer: ApprovalAnswer): Promise<void> {
    this.check(); const entry = this.pending.get(id);
    if (!entry) throw new BotsTeamError("BotsTeam 审批已失效", 409);
    const state = this.states.get(entry.project);
    if (!state || !this.approvalSession(state, entry.row)) throw new BotsTeamError("任务或 Run 已变化，请刷新审批", 409);
    const source = text(entry.row, "id"); let path: string, body: Row;
    if (entry.kind === "permission") {
      if (!["once", "project", "deny"].includes(answer.choice)) throw invalidConfig("无效权限选项");
      path = `/api/permissions/${encodeURIComponent(source)}/resolve`; body = { allow: answer.choice !== "deny", scope: answer.choice === "project" ? "project" : "once" };
    } else {
      path = `/api/questions/${encodeURIComponent(source)}/answer`; body = { task_id: text(entry.row, "task_id"), run_id: text(entry.row, "run_id") };
      if (answer.choice === "cancel") body.cancelled = true;
      else {
        if (answer.choice !== "submit" || !answer.answers || Object.keys(answer.answers).length !== 1 || !Array.isArray(answer.answers[source]) || answer.answers[source]!.length !== 1 || !answer.answers[source]![0]?.trim()) throw invalidConfig("请选择一个选项或填写一个自定义答案");
        const value = answer.answers[source]![0]!, matches = (entry.row.options ?? []).map((option: Row, index: number) => ({ option, index })).filter(({ option }: { option: Row }) => text(option, "label") === value);
        if (matches.length > 1) throw invalidConfig("提问包含重复选项，请在 BotsTeam 工作台回答");
        if (matches.length === 1) body.choice_index = matches[0].index; else body.text = value;
      }
    }
    try { await this.api.request(path, body); this.resolved.set(id, entry.project); this.pending.delete(id); this.hub.resolveApproval(id); }
    finally { await this.refreshState(state).catch(() => undefined); }
  }
}
