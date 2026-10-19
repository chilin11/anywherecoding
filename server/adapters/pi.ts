import { errorText } from "../errors.ts";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Adapter, Hub } from "../hub.ts";
import { sessionKey } from "../hub.ts";
import type { AgentAvailability, Approval, ApprovalAnswer, History, Item, SessionSummary, ToolInfo } from "../types.ts";
import { asText, clip } from "../util.ts";
import { invalidConfig, validateConfigPatch, type ModelOption, type SessionConfig, type SessionConfigPatch } from "../session-config.ts";
import { extractImages } from "../artifacts.ts";

type Json = Record<string, any>;

const PROTOCOL = "2025-06-18";
const POLL_MS = 1500;
const WATCH_TTL_MS = 2 * 60_000;
const PAGE = 60;

class McpError extends Error {
  readonly code: string | undefined;
  constructor(message: string, code?: string) {
    super(message);
    this.code = code;
  }
}

/** Minimal Streamable-HTTP MCP client for PI-Desktop's local control plane. */
class PiControl {
  private session: string | null = null;
  private nextId = 1;
  readonly url: string;
  private readonly token: string;

  constructor(url: string, token: string) {
    this.url = url;
    this.token = token;
  }

  private async post(body: Json): Promise<{ status: number; json: Json | null; session: string | null }> {
    const response = await fetch(this.url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.token}`,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "mcp-protocol-version": PROTOCOL,
        ...(this.session ? { "mcp-session-id": this.session } : {}),
      },
      body: JSON.stringify({ jsonrpc: "2.0", ...body }),
      signal: AbortSignal.timeout(30_000),
    });
    const text = await response.text();
    return { status: response.status, json: text ? JSON.parse(text) : null, session: response.headers.get("mcp-session-id") };
  }

  private async initialize(): Promise<void> {
    this.session = null;
    const result = await this.post({
      id: this.nextId++,
      method: "initialize",
      params: { protocolVersion: PROTOCOL, capabilities: {}, clientInfo: { name: "anywherecoding", version: "0.1.0" } },
    });
    if (result.status !== 200 || !result.session) throw new McpError(`PI-Desktop 控制口初始化失败 (${result.status})`);
    this.session = result.session;
    await this.post({ method: "notifications/initialized" });
  }

  async invoke(operation: string, args: unknown[] = [], confirm = false): Promise<any> {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      if (!this.session) await this.initialize();
      const result = await this.post({
        id: this.nextId++,
        method: "tools/call",
        params: { name: operation === "session/get" ? "pi_session_get" : "pi_desktop_invoke", arguments: operation === "session/get" ? args[0] : { operation, args, ...(confirm ? { confirm: true } : {}) } },
      });
      if (result.status === 404 || result.status === 400) {
        // Desktop restarted and forgot our MCP session.
        this.session = null;
        continue;
      }
      if (result.status !== 200 || !result.json) throw new McpError(`PI-Desktop 控制口错误 (${result.status})`);
      if (result.json.error) throw new McpError(result.json.error.message ?? "PI-Desktop 错误");
      const content = result.json.result?.structuredContent;
      if (result.json.result?.isError) {
        throw new McpError(content?.error?.message ?? "PI-Desktop 操作失败", content?.error?.code);
      }
      if (content?.truncated) throw new McpError("PI-Desktop 返回内容过大", "MCP_RESULT_LIMIT");
      return operation === "session/get" ? content : content?.result;
    }
    throw new McpError("PI-Desktop 控制口会话失效");
  }
}

function toolStatus(status: string | undefined): ToolInfo["status"] {
  if (status === "running") return "running";
  if (status === "error") return "error";
  if (status === "denied") return "denied";
  return "ok";
}

function piToolInput(args: unknown): string {
  if (args && typeof args === "object") {
    const value = args as Json;
    if (typeof value.command === "string") return value.command;
    if (typeof value.path === "string" && typeof value.content !== "string") return value.path;
    if (typeof value.file_path === "string") return value.file_path;
  }
  return asText(args);
}

/** Map a PI-Desktop UiMessage to one or two relay items (thinking is split out). */
export function mapPiMessage(message: Json): Item[] {
  if (message.modelSystem || message.parentToolCallId) return [];
  const ts = message.createdAt ? Date.parse(message.createdAt) : undefined;
  const base = { ...(ts ? { ts } : {}), ...(message.status === "streaming" ? { streaming: true } : {}) };
  switch (message.role) {
    case "user": {
      const attachments = (message.attachments ?? []).length ? `\n[附件 ×${message.attachments.length}]` : "";
      return [{ id: message.id, kind: "user", text: `${message.command ?? message.content ?? ""}${attachments}`, images: extractImages(message.attachments), ...base }];
    }
    case "assistant": {
      const items: Item[] = [];
      if (message.thinking?.trim()) items.push({ id: `${message.id}:thinking`, kind: "reasoning", text: message.thinking, ...base });
      if (message.content?.trim()) items.push({ id: message.id, kind: "assistant", text: message.content, ...base });
      if (message.error) items.push({ id: `${message.id}:error`, kind: "error", text: errorText(message.error, "PI-Desktop 请求失败"), ...base });
      return items;
    }
    case "tool": {
      const result = message.toolResult;
      const details = result?.details ?? result ?? {};
      const review = details.review;
      const output = Array.isArray(result?.content) ? result.content.filter((part: Json) => part.type === "text").map((part: Json) => part.text).join("\n") : asText(result);
      return [{
        id: message.id,
        kind: "tool",
        text: "",
        ...base,
        images: extractImages(result),
        tool: {
          name: message.toolName ?? "tool",
          input: clip(piToolInput(message.toolArgs)),
          output: clip(output),
          status: toolStatus(message.toolStatus),
          ...(typeof message.toolDurationMs === "number" ? { durationMs: message.toolDurationMs } : {}),
          ...(typeof details.exitCode === "number" ? { exitCode: details.exitCode } : {}),
          ...(typeof review?.additions === "number" && typeof review?.deletions === "number" ? { additions: review.additions, deletions: review.deletions, files: [{ path: review.path ?? details.path ?? "", additions: review.additions, deletions: review.deletions }] } : {}),
        },
      }];
    }
    case "system":
      return message.content?.trim() ? [{ id: message.id, kind: "system", text: message.content, ...base }] : [];
    default:
      return [];
  }
}

function signature(item: Item): string {
  return JSON.stringify(item);
}

type Watched = { until: number; seen: Map<string, string>; running: boolean };

export class PiAdapter implements Adapter {
  readonly agent = "pi" as const;
  private readonly hub: Hub;
  private readonly dataDir: string;
  private control: PiControl | null = null;
  private error: string | null = "PI-Desktop 未运行或未开启控制口";
  private readonly watched = new Map<string, Watched>();
  private readonly approvalMeta = new Map<string, { kind: "permission" | "ask"; requestId: string; sessionId: string; count: number }>();
  private timer: NodeJS.Timeout | null = null;
  private polling = false;
  private pendingSupported = true;
  private catalogCache: { until: number; models: ModelOption[] } | null = null;
  private statusesUntil = 0;
  private readonly observedStatuses = new Map<string, boolean>();
  private stopped = false;

  constructor(hub: Hub, dataDir?: string) {
    this.hub = hub;
    this.dataDir = dataDir ?? process.env.PI_DESKTOP_DATA_DIR ?? join(homedir(), ".pi-desktop");
  }

  availability(): AgentAvailability {
    return this.error ? { agent: this.agent, ok: false, reason: this.error } : { agent: this.agent, ok: true };
  }

  /** Re-read the connection file each time: the port and token change with every desktop launch. */
  private connection(): PiControl {
    const path = join(this.dataDir, "mcp-control.json");
    if (!existsSync(path)) {
      this.error = "PI-Desktop 控制口未开启（需以 PI_DESKTOP_MCP_CONTROL=1 启动）";
      throw new McpError(this.error);
    }
    const info = JSON.parse(readFileSync(path, "utf8"));
    if (!info.active || !info.url || !info.token) {
      this.error = "PI-Desktop 未运行";
      throw new McpError(this.error);
    }
    if (!this.control || this.control.url !== info.url) {
      this.control = new PiControl(info.url, info.token);
      this.pendingSupported = true;
      this.catalogCache = null;
    }
    return this.control;
  }

  private async invoke(operation: string, args: unknown[] = [], confirm = false): Promise<any> {
    try {
      const result = await this.connection().invoke(operation, args, confirm);
      this.error = null;
      return result;
    } catch (error) {
      if (error instanceof TypeError) {
        // fetch failed: the desktop quit without marking the file inactive.
        this.error = "PI-Desktop 未运行";
        this.control = null;
      }
      throw error;
    }
  }

  async start(): Promise<void> {
    this.stopped = false;
    this.timer = setInterval(() => void this.poll(), POLL_MS);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.watched.clear();
    if (this.timer) clearInterval(this.timer);
  }

  private modelKey(providerId: string, modelId: string): string {
    return JSON.stringify([providerId, modelId]);
  }

  private async models(): Promise<ModelOption[]> {
    if (this.catalogCache && this.catalogCache.until > Date.now()) return this.catalogCache.models;
    const result = await this.invoke("providers/list");
    const providers: Json[] = (result?.providers ?? []).filter((provider: Json) => provider.enabled);
    const groups = await Promise.all(providers.map(async (provider) => {
      const catalog = await this.invoke("providers/listModels", [{ providerId: provider.id }]);
      const bindings: Json[] = provider.models?.length ? provider.models : provider.defaultModelId ? [{ id: provider.defaultModelId }] : [];
      return bindings.map((binding): ModelOption => {
        const metadata = (catalog?.models ?? []).find((model: Json) => model.modelId.toLowerCase() === binding.id.toLowerCase());
        const window = binding.contextWindowSource === "catalog" ? metadata?.contextWindow || binding.contextWindow : binding.contextWindow || metadata?.contextWindow;
        const levels: string[] = binding.thinkingLevels ?? metadata?.supportedThinkingLevels ?? [];
        return {
          value: this.modelKey(provider.id, binding.id), label: `${provider.name} · ${binding.alias || binding.id}`,
          thinkingLevels: [...new Set([...levels, "omit"])].map((value) => ({ value, label: value === "omit" ? "模型默认" : value })),
          defaultThinking: binding.defaultThinkingLevel ?? "omit", ...(window > 0 ? { contextWindow: window } : {}),
        };
      });
    }));
    const models = groups.flat();
    this.catalogCache = { until: Date.now() + 30_000, models };
    return models;
  }

  async configuration(sessionId: string | null): Promise<SessionConfig> {
    const [models, settingsResult, detail] = await Promise.all([
      this.models(), this.invoke("settings/get"), sessionId ? this.detail(sessionId, null, 30) : Promise.resolve(null),
    ]);
    const settings = settingsResult?.settings ?? settingsResult ?? {};
    const providerId = detail?.providerId || settings.defaultProviderId;
    const modelId = detail?.modelId || settings.defaultModelId;
    const model = providerId && modelId ? this.modelKey(providerId, modelId) : null;
    const option = models.find((entry) => entry.value === model);
    const permissionMode = detail?.permissionMode ?? "inherit";
    let usageMessage = (detail?.messages ?? []).findLast((message: Json) => !message.parentToolCallId && !message.modelSystem && message.usage);
    let cursor = detail?.hasMoreBefore ? detail.messageStart : null;
    for (let page = 0; sessionId && !usageMessage && cursor > 0 && page < 3; page++) {
      const older = await this.detail(sessionId, String(cursor), 60);
      usageMessage = (older.messages ?? []).findLast((message: Json) => !message.parentToolCallId && !message.modelSystem && message.usage);
      cursor = older.hasMoreBefore ? older.messageStart : null;
    }
    const usage = usageMessage?.usage;
    const count = (value: unknown): number => typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
    const sum = usage ? count(usage.inputTokens) + count(usage.outputTokens) + count(usage.cacheReadTokens) + count(usage.cacheWriteTokens) : null;
    const usageModel = usageMessage?.providerId && usageMessage?.modelId ? models.find((entry) => entry.value === this.modelKey(usageMessage.providerId, usageMessage.modelId)) : option;
    return {
      model, thinking: detail?.thinkingLevel ?? option?.defaultThinking ?? null,
      permissionMode, effectivePermissionMode: permissionMode === "inherit" ? settings.defaultPermissionMode ?? "ask" : permissionMode,
      models, permissionModes: [
        { value: "inherit", label: "跟随桌面默认" },
        { value: "ask", label: "询问", description: "工具操作按风险请求确认" },
        { value: "accept-edits", label: "允许编辑", description: "自动允许编辑，其他操作按风险确认" },
        { value: "auto", label: "自动", description: "自动处理工具权限" },
      ],
      ...(sessionId ? { context: { usedTokens: sum === null ? null : sum || count(usage.totalTokens), windowTokens: usageModel?.contextWindow ?? null, source: "最近一次主会话模型请求（含缓存读写；思考已计入输出）" } } : {}),
    };
  }

  async configure(sessionId: string, patch: SessionConfigPatch): Promise<SessionConfig> {
    const status = await this.invoke("agent/getStatus", [sessionId]);
    if (status?.status?.isRunning) throw Object.assign(new Error("PI 正在运行，请先停止当前回合再修改配置"), { status: 409 });
    const current = await this.configuration(sessionId);
    validateConfigPatch(patch, current);
    const detail = await this.detail(sessionId, null, 1);
    const native: Json = { mode: detail.mode ?? "agent" };
    if (patch.model !== undefined) {
      let key = patch.model;
      if (key === null) key = (await this.configuration(null)).model;
      if (!key) throw invalidConfig("请先在 PI-Desktop 配置默认模型");
      const [providerId, modelId] = JSON.parse(key);
      native.providerId = providerId;
      native.modelId = modelId;
      native.thinkingLevel = current.models.find((option) => option.value === key)?.defaultThinking ?? "omit";
    }
    if (patch.thinking !== undefined) native.thinkingLevel = patch.thinking ?? "omit";
    if (patch.permissionMode !== undefined) native.permissionMode = patch.permissionMode ?? "inherit";
    await this.invoke("session/configure", [sessionId, native], true);
    this.hub.sessionsChanged();
    return this.configuration(sessionId);
  }

  async listSessions(): Promise<SessionSummary[]> {
    const result = await this.invoke("session/list");
    const sessions: Json[] = result?.sessions ?? [];
    if (this.statusesUntil < Date.now()) {
      this.statusesUntil = Date.now() + 8000;
      const recent = sessions.filter((session) => !session.scheduledRun && session.source !== "pi-native" && !String(session.id).startsWith("native-"))
        .sort((left, right) => (Date.parse(right.updatedAt) || 0) - (Date.parse(left.updatedAt) || 0)).slice(0, 30);
      for (let offset = 0; offset < recent.length; offset += 5) {
        await Promise.allSettled(recent.slice(offset, offset + 5).map(async (session) => {
          const result = await this.invoke("agent/getStatus", [session.id]);
          const running = Boolean(result?.status?.isRunning);
          this.observedStatuses.set(session.id, running);
          this.hub.status(sessionKey(this.agent, session.id), running ? "running" : "idle");
        }));
      }
    }
    return sessions
      // Codex/Claude transcripts PI-Desktop merely imported are listed by their own adapters.
      .filter((session) => !session.scheduledRun && session.source !== "pi-native" && !String(session.id).startsWith("native-"))
      .map((session) => {
        const key = sessionKey(this.agent, session.id);
        const watched = this.watched.get(session.id);
        return {
          id: key,
          agent: this.agent,
          nativeId: session.id,
          title: session.title || "(无标题)",
          cwd: session.projectPath ?? null,
          updatedAt: Date.parse(session.updatedAt) || 0,
          status: this.hub.liveStatus(key) ?? (watched?.running || this.observedStatuses.get(session.id) ? "running" : this.observedStatuses.has(session.id) ? "idle" : "unknown"),
        };
      });
  }

  private async detail(sessionId: string, before: string | null, limit: number): Promise<Json> {
    for (let count = limit; count >= 1; count = Math.floor(count / 2)) {
      try {
        const result = await this.invoke("session/get", [{ id: sessionId, messageLimit: count, contentLimit: 8000, ...(before ? { messageBefore: Number(before) } : {}) }]);
        if (!result?.session) throw new Error("PI-Desktop 会话不存在");
        return result.session;
      } catch (error) {
        if ((error as McpError).code !== "MCP_RESULT_LIMIT" || count === 1) throw error;
      }
    }
    throw new Error("PI-Desktop 历史过大");
  }

  async history(sessionId: string, before: string | null): Promise<History> {
    const detail = await this.detail(sessionId, before, PAGE);
    const items = (detail.messages ?? []).flatMap(mapPiMessage);
    this.watch(sessionId);
    const start: number | undefined = detail?.messageStart;
    return { items, before: detail?.hasMoreBefore && start ? String(start) : null };
  }

  watch(sessionId: string): void {
    const existing = this.watched.get(sessionId);
    if (existing) existing.until = Date.now() + WATCH_TTL_MS;
    else this.watched.set(sessionId, { until: Date.now() + WATCH_TTL_MS, seen: new Map(), running: false });
  }

  async send(sessionId: string, text: string): Promise<void> {
    await this.invoke("agent/prompt", [{ sessionId, content: text }]);
    this.watch(sessionId);
    this.watched.get(sessionId)!.running = true;
    this.hub.status(sessionKey(this.agent, sessionId), "running");
  }

  async create(cwd: string, text: string, config?: SessionConfigPatch): Promise<string> {
    if (config && Object.keys(config).length) validateConfigPatch(config, await this.configuration(null));
    const result = await this.invoke("session/create", [{ projectPath: cwd, mode: "agent" }]);
    const sessionId: string | undefined = result?.session?.id ?? result?.id;
    if (!sessionId) throw new Error("PI-Desktop 未返回会话 id");
    if (config && Object.keys(config).length) await this.configure(sessionId, config);
    await this.send(sessionId, text);
    this.hub.sessionsChanged();
    return sessionId;
  }

  async interrupt(sessionId: string): Promise<void> {
    await this.invoke("agent/abort", [{ sessionId }]);
  }

  private async poll(): Promise<void> {
    if (this.stopped || this.polling) return;
    this.polling = true;
    try {
      const now = Date.now();
      for (const [sessionId, state] of [...this.watched]) {
        if (state.until < now && !state.running) {
          this.watched.delete(sessionId);
          continue;
        }
        await this.pollSession(sessionId, state);
      }
    } catch {
      // availability() reports the reason; keep polling so we notice the desktop coming back.
    } finally {
      this.polling = false;
    }
  }

  private async pollSession(sessionId: string, state: Watched): Promise<void> {
    const key = sessionKey(this.agent, sessionId);
    const status = await this.invoke("agent/getStatus", [sessionId]);
    const running = Boolean(status?.status?.isRunning);
    const detail = await this.detail(sessionId, null, 30);
    if (this.stopped) return;
    for (const item of (detail?.messages ?? []).flatMap(mapPiMessage) as Item[]) {
      const mark = signature(item);
      if (state.seen.get(item.id) === mark) continue;
      state.seen.set(item.id, mark);
      this.hub.item(key, item);
    }
    await this.pollPending(sessionId);
    if (state.running !== running) {
      state.running = running;
      this.hub.status(key, running ? "running" : "idle");
    }
  }

  private async pollPending(sessionId: string): Promise<void> {
    if (!this.pendingSupported) return;
    let pending: Json;
    try {
      pending = await this.invoke("agent/pendingInteractive", [{ sessionId }]);
    } catch (error) {
      if ((error as McpError).code === "NOT_FOUND") {
        // Older desktop build without the operation exposed.
        this.pendingSupported = false;
        this.hub.notice("info", "当前 PI-Desktop 版本未开放待审批查询，网页无法审批 PI 会话");
        return;
      }
      throw error;
    }
    if (this.stopped) return;
    const key = sessionKey(this.agent, sessionId);
    const live = new Set<string>();
    for (const request of pending?.permissions ?? []) {
      const id = `pi:perm:${request.requestId}`;
      live.add(id);
      if (this.approvalMeta.has(id)) continue;
      this.approvalMeta.set(id, { kind: "permission", requestId: request.requestId, sessionId, count: 0 });
      this.hub.addApproval({
        id,
        sessionId: key,
        agent: this.agent,
        title: `使用工具 ${request.toolName}`,
        detail: [request.reason ?? "", clip(piToolInput(request.argsPreview), 4000)].filter(Boolean).join("\n"),
        choices: [
          { id: "allow-once", label: "允许", tone: "primary" },
          { id: "allow-session", label: "本会话都允许" },
          { id: "deny", label: "拒绝", tone: "danger" },
        ],
        createdAt: Date.now(),
      } satisfies Approval);
    }
    for (const request of pending?.asks ?? []) {
      const id = `pi:ask:${request.requestId}`;
      live.add(id);
      if (this.approvalMeta.has(id)) continue;
      const questions: Json[] = request.questions ?? [];
      this.approvalMeta.set(id, { kind: "ask", requestId: request.requestId, sessionId, count: questions.length });
      this.hub.addApproval({
        id,
        sessionId: key,
        agent: this.agent,
        title: "Agent 提问",
        detail: "",
        choices: [{ id: "submit", label: "提交", tone: "primary" }, { id: "skip", label: "跳过" }],
        questions: questions.map((question, index) => ({
          id: String(index),
          header: question.multiSelect ? "可多选" : "",
          multiSelect: Boolean(question.multiSelect),
          question: question.question,
          options: (question.options ?? []).map((option: string | Json) => (typeof option === "string" ? { label: option } : { label: option.label, description: option.description })),
          allowOther: true,
        })),
        createdAt: Date.now(),
      });
    }
    for (const [id, meta] of [...this.approvalMeta]) {
      if (meta.sessionId === sessionId && !live.has(id)) {
        this.approvalMeta.delete(id);
        this.hub.resolveApproval(id);
      }
    }
  }

  async resolve(approvalId: string, answer: ApprovalAnswer): Promise<void> {
    const meta = this.approvalMeta.get(approvalId);
    if (!meta) throw new Error("审批已失效");
    if (meta.kind === "permission") {
      const decision = answer.choice === "allow-once" || answer.choice === "allow-session" ? answer.choice : "deny";
      await this.invoke("tool/resolvePermission", [{ requestId: meta.requestId, decision }], true);
    } else {
      const answers = Array.from({ length: meta.count }, (_, index) => {
        if (answer.choice === "skip") return null;
        const picked = answer.answers?.[String(index)];
        return picked?.length ? picked : null;
      });
      await this.invoke("agent/askTool/resolve", [{ requestId: meta.requestId, sessionId: meta.sessionId, answers }], true);
    }
    this.approvalMeta.delete(approvalId);
    this.hub.resolveApproval(approvalId);
  }
}
