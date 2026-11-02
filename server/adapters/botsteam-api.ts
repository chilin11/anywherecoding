export type BotsTeamOptions = { url?: string; token?: string };
export class BotsTeamError extends Error {
  readonly status: number;
  constructor(message: string, status = 502) { super(message); this.status = status; }
}
export class StreamLimitError extends BotsTeamError {
  constructor() { super("BotsTeam 事件或历史超过同步大小限制，已暂停同步；请在原工作台查看完整历史", 413); }
}
const LIMIT = 32 * 1024 * 1024;
const EVENT_LIMIT = 12 * 1024 * 1024;

export function botsTeamOrigin(value = "http://127.0.0.1:8099"): { origin: string; remote: boolean } {
  let url: URL;
  try { url = new URL(value); } catch { throw new BotsTeamError("BotsTeam 地址无效，请填写根地址", 400); }
  if (url.username || url.password || url.pathname !== "/" || url.search || url.hash || !["http:", "https:"].includes(url.protocol)) throw new BotsTeamError("BotsTeam 需要不含路径、账号或查询参数的 HTTP(S) 根地址", 400);
  const remote = !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
  if (remote && url.protocol !== "https:") throw new BotsTeamError("远端 BotsTeam 只允许 HTTPS；HTTP 仅限真实 loopback", 400);
  return { origin: url.origin, remote };
}

/** Numeric ids persist across frames; an oversized frame is terminal, not reconnectable. */
export async function readBotsTeamSse(body: ReadableStream<Uint8Array>, onFrame: (id: number, type: string, data: string) => void, activity: () => void = () => {}): Promise<void> {
  let parts: Buffer[] = [], size = 0, frameBytes = 0, id = 0, type = "", data: string[] = [], skipLf = false, first = true;
  const dispatch = () => { if (data.length) onFrame(id, type || "message", data.join("\n")); data = []; type = ""; frameBytes = 0; };
  const line = () => {
    let text = Buffer.concat(parts, size).toString("utf8"); parts = []; size = 0;
    if (first) { first = false; text = text.replace(/^\uFEFF/, ""); }
    if (!text) { dispatch(); return; }
    frameBytes += Buffer.byteLength(text) + 1;
    if (frameBytes > EVENT_LIMIT) throw new StreamLimitError();
    if (text.startsWith(":")) return;
    const at = text.indexOf(":"), field = at < 0 ? text : text.slice(0, at);
    const value = at < 0 ? "" : text.slice(at + 1).replace(/^ /, "");
    if (field === "data") data.push(value);
    if (field === "event") type = value;
    if (field === "id" && /^\d+$/.test(value) && Number.isSafeInteger(Number(value))) id = Number(value);
  };
  const append = (part: Buffer) => {
    if (!part.length) return;
    size += part.length;
    if (size > EVENT_LIMIT || frameBytes + size > EVENT_LIMIT) throw new StreamLimitError();
    parts.push(part);
  };
  for await (const chunk of body) {
    activity();
    const bytes = Buffer.from(chunk); let start = 0;
    for (let i = 0; i < bytes.length; i++) {
      if (skipLf) { skipLf = false; if (bytes[i] === 10) { start = i + 1; continue; } }
      if (bytes[i] !== 10 && bytes[i] !== 13) continue;
      append(bytes.subarray(start, i)); line(); skipLf = bytes[i] === 13; start = i + 1;
    }
    append(bytes.subarray(start));
  }
  if (size) line(); dispatch();
}

