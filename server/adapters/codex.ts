import { execFile } from "node:child_process";
import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { validateConfigPatch, type SessionConfig, type SessionConfigPatch } from "../session-config.ts";
import type { Adapter, Hub } from "../hub.ts";
import { sessionKey } from "../hub.ts";
import type { AgentAvailability, Approval, ApprovalAnswer, History, Item, SessionSummary, ToolInfo } from "../types.ts";
import { asText, clip, findBin, firstLine, formatArgs, LineRpc } from "../util.ts";
import { diffStats, extractImages } from "../artifacts.ts";
import { errorText } from "../errors.ts";
import { CodexDesktopIpc } from "./codex-ipc.ts";

const TERMINAL_TURN = new Set(["completed", "failed", "interrupted", "cancelled", "canceled"]);
/** How long a send routed to the desktop may take before its turn shows up in the rollout. */
const ROUTED_GRACE_MS = 45_000;

/** A thread written by another process (the desktop app) that we mirror from its rollout. */
type Follow = {
  owner: string | null;
  turnId: string | null;
  running: boolean;
  /** Latest turn id before a routed send, and when it was sent; covers the gap before the new turn is persisted. */
  baseline: { turnId: string | null; at: number } | null;
  seen: Map<string, string>;
  until: number;
  timer: NodeJS.Timeout | null;
  polling: boolean;
  told: boolean;
  /** Rollout file and its last mirrored mtime: an unchanged rollout needs no re-read. */
  path: string | null | undefined;
  mtime: number;
};

function execText(bin: string, args: string[]): Promise<string> {
  return new Promise((resolve) => execFile(bin, args, { timeout: 3000 }, (_error, stdout) => resolve(String(stdout ?? ""))));
}

/** Describe the process holding a thread's writer lock (`lsof` + parent command). */
export async function lockHolder(threadId: string): Promise<{ desktop: boolean; text: string } | null> {
  const lock = join(process.env.CODEX_HOME ?? join(homedir(), ".codex"), "thread-writer-locks", `${threadId}.lock`);
  const pid = (await execText("lsof", ["-t", lock])).split(/\s+/).find((value) => /^\d+$/.test(value) && Number(value) !== process.pid);
  if (!pid) return null;
  const [ppid = "", ...command] = (await execText("ps", ["-o", "ppid=,command=", "-p", pid])).trim().split(/\s+/);
  const parent = /^\d+$/.test(ppid) ? (await execText("ps", ["-o", "command=", "-p", ppid])).trim() : "";
  const desktop = /ChatGPT\.app|Codex\.app/.test(parent) && !/anywherecoding|node_repl/i.test(parent);
  const name = desktop ? "Codex 桌面 App" : command.join(" ").includes("app-server") ? `其他 Codex app-server（父进程：${parent.split("/").pop() || ppid}）` : command[0]?.split("/").pop() ?? "codex";
  return { desktop, text: `${name}，pid ${pid}` };
}

const CODEX_FALLBACKS = ["/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex"];

type Json = Record<string, any>;

type PendingRequest = { rpcId: number | string; method: string; params: Json };

type SavedConfig = { patch: SessionConfigPatch; inherited: Json };
const permissionModes = [
  { value: "read-only", label: "只读", description: "read-only 沙箱；需要时请求审批 (on-request)" },
  { value: "workspace-write", label: "工作区写入", description: "允许工作区写入；网络和沙箱外操作需要审批 (on-request)" },
  { value: "danger-full-access", label: "完全访问", description: "不使用沙箱，也不请求审批 (never)" },
];

function permissionParams(mode: string): Json {
  if (mode === "danger-full-access") return { approvalPolicy: "never", sandboxPolicy: { type: "dangerFullAccess" } };
  return { approvalPolicy: "on-request", sandboxPolicy: mode === "read-only"
    ? { type: "readOnly", networkAccess: false }
    : { type: "workspaceWrite", writableRoots: [], networkAccess: false, excludeTmpdirEnvVar: false, excludeSlashTmp: false } };
}

function permissionMode(approval: unknown, sandbox: Json | undefined): string | null {
  if (approval === "never" && sandbox?.type === "dangerFullAccess") return "danger-full-access";
  if (approval !== "on-request" || sandbox?.networkAccess !== false) return null;
  if (sandbox.type === "readOnly") return "read-only";
  if (sandbox.type === "workspaceWrite" && !sandbox.writableRoots?.length && !sandbox.excludeTmpdirEnvVar && !sandbox.excludeSlashTmp) return "workspace-write";
  return null;
}

function toolStatus(status: string | undefined, exitCode?: number | null): ToolInfo["status"] {
  if (status === "declined" || status === "denied") return "denied";
  if (["failed", "cancelled", "canceled", "interrupted", "error"].includes(status ?? "")) return "error";
  if (exitCode != null && exitCode !== 0) return "error";
  if (["completed", "succeeded", "success"].includes(status ?? "")) return "ok";
  return "running";
}

function toolMetrics(item: Json): Pick<ToolInfo, "exitCode" | "durationMs"> {
  return {
    ...(typeof item.exitCode === "number" ? { exitCode: item.exitCode } : {}),
    ...(typeof item.durationMs === "number" ? { durationMs: item.durationMs } : {}),
  };
}

/** MCP results as their text content instead of a JSON envelope full of escapes. */
function mcpResultText(item: Json): string {
  if (item.error) return typeof item.error?.message === "string" ? item.error.message : asText(item.error);
  const content = item.result?.content;
  if (Array.isArray(content)) {
    const text = content.filter((part: Json) => part?.type === "text" && typeof part.text === "string").map((part: Json) => part.text).join("\n");
    if (text) return text;
    if (item.result.structuredContent != null) return asText(item.result.structuredContent);
    if (content.length && content.every((part: Json) => part?.type === "image")) return "";
  }
  return asText(item.result);
}

