import { existsSync, readFileSync, statSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { networkInterfaces, tmpdir } from "node:os";
import { dirname, extname, join, normalize, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { ClaudeAdapter } from "./adapters/claude.ts";
import { CodexAdapter } from "./adapters/codex.ts";
import { PiAdapter } from "./adapters/pi.ts";
import { PiNativeAdapter } from "./adapters/pi-native.ts";
import { Connections, parseAgent } from "./connections.ts";
import { Auth } from "./auth.ts";
import { CONFIG_FILE, DATA_DIR, loadConfig } from "./config.ts";
import { createDir, listDirs, resolveAllowed } from "./fsbrowse.ts";
import { Hub, splitKey, type Adapter } from "./hub.ts";
import type { Agent, ApprovalAnswer, RelayEvent, SessionSummary } from "./types.ts";
import { parseConfigPatch } from "./session-config.ts";
import { Media } from "./media.ts";

const config = loadConfig();
const auth = new Auth(config.token, config.cookieSecret);
const hub = new Hub();
const media = new Media(config.cookieSecret, [...config.roots, tmpdir(), ...(process.platform === "darwin" ? ["/tmp"] : [])]);
const sessionCwds = new Map<string, string | null>();
const connections = new Connections(join(DATA_DIR, "connections.json"), hub, (agent, target) => {
  switch (agent) {
    case "codex": return new CodexAdapter(target, config.codexBin);
    case "claude": return new ClaudeAdapter(target, config.claudeBin, config.claudeHiddenCwds);
    case "pi": return new PiAdapter(target, config.piDesktopDataDir);
    case "pi-native": return new PiNativeAdapter(target, config.piBin, config.piAgentDir);
  }
});
const adapters = connections.adapters;
hub.availability = () => connections.availability();

const WEB_DIST = join(dirname(fileURLToPath(import.meta.url)), "..", "web", "dist");
const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".json": "application/json",
  ".webmanifest": "application/manifest+json",
  ".woff2": "font/woff2",
};

class HttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

function securityHeaders(response: ServerResponse): void {
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("X-Frame-Options", "DENY");
  response.setHeader("Referrer-Policy", "no-referrer");
  response.setHeader(
    "Content-Security-Policy",
    "default-src 'self'; img-src 'self' data: blob: https: http:; style-src 'self' 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'",
  );
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  response.end(JSON.stringify(body));
}

async function readBody(request: IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    size += (chunk as Buffer).length;
    if (size > 1_000_000) throw new HttpError(413, "请求体过大");
    chunks.push(chunk as Buffer);
  }
  if (!size) return {};
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("object required");
    return value;
  } catch {
    throw new HttpError(400, "JSON 无效");
  }
}

function serveStatic(pathname: string, response: ServerResponse): void {
  if (!existsSync(WEB_DIST)) {
    response.writeHead(503, { "Content-Type": "text/plain; charset=utf-8" });
    response.end("前端尚未构建：运行 pnpm build");
    return;
  }
  const relative = normalize(decodeURIComponent(pathname)).replace(/^([/\\])+/, "");
  let file = join(WEB_DIST, relative);
  if (!file.startsWith(WEB_DIST + sep) && file !== WEB_DIST) throw new HttpError(404, "not found");
  if (!existsSync(file) || statSync(file).isDirectory()) file = join(WEB_DIST, "index.html");
  const hashed = file.includes(`${sep}assets${sep}`);
  response.writeHead(200, {
    "Content-Type": MIME[extname(file)] ?? "application/octet-stream",
    "Cache-Control": hashed ? "public, max-age=31536000, immutable" : "no-cache",
  });
  response.end(readFileSync(file));
}

function adapterFor(key: string): { adapter: Adapter; nativeId: string } {
  const parsed = splitKey(key);
  const adapter = parsed && adapters.get(parsed.agent);
  if (!parsed || !adapter) throw new HttpError(404, "未知会话");
  return { adapter, nativeId: parsed.nativeId };
}

async function listAll(): Promise<{ sessions: SessionSummary[]; errors: Record<string, string> }> {
  const errors: Record<string, string> = {};
  const results = await Promise.allSettled([...adapters.values()].map(async (adapter) => {
    try {
      const sessions = await adapter.listSessions();
      if (adapters.get(adapter.agent) !== adapter) return [];
      for (const session of sessions) sessionCwds.set(session.id, session.cwd);
      return sessions;
    } catch (error) {
      if (adapters.get(adapter.agent) === adapter) errors[adapter.agent] = adapter.availability().reason ?? (error as Error).message;
      return [];
    }
  }));
  const sessions = results.flatMap((result) => (result.status === "fulfilled" ? result.value : []));
  sessions.sort((left, right) => right.updatedAt - left.updatedAt);
  return { sessions, errors };
}