export class BotsTeamApi {
  readonly origin: string;
  readonly remote: boolean;
  private readonly token: string;
  private cookie = "";
  private csrf = "";
  private readonly closed = new AbortController();
  private login: Promise<void> | null = null;
  constructor(options: BotsTeamOptions = {}) {
    const parsed = botsTeamOrigin(options.url); this.origin = parsed.origin; this.remote = parsed.remote;
    this.token = options.token ?? "";
    if (parsed.remote && (!this.token || this.token.length > 512 || /[\r\n]/.test(this.token))) throw new BotsTeamError("远端 BotsTeam 需要在服务端 config.json 配置远程 Token", 400);
  }
  close(): void { this.cookie = ""; this.csrf = ""; this.closed.abort(); }
  private async fetch(path: string, method: string, body?: unknown, signal?: AbortSignal): Promise<Response> {
    if (this.closed.signal.aborted) throw new BotsTeamError("BotsTeam 连接已关闭", 503);
    if (!path.startsWith("/api/") || /[\r\n#]/.test(path)) throw new BotsTeamError("无效 BotsTeam API 路径", 400);
    const headers: Record<string, string> = { Accept: path.startsWith("/api/events?") ? "text/event-stream" : "application/json", Origin: this.origin };
    if (this.cookie) headers.Cookie = this.cookie;
    if (method !== "GET") { headers["Content-Type"] = "application/json"; if (this.csrf) headers["X-Botsteam-CSRF"] = this.csrf; }
    const serialized = body === undefined ? undefined : JSON.stringify(body);
    if (serialized && Buffer.byteLength(serialized) > 2 * 1024 * 1024) throw new BotsTeamError("BotsTeam 写请求超过 2 MiB", 413);
    try {
      const result = await fetch(this.origin + path, { method, headers, body: serialized, redirect: "error", signal: AbortSignal.any([this.closed.signal, signal ?? AbortSignal.timeout(15_000)]) });
      if (!result.ok) {
        await result.body?.cancel();
        const status = result.status;
        throw new BotsTeamError(status === 401 ? "BotsTeam 会话已过期或 Token 无效" : status === 403 ? "BotsTeam 拒绝访问，请检查远程开关或权限" : status === 409 ? "BotsTeam 状态已变化，请刷新后重试" : `BotsTeam 请求失败 (HTTP ${status})`, status);
      }
      return result;
    } catch (error) {
      if (error instanceof BotsTeamError) throw error;
      throw new BotsTeamError("BotsTeam 连接中断，请检查地址、证书和网络；写请求未自动重发");
    }
  }
  private async json(response: Response): Promise<any> {
    if (!/^application\/json(?:;|$)/i.test(response.headers.get("content-type") ?? "")) { await response.body?.cancel(); throw new BotsTeamError("BotsTeam 返回了非 JSON 响应"); }
    if (Number(response.headers.get("content-length")) > LIMIT) { await response.body?.cancel(); throw new BotsTeamError("BotsTeam JSON 响应超过 32 MiB", 413); }
    const parts: Uint8Array[] = []; let bytes = 0;
    if (!response.body) throw new BotsTeamError("BotsTeam 响应为空");
    try {
      for await (const part of response.body) { bytes += part.length; if (bytes > LIMIT) throw new BotsTeamError("BotsTeam JSON 响应超过 32 MiB", 413); parts.push(part); }
      return JSON.parse(Buffer.concat(parts).toString("utf8"));
    } catch (error) { if (error instanceof BotsTeamError) throw error; throw new BotsTeamError("BotsTeam JSON 响应不完整或无效"); }
  }
  async authenticate(): Promise<void> {
    if (this.cookie && this.csrf) return;
    if (this.login) return this.login;
    const pending = (async () => {
      this.cookie = ""; this.csrf = "";
      const response = await this.fetch(this.remote ? "/api/remote-access/login" : "/api/session", this.remote ? "POST" : "GET", this.remote ? { token: this.token } : undefined);
      const expected = this.remote ? "botsteam_remote_session" : "botsteam_session";
      const matching = response.headers.getSetCookie().filter((value) => value.startsWith(expected + "="));
      const value = matching[0];
      if (matching.length !== 1 || !value || !/^[^=]+=([A-Za-z0-9._~-]+);/.test(value) || /;\s*Domain=/i.test(value) || !/;\s*Path=\/(?:;|$)/i.test(value) || !/;\s*HttpOnly(?:;|$)/i.test(value) || !/;\s*SameSite=Strict(?:;|$)/i.test(value)) { await response.body?.cancel(); throw new BotsTeamError("BotsTeam 未返回安全的会话 Cookie"); }
      if (this.remote) {
        const age = /;\s*Max-Age=(\d+)(?:;|$)/i.exec(value);
        if (!/;\s*Secure(?:;|$)/i.test(value) || !age || Number(age[1]) <= 0 || Number(age[1]) > 30 * 86400) { await response.body?.cancel(); throw new BotsTeamError("BotsTeam 远程 Cookie 属性无效"); }
      }
      const data = await this.json(response);
      if (!data || typeof data.csrf !== "string" || !data.csrf || data.csrf.length > 1024 || /[\r\n]/.test(data.csrf) || (this.remote && data.remote !== true)) throw new BotsTeamError("BotsTeam 未确认有效会话");
      if (this.closed.signal.aborted) throw new BotsTeamError("BotsTeam 连接已关闭", 503);
      this.cookie = value.split(";")[0]!; this.csrf = data.csrf;
    })();
    this.login = pending;
    try { await pending; } finally { if (this.login === pending) this.login = null; }
  }
  async request(path: string, body?: unknown): Promise<any> {
    await this.authenticate();
    try { return await this.json(await this.fetch(path, body === undefined ? "GET" : "POST", body)); }
    catch (error) {
      if (error instanceof BotsTeamError && error.status === 401) {
        this.cookie = ""; this.csrf = "";
        if (body === undefined) { await this.authenticate(); return this.json(await this.fetch(path, "GET")); }
      }
      throw error;
    }
  }
  async array(path: string): Promise<Record<string, any>[]> {
    const value = await this.request(path);
    if (value === null) return [];
    if (!Array.isArray(value) || value.some((row) => !row || typeof row !== "object" || Array.isArray(row))) throw new BotsTeamError("BotsTeam 列表响应格式无效");
    return value;
  }
  async stream(project: string, after: number, signal: AbortSignal, onFrame: (id: number, type: string, data: string) => void): Promise<void> {
    await this.authenticate();
    const path = `/api/events?project_id=${encodeURIComponent(project)}&after_id=${after}`;
    const idle = new AbortController();
    let watchdog = setTimeout(() => idle.abort(), 45_000); watchdog.unref();
    const activity = () => { clearTimeout(watchdog); watchdog = setTimeout(() => idle.abort(), 45_000); watchdog.unref(); };
    try {
      let response: Response;
      try { response = await this.fetch(path, "GET", undefined, AbortSignal.any([signal, idle.signal])); }
      catch (error) { if (error instanceof BotsTeamError && error.status === 401) { this.cookie = ""; this.csrf = ""; } throw error; }
      if (!/^text\/event-stream(?:;|$)/i.test(response.headers.get("content-type") ?? "") || !response.body) { await response.body?.cancel(); throw new BotsTeamError("BotsTeam 未返回事件流"); }
      await readBotsTeamSse(response.body, onFrame, activity);
    } finally { clearTimeout(watchdog); }
  }
}