/** Map one native Codex ThreadItem, including empty terminal tool results. */
export function mapCodexItem(item: Json, ts?: number): Item | null {
  const base = { id: String(item.id), ...(ts != null ? { ts } : {}) };
  const toolItem = (tool: ToolInfo, artifacts?: unknown): Item => {
    const images = extractImages(artifacts);
    return { ...base, kind: "tool", text: "", tool: { ...toolMetrics(item), ...tool }, ...(images.length ? { images } : {}) };
  };
  switch (item.type) {
    case "userMessage": {
      const parts = (item.content ?? []).map((part: Json) => {
        if (part.type === "text") return part.text;
        if (part.type === "mention" || part.type === "skill") return `@${part.name}`;
        return "";
      });
      const images = extractImages(item.content);
      return { ...base, kind: "user", text: parts.filter(Boolean).join("\n"), ...(images.length ? { images } : {}) };
    }
    case "agentMessage":
      return { ...base, kind: "assistant", text: item.text ?? "", ...(item.content ? { images: extractImages(item.content) } : {}) };
    case "reasoning": {
      const text = [...(item.summary ?? []), ...(item.summary?.length ? [] : item.content ?? [])].join("\n\n");
      return text.trim() ? { ...base, kind: "reasoning", text } : null;
    }
    case "plan":
      return { ...base, kind: "system", text: item.text ?? "" };
    case "commandExecution":
      return toolItem({ name: "shell", input: item.command, output: clip(item.aggregatedOutput), status: toolStatus(item.status, item.exitCode) });
    case "fileChange": {
      const changes: Json[] = item.changes ?? [];
      const files = changes.map((change) => ({ path: change.path, ...diffStats(change.diff ?? "") }));
      return toolItem({ name: "edit", input: changes.map((change) => `${change.kind?.type ?? "update"} ${change.path}`).join("\n"),
        output: clip(changes.map((change) => change.diff).join("\n")), status: toolStatus(item.status), files,
        additions: files.reduce((sum, file) => sum + file.additions, 0), deletions: files.reduce((sum, file) => sum + file.deletions, 0) });
    }
    case "mcpToolCall":
      return toolItem({ name: `${item.server}.${item.tool}`, input: clip(formatArgs(item.arguments)), output: clip(mcpResultText(item)),
        status: item.error || item.result?.isError ? "error" : toolStatus(item.status) }, item.result);
    case "dynamicToolCall":
      return toolItem({ name: item.tool ?? item.name ?? "tool", input: clip(formatArgs(item.arguments)),
        output: clip(item.contentItems ? item.contentItems.filter((part: Json) => part.type === "inputText").map((part: Json) => part.text).join("\n") : asText(item.result)),
        status: item.success === false ? "error" : toolStatus(item.status) }, item.contentItems ?? item.result);
    case "webSearch":
      return toolItem({ name: "web_search", input: item.query ?? asText(item.action?.queries), status: toolStatus(item.status ?? "completed") });
    case "collabAgentToolCall":
    case "subAgentActivity":
      return toolItem({ name: "subagent", input: clip(asText(item.prompt ?? item.description ?? "")), status: toolStatus(item.status) });
    case "contextCompaction":
      return { ...base, kind: "system", text: "上下文已压缩" };
    case "imageGeneration": {
      const result = typeof item.result === "string" && item.result.length >= 4 && item.result.length % 4 === 0 && /^[a-zA-Z0-9+/]+={0,2}$/.test(item.result)
        ? { b64_json: item.result } : { result: item.result };
      return toolItem({ name: "image_generation", input: item.revisedPrompt ?? undefined,
        output: item.failure ? clip(asText(item.failure)) : item.savedPath,
        status: item.failure ? "error" : toolStatus(item.status) }, [result, { savedPath: item.savedPath }]);
    }
    case "imageView":
      return toolItem({ name: "image_view", input: item.path, status: toolStatus(item.status ?? "completed") }, { path: item.path });
    case "enteredReviewMode":
      return { ...base, kind: "system", text: "进入审查模式" };
    case "exitedReviewMode":
      return { ...base, kind: "system", text: "退出审查模式" };
    default:
      return null;
  }
}

export class CodexAdapter implements Adapter {
  readonly agent = "codex" as const;
  private rpc: LineRpc | null = null;
  private starting: Promise<LineRpc> | null = null;
  private error: string | null = null;
  private stopped = false;
  private readonly bin: string | null;
  /** Threads resumed into our app-server (turn/start needs a loaded thread). */
  private readonly loaded = new Set<string>();
  /** In-flight thread/unsubscribe calls; a resume must wait so it does not race the unload. */
  private readonly releasing = new Map<string, Promise<void>>();
  private readonly activeTurn = new Map<string, string>();
  private readonly pending = new Map<string, PendingRequest>();
  private readonly liveTools = new Map<string, Map<string, Item>>();
  private readonly hub: Hub;
  private readonly configPath = join(process.env.ANYWHERE_HOME ?? join(homedir(), ".anywherecoding"), "codex-session-config.json");
  private readonly overrides = new Map<string, SavedConfig>();
  private readonly nativeConfig = new Map<string, Json>();
  private readonly defaultEfforts = new Map<string, string>();
  private readonly tokenUsage = new Map<string, SessionConfig["context"]>();
  /** Desktop app IPC: route turns to the window that owns a thread instead of stealing its writer lock. */
  private readonly ipc: CodexDesktopIpc;
  private readonly follows = new Map<string, Follow>();

