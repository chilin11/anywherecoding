import { errorText } from "../errors.ts";
import { execFile, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { moveToTrash } from "../trash.ts";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { createInterface } from "node:readline";
import type { Adapter, Hub } from "../hub.ts";
import { sessionKey } from "../hub.ts";
import type { AgentAvailability, Approval, ApprovalAnswer, History, Item, SessionSummary } from "../types.ts";
import { asText, findBin, firstLine } from "../util.ts";
import { ClaudeItemBuilder, parseTranscript, readMeta, toolInput, type TranscriptMeta } from "./claude-transcript.ts";
import { invalidConfig, validateConfigPatch, type SessionConfig, type SessionConfigPatch } from "../session-config.ts";

type Json = Record<string, any>;

const PROJECTS = join(process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude"), "projects");
const DESKTOP_SESSIONS = join(homedir(), "Library/Application Support/Claude/claude-code-sessions");
const IDLE_EXIT_MS = 10 * 60_000;
const PAGE = 150;

type Control = { requestId: string; toolName: string; toolUseId?: string; input: Json; suggestions: unknown };

/** One `claude -p --input-format stream-json` process attached to a session. */
class ClaudeRun {
  readonly child: ChildProcessWithoutNullStreams;
  sessionId: string | null;
  readonly builder = new ClaudeItemBuilder();
  readonly controls = new Map<string, Control>();
  busy = false;
  exited = false;
  idleTimer: NodeJS.Timeout | null = null;
  stderrTail = "";
  onInit: ((sessionId: string) => void) | null = null;
  currentConfig: SessionConfigPatch = {};

  constructor(bin: string, cwd: string, resume: string | null, config: SessionConfigPatch = {}) {
    this.sessionId = resume;
    const args = [
      "-p",
      "--input-format", "stream-json",
      "--output-format", "stream-json",
      "--verbose",
      // Echoes our input back with the transcript uuid, so live and history ids agree.
      "--replay-user-messages",
      "--permission-prompt-tool", "stdio",
      ...(resume ? ["--resume", resume] : []),
      ...(config.model ? ["--model", config.model] : []),
      ...(config.thinking ? ["--effort", config.thinking] : []),
      ...(config.permissionMode ? ["--permission-mode", config.permissionMode] : []),
      ...(config.permissionMode === "bypassPermissions" ? ["--allow-dangerously-skip-permissions"] : []),
    ];
    this.child = spawn(bin, args, {
      cwd,
      env: { ...process.env, CLAUDE_CODE_ENTRYPOINT: "sdk-ts" },
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child.stderr.on("data", (chunk: Buffer) => {
      this.stderrTail = (this.stderrTail + chunk.toString()).slice(-4000);
    });
    this.child.stdin.on("error", (error) => { this.stderrTail = error.message; });
  }

  get alive(): boolean {
    return !this.exited && this.child.exitCode === null && !this.child.killed;
  }

  write(message: object): void {
    if (this.alive) this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  sendUser(text: string): void {
    this.busy = true;
    this.write({ type: "user", message: { role: "user", content: [{ type: "text", text }] }, parent_tool_use_id: null, session_id: this.sessionId ?? "" });
  }
}

export class ClaudeAdapter implements Adapter {
  readonly agent = "claude" as const;
  private readonly bin: string | null;
  private readonly hub: Hub;
  private readonly hidden: string[];
  /** session id -> transcript path, refreshed by listSessions */
  private readonly paths = new Map<string, string>();
  private readonly meta = new Map<string, { mtime: number; size: number; meta: TranscriptMeta }>();
  private readonly runs = new Map<string, ClaudeRun>();
  private readonly processes = new Set<ClaudeRun>();
  /** approval id -> run + control request */
  private readonly approvals = new Map<string, { run: ClaudeRun; control: Control }>();

  private readonly retiring = new Map<string, Promise<void>>();
  private readonly configPath = join(process.env.ANYWHERE_HOME ?? join(homedir(), ".anywherecoding"), "claude-session-config.json");
  private readonly overrides = new Map<string, SessionConfigPatch>();
  private catalog: Promise<{ models: SessionConfig["models"]; permissionModes: SessionConfig["permissionModes"] }> | null = null;
  constructor(hub: Hub, bin: string | undefined, hidden: string[]) {
    this.hub = hub;
    this.bin = findBin("claude", bin);
    this.hidden = hidden;
    try {
      const saved = JSON.parse(readFileSync(this.configPath, "utf8"));
      for (const [id, value] of Object.entries(saved)) if (value && typeof value === "object") this.overrides.set(id, value as SessionConfigPatch);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }

  availability(): AgentAvailability {
    if (!this.bin) return { agent: this.agent, ok: false, reason: "未找到 claude 可执行文件" };
    if (!existsSync(PROJECTS)) return { agent: this.agent, ok: false, reason: `${PROJECTS} 不存在` };
    return { agent: this.agent, ok: true };
  }

  async start(): Promise<void> {}

  async stop(): Promise<void> {
    for (const run of this.processes) run.child.kill("SIGTERM");
  }

  /** Claude.app keeps its own titles keyed by the CLI session id. */
  private desktopTitles(): Map<string, { title: string; archived: boolean }> {
    const titles = new Map<string, { title: string; archived: boolean }>();
    if (!existsSync(DESKTOP_SESSIONS)) return titles;
    for (const account of readdirSync(DESKTOP_SESSIONS)) {
      const accountDir = join(DESKTOP_SESSIONS, account);
      if (!statSync(accountDir).isDirectory()) continue;
      for (const org of readdirSync(accountDir)) {
        const orgDir = join(accountDir, org);
        if (!statSync(orgDir).isDirectory()) continue;
        for (const file of readdirSync(orgDir)) {
          if (!file.startsWith("local_") || !file.endsWith(".json")) continue;
          try {
            const data = JSON.parse(readFileSync(join(orgDir, file), "utf8"));
            if (data.cliSessionId && data.title) titles.set(data.cliSessionId, { title: data.title, archived: Boolean(data.isArchived) });
          } catch {
            // being rewritten
          }
        }
      }
    }
    return titles;
  }

  private metaFor(path: string, mtime: number, size: number): TranscriptMeta {
    const cached = this.meta.get(path);
    if (cached && cached.mtime === mtime && cached.size === size) return cached.meta;
    const meta = readMeta(path);
    this.meta.set(path, { mtime, size, meta });
    return meta;
  }

  async listSessions(): Promise<SessionSummary[]> {
    if (!existsSync(PROJECTS)) return [];
    const files: { id: string; path: string; mtime: number; size: number }[] = [];
    for (const dir of readdirSync(PROJECTS)) {
      if (this.hidden.some((part) => dir.includes(part))) continue;
      const projectDir = join(PROJECTS, dir);
      let names: string[];
      try {
        names = readdirSync(projectDir);
      } catch {
        continue;
      }
      for (const name of names) {
        if (!name.endsWith(".jsonl")) continue;
        const path = join(projectDir, name);
        const stat = statSync(path);
        if (!stat.isFile() || stat.size === 0) continue;
        files.push({ id: basename(name, ".jsonl"), path, mtime: stat.mtimeMs, size: stat.size });
      }
    }
    files.sort((left, right) => right.mtime - left.mtime);
    const titles = this.desktopTitles();
    const sessions: SessionSummary[] = [];
    for (const file of files.slice(0, 120)) {
      this.paths.set(file.id, file.path);
      const desktop = titles.get(file.id);
      if (desktop?.archived) continue;
      const meta = this.metaFor(file.path, file.mtime, file.size);
      if (meta.cwd && this.hidden.some((part) => meta.cwd!.includes(part))) continue;
      if (!meta.firstPrompt && !meta.title && !desktop) continue;
      const key = sessionKey(this.agent, file.id);
      sessions.push({
        id: key,
        agent: this.agent,
        nativeId: file.id,
        title: meta.customTitle || desktop?.title || meta.title || firstLine(meta.firstPrompt ?? "") || "(无标题)",
        cwd: meta.cwd,
        updatedAt: file.mtime,
        status: this.hub.liveStatus(key) ?? (this.runs.get(file.id)?.busy ? "running" : "idle"),
      });
    }
    return sessions;
  }

  private pathFor(sessionId: string): string | null {
    const known = this.paths.get(sessionId);
    if (!existsSync(PROJECTS)) return null;
    if (known && existsSync(known)) return known;
    for (const dir of readdirSync(PROJECTS)) {
      const path = join(PROJECTS, dir, `${sessionId}.jsonl`);
      if (existsSync(path)) {
        this.paths.set(sessionId, path);
        return path;
      }
    }
    return null;
  }

  async history(sessionId: string, before: string | null): Promise<History> {
    const path = this.pathFor(sessionId);
    if (!path) throw new Error("找不到该 Claude 会话文件");
    const items = parseTranscript(path);
    const end = before ? Math.min(Number(before), items.length) : items.length;
    const start = Math.max(0, end - PAGE);
    // Live runs know tool calls still in flight; the file shows them unanswered.
    const run = this.runs.get(sessionId);
    const page = items.slice(start, end).map((item) => {
      const live = run?.builder.tools.get(item.id);
      return live ? { ...item, tool: { ...live } } : item;
    });
    return { items: page, before: start > 0 ? String(start) : null };
  }

  private cwdFor(sessionId: string): string {
    const path = this.pathFor(sessionId);
    const cwd = path ? readMeta(path).cwd : null;
    if (!cwd) throw new Error("无法确定该会话的工作目录");
    if (!existsSync(cwd)) throw new Error(`工作目录已不存在: ${cwd}`);
    return cwd;
  }

  private modelCatalog(): Promise<{ models: SessionConfig["models"]; permissionModes: SessionConfig["permissionModes"] }> {
    if (this.catalog) return this.catalog;
    if (!this.bin) return Promise.reject(new Error("未找到 claude"));
    const bin = this.bin;
    this.catalog = (async () => {
      const help = await new Promise<string>((resolve, reject) => execFile(bin, ["--help"], { timeout: 15_000 }, (error, stdout) => error ? reject(error) : resolve(stdout)));
      const section = help.slice(help.indexOf("--permission-mode"), help.indexOf("--permission-mode") + 550);
      const choices = section.match(/choices:\s*([\s\S]*?)\)/)?.[1] ?? "";
      const labels: Record<string, string> = { default: "默认审批", manual: "手动审批", acceptEdits: "自动接受编辑", auto: "自动判断", plan: "规划模式", dontAsk: "不询问（需审批时拒绝）", bypassPermissions: "跳过权限检查" };
      const permissionModes = [...choices.matchAll(/"([^"]+)"/g)].map((match) => match[1])
        .filter((value) => value !== "bypassPermissions" || help.includes("--allow-dangerously-skip-permissions"))
        .map((value) => ({ value, label: labels[value] ?? value }));
      const data = await new Promise<Json>((resolve, reject) => {
        // Initialize only: no user message, no existing session, no saved transcript.
        const child = spawn(bin, ["-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose", "--permission-prompt-tool", "stdio", "--no-session-persistence"], {
          cwd: process.cwd(), env: { ...process.env, CLAUDE_CODE_ENTRYPOINT: "sdk-ts" }, stdio: ["pipe", "pipe", "pipe"],
        });
        let stderr = "";
        let settled = false;
        const timer = setTimeout(() => finish(new Error(`Claude 模型列表初始化超时 ${stderr.slice(-200)}`)), 20_000);
        const finish = (error: Error | null, value?: Json) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          child.kill("SIGTERM");
          if (error) reject(error); else resolve(value!);
        };
        child.stderr.on("data", (chunk: Buffer) => { stderr = (stderr + chunk.toString()).slice(-1000); });
        child.stdin.on("error", (error) => finish(error));
        child.on("error", (error) => finish(error));
        child.on("exit", (code) => finish(new Error(`Claude 模型列表初始化失败 (${code}) ${stderr.slice(-200)}`)));
        createInterface({ input: child.stdout }).on("line", (line) => {
          let message: Json;
          try { message = JSON.parse(line); } catch { return; }
          if (message.type !== "control_response" || message.response?.request_id !== "configuration") return;
          if (message.response.subtype !== "success") finish(new Error(message.response.error ?? "Claude 初始化失败"));
          else finish(null, message.response.response);
        });
        child.stdin.write(`${JSON.stringify({ type: "control_request", request_id: "configuration", request: { subtype: "initialize" } })}\n`);
      });
      const models: SessionConfig["models"] = [];
      for (const model of data.models ?? []) {
        const option = { value: model.value, label: model.displayName ?? model.value, description: model.description,
          thinkingLevels: (model.supportedEffortLevels ?? []).map((value: string) => ({ value, label: value })) };
        if (!models.some((entry) => entry.value === option.value)) models.push(option);
        if (model.resolvedModel && !models.some((entry) => entry.value === model.resolvedModel)) models.push({ ...option, value: model.resolvedModel });
      }
      return { models, permissionModes };
    })().catch((error) => { this.catalog = null; throw error; });
    return this.catalog;
  }

  private nativeConfiguration(sessionId: string | null): SessionConfigPatch {
    let native: SessionConfigPatch = {};
    let cwd = process.cwd();
    const path = sessionId ? this.pathFor(sessionId) : null;
    if (path) cwd = readMeta(path).cwd ?? cwd;
    for (const file of [join(process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude"), "settings.json"), join(cwd, ".claude/settings.json"), join(cwd, ".claude/settings.local.json")]) {
      try {
        const settings = JSON.parse(readFileSync(file, "utf8"));
        if (typeof settings.model === "string") native.model = settings.model;
        if (typeof settings.effortLevel === "string") native.thinking = settings.effortLevel;
        if (typeof settings.permissions?.defaultMode === "string") native.permissionMode = settings.permissions.defaultMode;
      } catch { /* Optional native settings. */ }
    }
    if (path) {
      for (const line of readFileSync(path, "utf8").split("\n")) {
        let entry: Json;
        try { entry = JSON.parse(line); } catch { continue; }
        if (entry.isSidechain) continue;
        if (entry.type === "assistant" && typeof entry.message?.model === "string" && entry.message.model !== "<synthetic>") native.model = entry.message.model;
        if (typeof entry.permissionMode === "string") native.permissionMode = entry.permissionMode;
        if (typeof entry.effortLevel === "string") native.thinking = entry.effortLevel;
      }
    }
    if (sessionId) native = { ...native, ...this.runs.get(sessionId)?.currentConfig };
    return native;
  }

  async configuration(sessionId: string | null): Promise<SessionConfig> {
    const catalog = await this.modelCatalog();
    const native = this.nativeConfiguration(sessionId);
    const patch = sessionId ? this.overrides.get(sessionId) : undefined;
    return { model: patch?.model !== undefined ? patch.model : native.model ?? null,
      thinking: patch?.thinking !== undefined ? patch.thinking : native.thinking ?? null,
      permissionMode: patch?.permissionMode !== undefined ? patch.permissionMode : native.permissionMode ?? null,
      effectivePermissionMode: this.runs.get(sessionId ?? "")?.currentConfig.permissionMode ?? native.permissionMode ?? null,
      ...catalog, notice: "配置在下一次发送时生效；空值继承 CLI 设置。原生历史中的模型/权限为最近一次记录，CLI 启动后可能受托管设置影响。" };
  }

  private validateConfiguration(patch: SessionConfigPatch, config: SessionConfig): void {
    validateConfigPatch(patch, { ...config, model: config.model ?? (config.models.some((model) => model.value === "default") ? "default" : null) });
    if (patch.model && patch.thinking === undefined) {
      const thinking = config.thinking;
      const model = config.models.find((model) => model.value === patch.model);
      if (thinking && !model?.thinkingLevels.some((level) => level.value === thinking)) throw invalidConfig("请同时选择新模型支持的思考程度，或设为继承");
    }
  }

  private saveConfig(): void {
    mkdirSync(dirname(this.configPath), { recursive: true, mode: 0o700 });
    const temporary = `${this.configPath}.${process.pid}.tmp`;
    writeFileSync(temporary, JSON.stringify(Object.fromEntries(this.overrides)), { mode: 0o600 });
    renameSync(temporary, this.configPath);
  }

  async configure(sessionId: string, patch: SessionConfigPatch): Promise<SessionConfig> {
    const assertIdle = () => {
      const run = this.runs.get(sessionId);
      if (run?.busy || run?.controls.size || ["running", "approval"].includes(this.hub.liveStatus(sessionKey(this.agent, sessionId)) ?? "")) throw Object.assign(new Error("Claude 正在运行，请先停止当前回合"), { status: 409 });
    };
    assertIdle();
    this.cwdFor(sessionId);
    const config = await this.configuration(sessionId);
    const native = this.nativeConfiguration(sessionId);
    const inheritedModel = native.model ?? (config.models.some((model) => model.value === "default") ? "default" : null);
    const validation = { ...config, model: config.model ?? inheritedModel };
    this.validateConfiguration(patch, validation);
    if (patch.model === null && patch.thinking != null) validateConfigPatch({ thinking: patch.thinking }, { ...validation, model: inheritedModel });
    assertIdle();
    this.overrides.set(sessionId, { ...this.overrides.get(sessionId), ...patch });
    this.saveConfig();
    const run = this.runs.get(sessionId);
    if (run?.alive) {
      // Wait for our idle process to exit before another resume can use its file.
      if (run.idleTimer) clearTimeout(run.idleTimer);
      const retired = new Promise<void>((resolve) => run.child.once("exit", () => resolve()));
      this.retiring.set(sessionId, retired);
      this.runs.delete(sessionId);
      run.child.kill("SIGTERM");
      await retired;
      this.retiring.delete(sessionId);
    }
    return this.configuration(sessionId);
  }

  private launch(cwd: string, resume: string | null, config: SessionConfigPatch = {}): ClaudeRun {
    if (!this.bin) throw new Error("未找到 claude");
    const run = new ClaudeRun(this.bin, cwd, resume, resume ? this.overrides.get(resume) : config);
    this.processes.add(run);
    if (resume) this.runs.set(resume, run);
    createInterface({ input: run.child.stdout }).on("line", (line) => {
      let message: Json;
      try {
        message = JSON.parse(line);
      } catch {
        return;
      }
      this.onMessage(run, message);
    });
    run.child.on("exit", (code) => this.onExit(run, code));
    run.child.on("error", (error) => {
      run.stderrTail = error.message;
      this.onExit(run, -1);
    });
    return run;
  }

  private key(run: ClaudeRun): string {
    return sessionKey(this.agent, run.sessionId ?? "pending");
  }

  private armIdle(run: ClaudeRun): void {
    if (run.idleTimer) clearTimeout(run.idleTimer);
    run.idleTimer = setTimeout(() => {
      if (!run.busy && run.controls.size === 0) run.child.stdin.end();
    }, IDLE_EXIT_MS);
  }

  private onMessage(run: ClaudeRun, message: Json): void {
    switch (message.type) {
      case "system":
        if (message.subtype === "init" && message.session_id) {
          run.currentConfig = { model: message.model ?? null, permissionMode: message.permissionMode ?? null };
          if (run.sessionId && run.sessionId !== message.session_id) this.runs.delete(run.sessionId);
          run.sessionId = message.session_id;
          this.runs.set(message.session_id, run);
          run.onInit?.(message.session_id);
          run.onInit = null;
          this.hub.status(this.key(run), "running");
        }
        break;
      case "user":
      case "assistant":
        for (const item of run.builder.add(message)) this.hub.item(this.key(run), item);
        break;
      case "result":
        for (const item of run.builder.finishPending("回合已结束，工具未返回结果")) this.hub.item(this.key(run), item);
        run.busy = false;
        this.hub.status(this.key(run), "idle");
        for (const item of run.builder.add(message)) this.hub.item(this.key(run), item);
        this.hub.sessionsChanged();
        this.armIdle(run);
        break;
      case "error":
        this.hub.notice("error", errorText(message, "Claude 请求失败"), run.sessionId ? this.key(run) : undefined);
        break;
      case "system_error":
        this.hub.notice("error", errorText(message, "Claude 系统错误"), run.sessionId ? this.key(run) : undefined);
        break;
      case "control_request":
        if (message.request?.subtype === "can_use_tool") this.onPermission(run, message.request_id, message.request);
        else run.write({ type: "control_response", response: { subtype: "error", request_id: message.request_id, error: "unsupported" } });
        break;
      case "control_cancel_request": {
        const id = `claude:${message.request_id}`;
        const toolUseId = run.controls.get(message.request_id)?.toolUseId;
        if (toolUseId) {
          const item = run.builder.cancel(toolUseId, "工具权限请求已取消");
          if (item) this.hub.item(this.key(run), item);
        }
        this.approvals.delete(id);
        run.controls.delete(message.request_id);
        this.hub.resolveApproval(id);
        break;
      }
    }
  }

  private onPermission(run: ClaudeRun, requestId: string, request: Json): void {
    const control: Control = { requestId, toolName: request.tool_name, toolUseId: request.tool_use_id, input: request.input ?? {}, suggestions: request.permission_suggestions };
    run.controls.set(requestId, control);
    const id = `claude:${requestId}`;
    this.approvals.set(id, { run, control });
    const base = { id, sessionId: this.key(run), agent: this.agent, createdAt: Date.now() };
    let approval: Approval;
    if (control.toolName === "AskUserQuestion" && Array.isArray(control.input.questions)) {
      approval = {
        ...base,
        title: "Claude 提问",
        detail: "",
        choices: [{ id: "submit", label: "提交", tone: "primary" }, { id: "deny", label: "跳过", tone: "danger" }],
        questions: (control.input.questions as Json[]).map((question, index) => ({
          id: String(index),
          header: question.header ?? "",
          multiSelect: Boolean(question.multiSelect),
          question: question.question ?? "",
          options: (question.options ?? []).map((option: Json) => ({ label: option.label, description: option.description })),
          allowOther: true,
        })),
      };
    } else {
      approval = {
        ...base,
        title: `使用工具 ${control.toolName}`,
        detail: toolInput(control.toolName, control.input),
        choices: [
          { id: "allow", label: "允许", tone: "primary" },
          ...(control.suggestions ? [{ id: "always", label: "总是允许" }] : []),
          { id: "deny", label: "拒绝", tone: "danger" },
        ],
      };
    }
    this.hub.addApproval(approval);
  }

  private onExit(run: ClaudeRun, code: number | null): void {
    if (run.exited) return;
    run.exited = true;
    for (const item of run.builder.finishPending("Claude 进程已退出，工具执行中断")) this.hub.item(this.key(run), item);
    this.processes.delete(run);
    if (run.idleTimer) clearTimeout(run.idleTimer);
    if (run.sessionId && this.runs.get(run.sessionId) === run) this.runs.delete(run.sessionId);
    for (const control of run.controls.values()) {
      this.approvals.delete(`claude:${control.requestId}`);
      this.hub.resolveApproval(`claude:${control.requestId}`);
    }
    run.controls.clear();
    if (run.sessionId && !this.runs.has(run.sessionId)) this.hub.status(this.key(run), "idle");
    if (run.busy || code) {
      const detail = run.stderrTail.trim().split("\n").slice(-3).join("\n");
      this.hub.notice("error", `Claude 进程退出 (${code})${detail ? `: ${detail}` : ""}`, run.sessionId ? this.key(run) : undefined);
    }
    this.hub.sessionsChanged();
  }

  async send(sessionId: string, text: string): Promise<void> {
    await this.retiring.get(sessionId);
    let run = this.runs.get(sessionId);
    if (!run?.alive) run = this.launch(this.cwdFor(sessionId), sessionId);
    if (run.busy) throw Object.assign(new Error("Claude 正在运行，请先停止当前回合"), { status: 409 });
    run.sendUser(text);
    this.hub.status(sessionKey(this.agent, sessionId), "running");
  }

  async create(cwd: string, text: string, config: SessionConfigPatch = {}): Promise<string> {
    if (!existsSync(cwd)) throw new Error(`目录不存在: ${cwd}`);
    this.validateConfiguration(config, await this.configuration(null));
    const run = this.launch(cwd, null, config);
    const sessionId = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        run.onInit = null;
        run.child.kill("SIGTERM");
        reject(new Error(`Claude 启动超时 ${run.stderrTail.slice(-300)}`));
      }, 60_000);
      run.onInit = (id) => {
        clearTimeout(timer);
        resolve(id);
      };
      run.child.once("exit", (code) => {
        clearTimeout(timer);
        reject(new Error(`Claude 退出 (${code}) ${run.stderrTail.slice(-300)}`));
      });
      run.child.once("error", (error) => { clearTimeout(timer); reject(error); });
      run.sendUser(text);
    });
    this.hub.sessionsChanged();
    if (Object.keys(config).length) {
      this.overrides.set(sessionId, config);
      this.saveConfig();
    }
    return sessionId;
  }

  private assertIdle(sessionId: string): string {
    const run = this.runs.get(sessionId);
    const live = this.hub.liveStatus(sessionKey(this.agent, sessionId));
    if (run?.busy || live === "running" || live === "approval") throw Object.assign(new Error("会话正在运行或等待审批，请先停止当前回合"), { status: 409 });
    const path = this.pathFor(sessionId);
    if (!path) throw Object.assign(new Error("找不到该 Claude 会话文件"), { status: 404 });
    return path;
  }

  /** Same record Claude Code's /rename appends; it outranks the Claude.app title. */
  async rename(sessionId: string, title: string): Promise<void> {
    const path = this.assertIdle(sessionId);
    appendFileSync(path, JSON.stringify({ type: "custom-title", customTitle: title, sessionId }) + "\n");
    this.meta.delete(path);
    this.hub.sessionsChanged();
  }

  /** Move the transcript (and its sidecar folder) to the relay trash. */
  async remove(sessionId: string): Promise<void> {
    const path = this.assertIdle(sessionId);
    const run = this.runs.get(sessionId);
    if (run?.alive) run.child.kill("SIGTERM");
    moveToTrash(path, this.agent);
    const folder = path.slice(0, -".jsonl".length);
    if (existsSync(folder) && statSync(folder).isDirectory()) moveToTrash(folder, this.agent);
    this.paths.delete(sessionId);
    this.meta.delete(path);
    if (this.overrides.delete(sessionId)) this.saveConfig();
    this.hub.forget(sessionKey(this.agent, sessionId));
  }

  async interrupt(sessionId: string): Promise<void> {
    const run = this.runs.get(sessionId);
    if (!run?.alive || !run.busy) throw new Error("没有正在运行的回合");
    run.write({ type: "control_request", request_id: randomUUID(), request: { subtype: "interrupt" } });
  }

  async resolve(approvalId: string, answer: ApprovalAnswer): Promise<void> {
    const entry = this.approvals.get(approvalId);
    if (!entry || !entry.run.alive) throw new Error("审批已失效");
    const { run, control } = entry;
    let response: Json;
    if (answer.choice === "deny") {
      response = { behavior: "deny", message: "用户在网页上拒绝了此操作" };
      if (control.toolUseId) {
        const item = run.builder.deny(control.toolUseId, response.message);
        if (item) this.hub.item(this.key(run), item);
      }
    } else if (control.toolName === "AskUserQuestion") {
      const questions: Json[] = control.input.questions ?? [];
      const answers: Record<string, string> = {};
      questions.forEach((question, index) => {
        const picked = answer.answers?.[String(index)];
        if (picked?.length && question.question) answers[question.question] = picked.join(",");
      });
      response = { behavior: "allow", updatedInput: { ...control.input, answers } };
    } else {
      response = {
        behavior: "allow",
        updatedInput: control.input,
        ...(answer.choice === "always" && control.suggestions ? { updatedPermissions: control.suggestions } : {}),
      };
    }
    run.write({ type: "control_response", response: { subtype: "success", request_id: control.requestId, response } });
    run.controls.delete(control.requestId);
    this.approvals.delete(approvalId);
    this.hub.resolveApproval(approvalId);
  }
}