function openEvents(request: IncomingMessage, response: ServerResponse): void {
  response.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  response.write("retry: 3000\n\n");
  const send = (event: RelayEvent) => {
    const sessionId = "sessionId" in event ? event.sessionId : event.type === "approval" ? event.approval.sessionId : undefined;
    if (sessionId && !adapters.has(splitKey(sessionId)?.agent as Agent)) return;
    response.write(`data: ${JSON.stringify(event.type === "item" ? { ...event, item: media.item(event.item, sessionCwds.get(event.sessionId)) } : event)}\n\n`);
  };
  const unsubscribe = hub.subscribe(send);
  // Keeps cloudflared and mobile networks from idling the stream out; the client also uses it to detect dead streams.
  const ping = setInterval(() => response.write("event: ping\ndata: {}\n\n"), 20_000);
  request.on("close", () => {
    clearInterval(ping);
    unsubscribe();
  });
}

async function route(request: IncomingMessage, response: ServerResponse): Promise<void> {
  const url = new URL(request.url ?? "/", "http://local");
  const path = url.pathname;
  const method = request.method ?? "GET";

  if (!path.startsWith("/api/")) {
    if (method !== "GET" && method !== "HEAD") throw new HttpError(405, "method not allowed");
    serveStatic(path, response);
    return;
  }
  if (method !== "GET" && !auth.sameOrigin(request)) throw new HttpError(403, "跨站请求被拒绝");

  if (path === "/api/login" && method === "POST") {
    const body = await readBody(request);
    const result = auth.login(request, response, String(body.token ?? ""));
    if (result === "throttled") throw new HttpError(429, "尝试次数过多，请 15 分钟后再试");
    if (result === "bad") throw new HttpError(401, "令牌错误");
    sendJson(response, 200, { ok: true });
    return;
  }
  if (path === "/api/logout" && method === "POST") {
    auth.logout(response);
    sendJson(response, 200, { ok: true });
    return;
  }
  if (!auth.isAuthenticated(request)) throw new HttpError(401, "未登录");

  if (path === "/api/connections" && method === "GET") {
    sendJson(response, 200, { connections: connections.list() });
    return;
  }
  const connectionMatch = path.match(/^\/api\/connections\/([^/]+)(?:\/(detect))?$/);
  if (connectionMatch) {
    const agent = parseAgent(decodeURIComponent(connectionMatch[1]!));
    if (method === "POST" && connectionMatch[2] === "detect") sendJson(response, 200, await connections.detect(agent));
    else if (method === "POST" && !connectionMatch[2]) {
      await connections.add(agent);
      sendJson(response, 200, { connections: connections.list() });
    } else if (method === "DELETE" && !connectionMatch[2]) {
      await connections.remove(agent);
      sendJson(response, 200, { connections: connections.list() });
    } else throw new HttpError(405, "method not allowed");
    return;
  }

  if (path === "/api/media" && method === "GET") {
    const image = await media.read(url.searchParams.get("p") ?? "", url.searchParams.get("s") ?? "");
    response.writeHead(200, { "Content-Type": image.mime, "Content-Length": image.bytes.length, "Cache-Control": "private, max-age=300" });
    response.end(image.bytes);
    return;
  }
  if (path === "/api/me" && method === "GET") {
    sendJson(response, 200, { ok: true, agents: hub.availability(), roots: config.roots });
    return;
  }
  if (path === "/api/events" && method === "GET") {
    openEvents(request, response);
    return;
  }
  const agentConfigMatch = path.match(/^\/api\/agents\/([^/]+)\/configuration$/);
  if (agentConfigMatch && method === "GET") {
    const adapter = adapters.get(parseAgent(agentConfigMatch[1]));
    if (!adapter) throw new HttpError(404, "请先添加该连接");
    sendJson(response, 200, await adapter.configuration(null));
    return;
  }
  const configMatch = path.match(/^\/api\/sessions\/([^/]+)\/configuration$/);
  if (configMatch) {
    const { adapter, nativeId } = adapterFor(decodeURIComponent(configMatch[1]!));
    if (method === "GET") sendJson(response, 200, await adapter.configuration(nativeId));
    else if (method === "POST") sendJson(response, 200, await adapter.configure(nativeId, parseConfigPatch(await readBody(request))));
    else throw new HttpError(405, "method not allowed");
    return;
  }
  if (path === "/api/sessions" && method === "GET") {
    sendJson(response, 200, { ...(await listAll()), agents: hub.availability() });
    return;
  }
  if (path === "/api/sessions" && method === "POST") {
    const body = await readBody(request);
    const adapter = adapters.get(body.agent);
    if (!adapter) throw new HttpError(400, "未知 Agent");
    const text = String(body.text ?? "").trim();
    if (!text) throw new HttpError(400, "消息不能为空");
    const cwd = resolveAllowed(String(body.cwd ?? ""), config.roots);
    const selection = body.config === undefined ? undefined : parseConfigPatch(body.config);
    const nativeId = await adapter.create(cwd, text, selection);
    sessionCwds.set(`${adapter.agent}:${nativeId}`, cwd);
    sendJson(response, 200, { id: `${adapter.agent}:${nativeId}` });
    return;
  }
  const sessionMatch = path.match(/^\/api\/sessions\/([^/]+)\/(history|send|interrupt|watch)$/);
  if (sessionMatch) {
    const { adapter, nativeId } = adapterFor(decodeURIComponent(sessionMatch[1]!));
    const action = sessionMatch[2];
    if (action === "history" && method === "GET") {
      const history = await adapter.history(nativeId, url.searchParams.get("before"));
      const key = decodeURIComponent(sessionMatch[1]!);
      if (!sessionCwds.has(key)) await listAll();
      const items = url.searchParams.has("before") ? history.items : [...history.items, ...hub.errorItems(key).filter((error) => !history.items.some((item) => item.id === error.id))];
      sendJson(response, 200, { ...history, items: items.map((item) => media.item(item, sessionCwds.get(key))) });
      return;
    }
    if (method !== "POST") throw new HttpError(405, "method not allowed");
    if (action === "send") {
      const body = await readBody(request);
      const text = String(body.text ?? "").trim();
      if (!text) throw new HttpError(400, "消息不能为空");
      await adapter.send(nativeId, text);
    } else if (action === "interrupt") {
      await adapter.interrupt(nativeId);
    } else {
      adapter.watch?.(nativeId);
    }
    sendJson(response, 200, { ok: true });
    return;
  }
  const approvalMatch = path.match(/^\/api\/approvals\/([^/]+)$/);
  if (approvalMatch && method === "POST") {
    const id = decodeURIComponent(approvalMatch[1]!);
    const approval = hub.getApproval(id);
    if (!approval) throw new HttpError(404, "审批已失效");
    const body = (await readBody(request)) as ApprovalAnswer;
    if (!approval.choices.some((choice) => choice.id === body.choice)) throw new HttpError(400, "无效选项");
    if (body.answers !== undefined && (!body.answers || typeof body.answers !== "object" || Array.isArray(body.answers) || Object.values(body.answers).some((value) => !Array.isArray(value) || value.some((item) => typeof item !== "string")))) throw new HttpError(400, "答案格式无效");
    await adapters.get(approval.agent)!.resolve(id, { choice: body.choice, answers: body.answers });
    sendJson(response, 200, { ok: true });
    return;
  }
  if (path === "/api/fs" && method === "POST") {
    const body = await readBody(request);
    if (typeof body.parent !== "string" || typeof body.name !== "string") throw new HttpError(400, "请指定父目录和文件夹名称");
    sendJson(response, 200, createDir(body.parent, body.name, config.roots));
    return;
  }
  if (path === "/api/fs" && method === "GET") {
    sendJson(response, 200, listDirs(url.searchParams.get("path"), config.roots, url.searchParams.get("hidden") === "1"));
    return;
  }
  throw new HttpError(404, "not found");
}

const server = createServer((request, response) => {
  securityHeaders(response);
  route(request, response).catch((error: unknown) => {
    const proposed = Number((error as { status?: number }).status);
    const status = proposed >= 400 && proposed <= 499 ? proposed : error instanceof URIError ? 400 : 500;
    if (status === 500) console.error(error);
    if (!response.headersSent) sendJson(response, status, { error: (error as Error).message });
    else response.end();
  });
});
// SSE responses live for hours.
server.requestTimeout = 0;
server.headersTimeout = 30_000;

void connections.start().then(() => hub.sessionsChanged()).catch((error) => console.error("[connections]", error));

server.listen(config.port, config.host, () => {
  const lan = Object.values(networkInterfaces()).flat().find((address) => address && address.family === "IPv4" && !address.internal);
  console.log(`AnywhereCoding listening on http://${config.host}:${config.port}`);
  if (config.host === "0.0.0.0" && lan) console.log(`  LAN: http://${lan.address}:${config.port}`);
  console.log(`  login token: see ${CONFIG_FILE}`);
});

function shutdown(): void {
  server.close();
  void Promise.allSettled([...adapters.values()].map((adapter) => adapter.stop())).then(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