  constructor(hub: Hub, bin?: string, ipc: CodexDesktopIpc = new CodexDesktopIpc()) {
    this.hub = hub;
    this.ipc = ipc;
    this.bin = findBin("codex", bin, CODEX_FALLBACKS);
    try {
      const saved = JSON.parse(readFileSync(this.configPath, "utf8"));
      for (const [id, value] of Object.entries(saved)) {
        if ((value as SavedConfig)?.patch && (value as SavedConfig)?.inherited) this.overrides.set(id, value as SavedConfig);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }

  availability(): AgentAvailability {
    if (!this.bin) return { agent: this.agent, ok: false, reason: "未找到 codex 可执行文件" };
    return this.error ? { agent: this.agent, ok: false, reason: this.error } : { agent: this.agent, ok: true };
  }

  async start(): Promise<void> {
    if (!this.bin) return;
    await this.connection().catch(() => undefined);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    for (const follow of this.follows.values()) if (follow.timer) clearTimeout(follow.timer);
    this.follows.clear();
    this.ipc.close();
    this.rpc?.kill();
  }

  private connection(): Promise<LineRpc> {
    if (this.rpc?.alive) return Promise.resolve(this.rpc);
    if (this.starting) return this.starting;
    if (!this.bin) return Promise.reject(new Error("codex not found"));
    const bin = this.bin;
    this.starting = (async () => {
      // Codex ≥0.163 holds a per-thread writer lock while a thread is loaded. Unload as
      // soon as we unsubscribe so Codex desktop/CLI can write the thread between our turns.
      const rpc = new LineRpc(bin, ["-c", "thread_unload_delay_secs=0", "app-server"], { env: process.env });
      rpc.on("notification", (method: string, params: Json) => this.onNotification(method, params));
      rpc.on("request", (id: number | string, method: string, params: Json) => this.onRequest(id, method, params));
      rpc.on("exit", (code: unknown) => this.onExit(rpc, code));
      try {
        await rpc.request("initialize", {
          clientInfo: { name: "anywherecoding", title: "AnywhereCoding", version: "0.1.0" },
          capabilities: null,
        }, 30_000);
        rpc.notify("initialized");
      } catch (error) {
        rpc.kill();
        this.error = `codex app-server 启动失败: ${(error as Error).message} ${rpc.stderrTail.slice(-300)}`;
        throw error;
      }
      this.rpc = rpc;
      this.error = null;
      return rpc;
    })().finally(() => {
      this.starting = null;
    });
    return this.starting;
  }

  private onExit(rpc: LineRpc, code: unknown): void {
    if (this.rpc !== rpc) return;
    this.rpc = null;
    this.loaded.clear();
    this.releasing.clear();
    for (const threadId of this.activeTurn.keys()) this.hub.notice("error", `Codex 进程退出 (${code})${rpc.stderrTail?.trim() ? `\n${rpc.stderrTail.trim().slice(-2000)}` : ""}`, sessionKey(this.agent, threadId));
    for (const threadId of this.liveTools.keys()) this.finishTools(threadId, "Codex 进程已退出，工具执行中断");
    for (const threadId of this.activeTurn.keys()) this.hub.status(sessionKey(this.agent, threadId), "idle");
    this.activeTurn.clear();
    this.pending.clear();
    this.hub.retainApprovals(this.agent, () => false);
    if (this.stopped) return;
    this.error = `codex app-server 已退出 (${code})`;
    setTimeout(() => this.connection().catch(() => undefined), 3000);
  }

  async listSessions(): Promise<SessionSummary[]> {
    const rpc = await this.connection();
    const result = await rpc.request("thread/list", { limit: 80, sortKey: "updated_at" });
    return (result.data as Json[]).map((thread) => {
      const key = sessionKey(this.agent, thread.id);
      const running = thread.status?.type === "active" || this.activeTurn.has(thread.id);
      return {
        id: key,
        agent: this.agent,
        nativeId: thread.id,
        title: thread.name || firstLine(thread.preview ?? "") || "(无标题)",
        cwd: thread.cwd ?? null,
        updatedAt: (thread.updatedAt ?? thread.createdAt ?? 0) * 1000,
        status: this.hub.liveStatus(key) ?? (running ? "running" : "idle"),
      };
    });
  }

  async history(threadId: string, before: string | null): Promise<History> {
    const rpc = await this.connection();
    const result = await rpc.request("thread/turns/list", {
      threadId,
      limit: 8,
      itemsView: "full",
      sortDirection: "desc",
      ...(before ? { cursor: before } : {}),
    });
    const turns = [...(result.data as Json[])].reverse();
    const items: Item[] = [];
    for (const turn of turns) {
      const ts = turn.startedAt ? turn.startedAt * 1000 : undefined;
      for (const raw of turn.items ?? []) {
        const item = mapCodexItem(raw, ts);
        if (item) items.push(item);
      }
      if (turn.status === "failed") {
        items.push({ id: `${turn.id}:error`, kind: "error", text: errorText(turn.error, "Codex 回合失败") });
      }
    }
    return { items, before: result.nextCursor ?? null };
  }

  private saveConfig(): void {
    mkdirSync(dirname(this.configPath), { recursive: true, mode: 0o700 });
    const temporary = `${this.configPath}.${process.pid}.tmp`;
    writeFileSync(temporary, JSON.stringify(Object.fromEntries(this.overrides)), { mode: 0o600 });
    renameSync(temporary, this.configPath);
  }

  private captureConfig(threadId: string, result: Json): void {
    this.nativeConfig.set(threadId, {
      model: result.model, effort: result.reasoningEffort ?? result.effort ?? null,
      approvalPolicy: result.approvalPolicy, sandboxPolicy: result.sandbox ?? result.sandboxPolicy,
    });
  }

  private turnConfig(threadId: string): Json {
    const saved = this.overrides.get(threadId);
    if (!saved) return {};
    const { patch, inherited } = saved;
    const result: Json = {};
    if (patch.model !== undefined) result.model = patch.model ?? inherited.model;
    if (patch.thinking !== undefined) result.effort = patch.thinking ?? inherited.effort ?? this.defaultEfforts.get(patch.model ?? inherited.model) ?? inherited.defaultEffort;
    if (patch.permissionMode !== undefined) Object.assign(result, patch.permissionMode == null
      ? { approvalPolicy: inherited.approvalPolicy, sandboxPolicy: inherited.sandboxPolicy }
      : permissionParams(patch.permissionMode));
    return result;
  }

  async configuration(threadId: string | null): Promise<SessionConfig> {
    const rpc = await this.connection();
    const models: SessionConfig["models"] = [];
    let defaultModel: string | null = null;
    let cursor: string | undefined;
    do {
      const page = await rpc.request("model/list", { ...(cursor ? { cursor } : {}) });
      for (const model of page.data ?? []) {
        if (model.hidden) continue;
        if (model.isDefault) defaultModel = model.model;
        if (model.defaultReasoningEffort) this.defaultEfforts.set(model.model, model.defaultReasoningEffort);
        models.push({ value: model.model, label: model.displayName, description: model.description,
          defaultThinking: model.defaultReasoningEffort,
          thinkingLevels: (model.supportedReasoningEfforts ?? []).map((level: Json) => ({ value: level.reasoningEffort, label: level.reasoningEffort, description: level.description })) });
      }
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
    let native: Json = {};
    if (threadId) {
      const { thread } = await rpc.request("thread/read", { threadId, includeTurns: false });
      native = { ...this.nativeConfig.get(threadId), ...(thread.model !== undefined ? { model: thread.model } : {}), ...(thread.reasoningEffort !== undefined ? { effort: thread.reasoningEffort } : {}) };
      // Older app-servers expose permissions only in resume responses. The rollout's
      // latest native turn_context is a read-only fallback for unloaded sessions.
      if (!native.sandboxPolicy && thread.path) {
        try {
          const lines = readFileSync(thread.path, "utf8").trim().split("\n");
          for (let i = lines.length - 1; i >= 0; i--) {
            const entry = JSON.parse(lines[i]);
            if (entry.type !== "turn_context") continue;
            const context = entry.payload;
            const sandbox = context.sandbox_policy;
            native.approvalPolicy = context.approval_policy;
            if (sandbox) native.sandboxPolicy = sandbox.type === "danger-full-access" ? { type: "dangerFullAccess" }
              : sandbox.type === "read-only" ? { type: "readOnly", networkAccess: sandbox.network_access ?? false }
              : sandbox.type === "workspace-write" ? { type: "workspaceWrite", writableRoots: sandbox.writable_roots ?? [], networkAccess: sandbox.network_access ?? false, excludeTmpdirEnvVar: sandbox.exclude_tmpdir_env_var ?? false, excludeSlashTmp: sandbox.exclude_slash_tmp ?? false } : sandbox;
            native.model ??= context.model;
            native.effort ??= context.effort;
            break;
          }
        } catch { /* Native config remains unknown when rollout is unavailable. */ }
      }
      native.active = thread.status?.type === "active";
      this.nativeConfig.set(threadId, native);
    } else {
      const { config } = await rpc.request("config/read", { includeLayers: false });
      const workspace = config.sandbox_workspace_write ?? {};
      const sandboxPolicy = config.sandbox_mode === "danger-full-access" ? { type: "dangerFullAccess" }
        : config.sandbox_mode === "read-only" ? { type: "readOnly", networkAccess: false }
        : config.sandbox_mode === "workspace-write" ? { type: "workspaceWrite", writableRoots: workspace.writable_roots ?? [], networkAccess: workspace.network_access ?? false, excludeTmpdirEnvVar: workspace.exclude_tmpdir_env_var ?? false, excludeSlashTmp: workspace.exclude_slash_tmp ?? false } : undefined;
      native = { model: config.model ?? defaultModel, effort: config.model_reasoning_effort ?? null,
        approvalPolicy: config.approval_policy, sandboxPolicy };
    }
    if (native.model && !models.some((model) => model.value === native.model)) {
      // Only the native Codex provider alias is known to be equivalent. A suffix
      // from another provider must not acquire this model's thinking options.
      const matching = native.model.startsWith("codex/") ? models.find((model) => model.value === native.model.slice("codex/".length)) : undefined;
      if (matching) {
        models.push({ ...matching, value: native.model });
        if (matching.defaultThinking) this.defaultEfforts.set(native.model, matching.defaultThinking);
      } else {
        models.push({ value: native.model, label: native.model, thinkingLevels: [], description: "原生当前模型；目录未提供该模型的思考选项" });
      }
    }
    const patch = threadId ? this.overrides.get(threadId)?.patch : undefined;
    const effectivePermissionMode = permissionMode(native.approvalPolicy, native.sandboxPolicy);
    return {
      model: patch?.model !== undefined ? patch.model : native.model ?? null,
      thinking: patch?.thinking !== undefined ? patch.thinking : native.effort ?? null,
      permissionMode: patch?.permissionMode !== undefined ? patch.permissionMode : effectivePermissionMode,
      effectivePermissionMode, models, permissionModes,
      ...(threadId && this.tokenUsage.has(threadId) ? { context: this.tokenUsage.get(threadId) } : {}),
      notice: "配置在下一次发送时生效；继承会保留原生设置。自定义原生权限组合可能无法对应预设。",
    };
  }

  async configure(threadId: string, patch: SessionConfigPatch): Promise<SessionConfig> {
    const busy = () => this.activeTurn.has(threadId) || ["running", "approval"].includes(this.hub.liveStatus(sessionKey(this.agent, threadId)) ?? "");
    if (busy()) throw Object.assign(new Error("Codex 正在运行，请先停止当前回合"), { status: 409 });
    const config = await this.configuration(threadId);
    const saved = this.overrides.get(threadId);
    const validation = { ...config, model: config.model ?? saved?.inherited.model ?? this.nativeConfig.get(threadId)?.model ?? null };
    const candidate = { ...patch, ...(patch.model === null ? { model: saved?.inherited.model ?? validation.model } : {}) };
    validateConfigPatch(patch, validation);
    const merged = { ...saved?.patch, ...patch };
    if (merged.thinking != null) validateConfigPatch({ ...candidate, thinking: merged.thinking }, validation);
    if (busy()) throw Object.assign(new Error("Codex 正在运行，请先停止当前回合"), { status: 409 });
    if (this.nativeConfig.get(threadId)?.active) throw Object.assign(new Error("Codex 正在运行，请先停止当前回合"), { status: 409 });
    // Resume without overrides once to capture the exact native permission policy.
    try {
      await this.ensureLoaded(threadId);
    } catch (error) {
      if (!(error as Json).lockHeld) throw error;
      throw Object.assign(new Error(`该会话由 Codex 桌面 App 持有写入锁，网页暂不能修改它的设置；请在桌面 App 中修改，或退出桌面 App 后重试。\n原生错误：${(error as Error).message}`), { status: 409 });
    }
    if (busy()) throw Object.assign(new Error("Codex 正在运行，请先停止当前回合"), { status: 409 });
    const previous = this.overrides.get(threadId);
    const inherited = previous?.inherited ?? { ...this.nativeConfig.get(threadId) };
    inherited.defaultEffort ??= this.defaultEfforts.get(inherited.model);
    this.overrides.set(threadId, { patch: { ...previous?.patch, ...patch }, inherited });
    this.saveConfig();
    this.release(threadId);
    return this.configuration(threadId);
  }

  /** Drop our subscription so app-server unloads the idle thread and frees its writer lock. */
  private release(threadId: string): void {
    const rpc = this.rpc;
    if (!rpc?.alive || !this.loaded.has(threadId) || this.activeTurn.has(threadId)) return;
    this.loaded.delete(threadId);
    // Older app-servers without thread/unsubscribe just keep the thread loaded.
    const done: Promise<void> = rpc.request("thread/unsubscribe", { threadId }).then(() => undefined, () => undefined)
      .finally(() => { if (this.releasing.get(threadId) === done) this.releasing.delete(threadId); });
    this.releasing.set(threadId, done);
  }

  private async ensureLoaded(threadId: string): Promise<LineRpc> {
    await this.releasing.get(threadId);
    const rpc = await this.connection();
    if (!this.loaded.has(threadId)) {
      let result: Json;
      try {
        result = await rpc.request("thread/resume", { threadId, excludeTurns: true });
      } catch (error) {
        const message = (error as Error).message ?? "";
        if (!message.includes("already has an active writer")) throw error;
        throw Object.assign(new Error(message), { status: 409, lockHeld: true });
      }
      this.captureConfig(threadId, result);
      this.loaded.add(threadId);
      this.unfollow(threadId);
    }
    return rpc;
  }

  /** 409 explaining who holds the writer lock and how to free it. */
  private async lockError(threadId: string, native: string): Promise<Error> {
    const holder = await lockHolder(threadId).catch(() => null);
    const text = holder?.desktop || !holder
      ? `该会话由 Codex 桌面 App 加载${holder ? `（${holder.text}）` : ""}，但桌面 App 当前没有窗口打开它，无法转交。请在 Codex 桌面 App 中打开这个会话（之后网页发送会自动交给桌面执行），或退出桌面 App 后重试。`
      : `该会话正被其他 Codex 进程写入（${holder.text}），请等它结束或关闭后重试。`;
    return Object.assign(new Error(`${text}\n原生错误：${native}`), { status: 409 });
  }

  async send(threadId: string, text: string): Promise<void> {
    let rpc: LineRpc;
    try {
      rpc = await this.ensureLoaded(threadId);
    } catch (error) {
      if (!(error as Json).lockHeld) throw error;
      return this.sendViaDesktop(threadId, text, (error as Error).message);
    }
    // During an active turn app-server treats turn/start as input to that turn.
    const result = await rpc.request("turn/start", { threadId, ...this.turnConfig(threadId), input: [{ type: "text", text, text_elements: [] }] });
    if (result?.turn?.id) this.markTurn(threadId, result.turn.id);
  }

  /** Run `action` against the desktop window owning the thread, rediscovering once if it went away. */
  private async withOwner<T>(threadId: string, native: string, action: (owner: string) => Promise<T>): Promise<T> {
    const follow = this.follow(threadId);
    for (let attempt = 0; attempt < 2; attempt++) {
      const owner = (attempt === 0 ? follow.owner : null) ?? await this.ipc.findOwner(threadId);
      if (!owner) break;
      follow.owner = owner;
      try {
        return await action(owner);
      } catch (error) {
        if (!/client-not-found|no-client-found|client-disconnected|连接已关闭/.test((error as Error).message) || attempt) throw error;
        follow.owner = null;
      }
    }
    throw await this.lockError(threadId, native);
  }

  private async latestTurn(threadId: string): Promise<Json | null> {
    const rpc = await this.connection();
    const result = await rpc.request("thread/turns/list", { threadId, limit: 1, itemsView: "notLoaded", sortDirection: "desc" });
    return (result.data as Json[])[0] ?? null;
  }

  /**
   * The desktop app owns this thread's writer lock. Hand the message to its window over
   * the desktop IPC (as a second desktop window would): steer the running turn, or start
   * a new one, then mirror the rollout until it finishes.
   */
  private async sendViaDesktop(threadId: string, text: string, native: string): Promise<void> {
    const latest = await this.latestTurn(threadId).catch(() => null);
    const running = latest != null && !TERMINAL_TURN.has(latest.status);
    await this.withOwner(threadId, native, async (owner) => {
      if (running) {
        try {
          await this.ipc.steerTurn(owner, threadId, text);
          return;
        } catch (error) {
          // The turn may have just ended: start a new one. A timeout may already have
          // delivered the steer, so never resend it as a new turn.
          if (/timeout|client-not-found|no-client-found|client-disconnected|连接已关闭/i.test((error as Error).message)) throw error;
        }
      }
      await this.ipc.startTurn(owner, threadId, text);
    });
    const follow = this.follow(threadId);
    follow.baseline = { turnId: running ? null : latest?.id ?? null, at: Date.now() };
    follow.running = true;
    follow.until = Math.max(follow.until, Date.now() + ROUTED_GRACE_MS);
    this.hub.status(sessionKey(this.agent, threadId), "running");
    if (!follow.told) {
      follow.told = true;
      this.hub.notice("info", "该会话由 Codex 桌面 App 持有，消息已交给桌面 App 执行；网页的模型/权限覆盖不生效，审批请在桌面 App 中处理。", sessionKey(this.agent, threadId));
    }
    this.schedule(threadId, 800);
  }

  private follow(threadId: string): Follow {
    let follow = this.follows.get(threadId);
    if (!follow) {
      follow = { owner: null, turnId: null, running: false, baseline: null, seen: new Map(), until: 0, timer: null, polling: false, told: false, path: undefined, mtime: 0 };
      this.follows.set(threadId, follow);
    }
    return follow;
  }

  private unfollow(threadId: string): void {
    const follow = this.follows.get(threadId);
    if (!follow) return;
    if (follow.timer) clearTimeout(follow.timer);
    this.follows.delete(threadId);
  }

  private schedule(threadId: string, delay: number): void {
    const follow = this.follows.get(threadId);
    if (!follow || this.stopped) return;
    if (follow.timer) clearTimeout(follow.timer);
    follow.timer = setTimeout(() => { follow.timer = null; void this.pollFollow(threadId); }, delay);
  }

  /** Mirror a thread another process writes: new/changed items and the latest turn's state. */
  private async pollFollow(threadId: string): Promise<void> {
    const follow = this.follows.get(threadId);
    if (!follow || follow.polling || this.stopped) return;
    if (this.loaded.has(threadId)) { this.unfollow(threadId); return; }
    follow.polling = true;
    try {
      await this.mirror(threadId, follow);
    } catch {
      // The next poll retries; a vanished thread simply stops being followed below.
    } finally {
      follow.polling = false;
    }
    if (follow.running || Date.now() < follow.until) this.schedule(threadId, follow.running ? 1500 : 4000);
    else this.unfollow(threadId);
  }

  private async mirror(threadId: string, follow: Follow): Promise<void> {
    const key = sessionKey(this.agent, threadId);
    const rpc = await this.connection();
    if (follow.path === undefined) {
      follow.path = await rpc.request("thread/read", { threadId, includeTurns: false }).then((result: Json) => result?.thread?.path ?? null, () => null);
    }
    let mtime = 0;
    try { mtime = follow.path ? statSync(follow.path).mtimeMs : 0; } catch { /* rotated or missing: re-read */ }
    if (mtime && mtime === follow.mtime && !follow.baseline) return;
    const result = await rpc.request("thread/turns/list", { threadId, limit: 2, itemsView: "full", sortDirection: "desc" });
    follow.mtime = mtime;
    const turns = [...(result.data as Json[])].reverse();
    for (const turn of turns) {
      const ts = turn.startedAt ? turn.startedAt * 1000 : undefined;
      const items = (turn.items ?? []).map((raw: Json) => mapCodexItem(raw, ts)).filter(Boolean) as Item[];
      if (turn.status === "failed") items.push({ id: `${turn.id}:error`, kind: "error", text: errorText(turn.error, "Codex 回合失败") });
      for (const item of items) {
        const mark = JSON.stringify(item);
        if (follow.seen.get(item.id) === mark) continue;
        follow.seen.set(item.id, mark);
        this.hub.item(key, item);
      }
    }
    const latest = turns.at(-1);
    let running = latest != null && !TERMINAL_TURN.has(latest.status);
    if (running) { follow.turnId = latest!.id; follow.baseline = null; }
    else if (follow.baseline) {
      // A routed send whose turn is not persisted yet still counts as running.
      if ((latest?.id ?? null) === follow.baseline.turnId && Date.now() - follow.baseline.at < ROUTED_GRACE_MS) running = true;
      else follow.baseline = null;
    }
    if (running !== follow.running || running) this.hub.status(key, running ? "running" : "idle");
    if (follow.running && !running) this.hub.sessionsChanged();
    follow.running = running;
  }

  /** A client is viewing the thread: mirror it if another process (the desktop app) writes it. */
  watch(threadId: string): void {
    if (this.loaded.has(threadId)) return;
    const follow = this.follow(threadId);
    follow.until = Math.max(follow.until, Date.now() + 75_000);
    if (!follow.timer && !follow.polling) void this.pollFollow(threadId);
  }

  async create(cwd: string, text: string, config: SessionConfigPatch = {}): Promise<string> {
    validateConfigPatch(config, await this.configuration(null));
    const rpc = await this.connection();
    // Start with native defaults; apply relay overrides to the very first turn.
    // This also retains an exact baseline when the user later selects inherit.
    const result = await rpc.request("thread/start", { cwd });
    const threadId: string = result.thread.id;
    this.loaded.add(threadId);
    this.captureConfig(threadId, result);
    const inherited = this.nativeConfig.get(threadId)!;
    inherited.defaultEffort = this.defaultEfforts.get(inherited.model);
    if (Object.keys(config).length) {
      this.overrides.set(threadId, { patch: config, inherited: { ...this.nativeConfig.get(threadId) } });
      this.saveConfig();
    }
    await this.send(threadId, text);
    this.hub.sessionsChanged();
    return threadId;
  }

  async interrupt(threadId: string): Promise<void> {
    const turnId = this.activeTurn.get(threadId);
    if (turnId && this.loaded.has(threadId)) {
      const rpc = await this.connection();
      await rpc.request("turn/interrupt", { threadId, turnId });
      return;
    }
    const follow = this.follows.get(threadId);
    if (!follow?.running) throw new Error("没有正在运行的回合");
    await this.withOwner(threadId, "thread is written by another Codex process", (owner) => this.ipc.interruptTurn(owner, threadId, follow.turnId));
    this.schedule(threadId, 500);
  }

  async rename(threadId: string, title: string): Promise<void> {
    const rpc = await this.connection();
    await rpc.request("thread/name/set", { threadId, name: title });
    this.hub.sessionsChanged();
  }

  /** Codex archives (restorable from the Codex app's archived list); thread/list omits archived threads. */
  async remove(threadId: string): Promise<void> {
    const key = sessionKey(this.agent, threadId);
    if (this.activeTurn.has(threadId) || this.hub.liveStatus(key) === "running" || this.hub.liveStatus(key) === "approval") throw Object.assign(new Error("会话正在运行或等待审批，请先停止当前回合"), { status: 409 });
    const rpc = await this.connection();
    await rpc.request("thread/archive", { threadId });
    this.loaded.delete(threadId);
    if (this.overrides.delete(threadId)) this.saveConfig();
    this.hub.forget(key);
  }

  private markTurn(threadId: string, turnId: string): void {
    this.activeTurn.set(threadId, turnId);
    this.hub.status(sessionKey(this.agent, threadId), "running");
  }

  private finishTools(threadId: string, output: string): void {
    for (const item of this.liveTools.get(threadId)?.values() ?? []) {
      if (item.tool?.status === "running") this.hub.item(sessionKey(this.agent, threadId), { ...item, tool: { ...item.tool, status: "error", output: item.tool.output || output } });
    }
    this.liveTools.delete(threadId);
  }

  private onNotification(method: string, params: Json): void {
    const threadId: string | undefined = params?.threadId;
    const key = threadId ? sessionKey(this.agent, threadId) : "";
    switch (method) {
      case "thread/settings/updated":
        if (threadId) this.captureConfig(threadId, params.threadSettings);
        break;
      case "thread/tokenUsage/updated":
        if (threadId) this.tokenUsage.set(threadId, { usedTokens: params.tokenUsage?.last?.totalTokens ?? null, windowTokens: params.tokenUsage?.modelContextWindow ?? null, source: "codex tokenUsage" });
        break;
      case "turn/started":
        if (threadId) this.markTurn(threadId, params.turn.id);
        break;
      case "turn/completed": {
        if (!threadId) break;
        this.finishTools(threadId, "回合已结束，工具未返回结果");
        this.activeTurn.delete(threadId);
        this.hub.status(key, "idle");
        this.release(threadId);
        const turn = params.turn as Json;
        if (turn?.status === "failed") {
          this.hub.item(key, { id: `${turn.id}:error`, kind: "error", text: errorText(turn.error, "Codex 回合失败"), ts: Date.now() });
        }
        this.hub.sessionsChanged();
        break;
      }
      case "item/started":
      case "item/completed": {
        if (!threadId) break;
        const raw = method === "item/completed" && params.item.status == null ? { ...params.item, status: "completed" } : params.item;
        const item = mapCodexItem(raw, Date.now());
        if (item?.tool) {
          if (method === "item/started") item.tool.status = "running";
          const tools = this.liveTools.get(threadId) ?? new Map<string, Item>();
          const previous = tools.get(item.id);
          if (!item.images?.length && previous?.images?.length) item.images = previous.images;
          if (item.tool.status === "running") tools.set(item.id, item); else tools.delete(item.id);
          this.liveTools.set(threadId, tools);
        }
        if (item) this.hub.item(key, { ...item, ...(method === "item/started" && item.kind === "assistant" ? { streaming: true } : {}) });
        break;
      }
      case "item/agentMessage/delta":
        if (threadId) this.hub.delta(key, params.itemId, params.delta);
        break;
      case "thread/status/changed":
        if (threadId && params.status?.type === "idle" && !this.activeTurn.has(threadId)) this.hub.status(key, "idle");
        break;
      case "thread/started":
      case "thread/name/updated":
        this.hub.sessionsChanged();
        break;
      case "serverRequest/resolved": {
        const approvalId = `codex:${params.requestId}`;
        this.pending.delete(approvalId);
        this.hub.resolveApproval(approvalId);
        break;
      }
      case "error":
        this.hub.notice("error", `${errorText(params?.error ?? params, "Codex 错误")}${params?.willRetry ? "\n正在由 Codex 自动重试…" : ""}`, key || undefined);
        break;
    }
  }

  private onRequest(rpcId: number | string, method: string, params: Json): void {
    const approvalId = `codex:${rpcId}`;
    const approval = this.describe(approvalId, method, params);
    if (!approval) {
      // Nobody else is attached to this app-server; leaving it unanswered would hang the turn.
      this.rpc?.respondError(rpcId, -32601, `anywherecoding does not handle ${method}`);
      return;
    }
    this.pending.set(approvalId, { rpcId, method, params });
    this.hub.addApproval(approval);
  }

  private describe(id: string, method: string, params: Json): Approval | null {
    const sessionId = sessionKey(this.agent, params.threadId ?? params.conversationId ?? "");
    const base = { id, sessionId, agent: this.agent, createdAt: Date.now() };
    const yesNo = [
      { id: "accept", label: "允许", tone: "primary" as const },
      { id: "acceptForSession", label: "本会话都允许" },
      { id: "decline", label: "拒绝", tone: "danger" as const },
    ];
    switch (method) {
      case "item/commandExecution/requestApproval":
        return {
          ...base,
          title: params.kind === "network" ? "请求网络访问" : "运行命令",
          detail: [params.command, params.cwd ? `目录: ${params.cwd}` : "", params.reason ?? ""].filter(Boolean).join("\n"),
          choices: yesNo,
        };
      case "item/fileChange/requestApproval":
        return {
          ...base,
          title: "修改文件",
          detail: [params.reason ?? "", params.grantRoot ? `申请写入: ${params.grantRoot}` : ""].filter(Boolean).join("\n") || "Agent 请求应用文件修改（详见上方的 edit 项）",
          choices: yesNo,
        };
      case "item/permissions/requestApproval":
        return {
          ...base,
          title: "申请额外权限",
          detail: [params.reason ?? "", asText(params.permissions)].filter(Boolean).join("\n"),
          choices: [
            { id: "turn", label: "本回合授予", tone: "primary" },
            { id: "session", label: "本会话授予" },
            { id: "decline", label: "拒绝", tone: "danger" },
          ],
        };
      case "item/tool/requestUserInput":
        return {
          ...base,
          title: "Agent 提问",
          detail: "",
          choices: [{ id: "submit", label: "提交", tone: "primary" }, { id: "cancel", label: "跳过" }],
          questions: (params.questions as Json[]).map((question) => ({
            id: question.id,
            header: question.header ?? "",
            question: question.question ?? "",
            options: (question.options ?? []).map((option: Json) => ({ label: option.label, description: option.description })),
            allowOther: Boolean(question.isOther) || !question.options?.length,
          })),
        };
      case "execCommandApproval":
        return { ...base, title: "运行命令", detail: asText(params.command), choices: yesNo };
      case "applyPatchApproval":
        return { ...base, title: "修改文件", detail: Object.keys(params.fileChanges ?? {}).join("\n"), choices: yesNo };
      case "mcpServer/elicitation/request":
        return { ...base, title: "MCP 请求确认", detail: params.message ?? asText(params), choices: [{ id: "accept", label: "同意", tone: "primary" }, { id: "decline", label: "拒绝", tone: "danger" }] };
      default:
        return null;
    }
  }

  async resolve(approvalId: string, answer: ApprovalAnswer): Promise<void> {
    const request = this.pending.get(approvalId);
    const rpc = this.rpc;
    if (!request || !rpc) throw new Error("审批已失效");
    const choice = answer.choice;
    let result: unknown;
    switch (request.method) {
      case "item/commandExecution/requestApproval":
      case "item/fileChange/requestApproval":
        result = { decision: choice === "accept" || choice === "acceptForSession" ? choice : "decline" };
        break;
      case "item/permissions/requestApproval":
        result = choice === "decline"
          ? { permissions: {}, scope: "turn" }
          : {
            permissions: Object.fromEntries(Object.entries(request.params.permissions ?? {}).filter(([, value]) => value != null)),
            scope: choice === "session" ? "session" : "turn",
          };
        break;
      case "item/tool/requestUserInput": {
        if (choice === "cancel") {
          // An empty answer would be fabricated; interrupting is the honest "skip".
          rpc.respondError(request.rpcId, -32000, "user skipped");
          this.pending.delete(approvalId);
          this.hub.resolveApproval(approvalId);
          return;
        }
        const answers: Record<string, { answers: string[] }> = {};
        for (const [questionId, values] of Object.entries(answer.answers ?? {})) answers[questionId] = { answers: values };
        result = { answers };
        break;
      }
      case "execCommandApproval":
      case "applyPatchApproval":
        result = { decision: choice === "accept" ? "approved" : choice === "acceptForSession" ? "approved_for_session" : "denied" };
        break;
      case "mcpServer/elicitation/request":
        result = { action: choice === "accept" ? "accept" : "decline", content: null, _meta: null };
        break;
      default:
        throw new Error(`unsupported approval ${request.method}`);
    }
    rpc.respond(request.rpcId, result);
    // serverRequest/resolved normally follows; clear eagerly so the UI does not linger.
    this.pending.delete(approvalId);
    this.hub.resolveApproval(approvalId);
  }
}
