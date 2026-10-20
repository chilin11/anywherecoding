import type {
  AgentAvailability,
  Agent,
  Connection,
  ApprovalAnswer,
  DirListing,
  History,
  RelayEvent,
  SessionSummary,
} from "../../server/types.ts";
import type { SessionConfig, SessionConfigPatch } from "../../server/session-config.ts";

export class ApiError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

async function call<T>(path: string, init: { method?: string; body?: unknown; signal?: AbortSignal } = {}): Promise<T> {
  const response = await fetch(path, {
    method: init.method ?? "GET",
    credentials: "same-origin",
    headers: init.body === undefined ? undefined : { "content-type": "application/json" },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
    signal: init.signal,
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new ApiError(response.status, data.error ?? response.statusText);
  return data as T;
}

const enc = encodeURIComponent;

export const api = {
  login: (token: string) => call<{ ok: true }>("/api/login", { method: "POST", body: { token } }),
  logout: () => call<{ ok: true }>("/api/logout", { method: "POST" }),
  me: () => call<{ ok: true; agents: AgentAvailability[]; roots: string[] }>("/api/me"),
  connections: () => call<{ connections: Connection[] }>("/api/connections"),
  detectConnection: (agent: Agent) => call<AgentAvailability>(`/api/connections/${enc(agent)}/detect`, { method: "POST" }),
  addConnection: (agent: Agent) => call<{ connections: Connection[] }>(`/api/connections/${enc(agent)}`, { method: "POST" }),
  removeConnection: (agent: Agent) => call<{ connections: Connection[] }>(`/api/connections/${enc(agent)}`, { method: "DELETE" }),
  sessions: () =>
    call<{ sessions: SessionSummary[]; errors: Record<string, string>; agents: AgentAvailability[] }>("/api/sessions"),
  history: (id: string, before: string | null) =>
    call<History>(`/api/sessions/${enc(id)}/history${before ? `?before=${enc(before)}` : ""}`),
  renameSession: (id: string, title: string) => call<{ ok: true }>(`/api/sessions/${enc(id)}`, { method: "PATCH", body: { title } }),
  deleteSession: (id: string) => call<{ ok: true }>(`/api/sessions/${enc(id)}`, { method: "DELETE" }),
  send: (id: string, text: string) => call<{ ok: true }>(`/api/sessions/${enc(id)}/send`, { method: "POST", body: { text } }),
  interrupt: (id: string) => call<{ ok: true }>(`/api/sessions/${enc(id)}/interrupt`, { method: "POST" }),
  watch: (id: string) => call<{ ok: true }>(`/api/sessions/${enc(id)}/watch`, { method: "POST" }),
  agentConfiguration: (agent: string, signal?: AbortSignal) =>
    call<SessionConfig>(`/api/agents/${enc(agent)}/configuration`, { signal }),
  sessionConfiguration: (id: string, signal?: AbortSignal) =>
    call<SessionConfig>(`/api/sessions/${enc(id)}/configuration`, { signal }),
  updateSessionConfiguration: (id: string, config: SessionConfigPatch) =>
    call<SessionConfig>(`/api/sessions/${enc(id)}/configuration`, { method: "POST", body: config }),
  create: (agent: string, cwd: string, text: string, config?: SessionConfigPatch) =>
    call<{ id: string }>("/api/sessions", { method: "POST", body: { agent, cwd, text, config } }),
  resolve: (id: string, answer: ApprovalAnswer) =>
    call<{ ok: true }>(`/api/approvals/${enc(id)}`, { method: "POST", body: answer }),
  dirs: (path: string | null, hidden = false, signal?: AbortSignal) =>
    call<DirListing>(`/api/fs?${path ? `path=${enc(path)}&` : ""}${hidden ? "hidden=1" : ""}`, { signal }),
  createDir: (parent: string, name: string) =>
    call<DirListing>("/api/fs", { method: "POST", body: { parent, name } }),
};

/** The server pings every 20s; a stream quiet for longer is dead even if it still looks open. */
const STALE_MS = 50_000;
/** Returning after this long in the background resubscribes, resyncing anything a frozen tab missed. */
const AWAY_MS = 30_000;

/**
 * Live event stream that survives background tabs, sleep and proxies: `onOpen` fires on every
 * (re)connect so callers can resync.
 */
export function subscribe(onEvent: (event: RelayEvent) => void, onOpen: () => void, onDown: () => void): () => void {
  let source: EventSource | null = null;
  let last = Date.now();
  let hiddenAt = document.hidden ? Date.now() : 0;
  let retry: ReturnType<typeof setTimeout> | undefined;
  let backoff = 1000;
  let closed = false;

  const connect = () => {
    clearTimeout(retry);
    source?.close();
    source = null;
    if (closed) return;
    last = Date.now();
    const current = new EventSource("/api/events", { withCredentials: true });
    source = current;
    const alive = () => {
      if (source !== current) return false;
      last = Date.now();
      return true;
    };
    current.onopen = () => {
      if (!alive()) return;
      backoff = 1000;
      onOpen();
    };
    current.addEventListener("ping", alive);
    current.onmessage = (message) => {
      if (!alive()) return;
      try {
        onEvent(JSON.parse(message.data));
      } catch {
        // ignore malformed frames
      }
    };
    current.onerror = () => {
      if (source !== current) return;
      onDown();
      // The browser retries by itself, except after a non-stream response (proxy error, expired login).
      if (current.readyState !== EventSource.CLOSED) return;
      retry = setTimeout(() => {
        api.me().then(connect, (error) => (error instanceof ApiError && error.status === 401 ? location.reload() : connect()));
      }, backoff);
      backoff = Math.min(backoff * 2, 30_000);
    };
  };

  const wake = (force: boolean) => {
    if (closed) return;
    if (force || !source || source.readyState === EventSource.CLOSED || Date.now() - last > STALE_MS) connect();
  };
  const onVisibility = () => {
    if (document.hidden) {
      hiddenAt = Date.now();
      return;
    }
    const away = hiddenAt > 0 && Date.now() - hiddenAt > AWAY_MS;
    hiddenAt = 0;
    wake(away);
  };
  const onShow = (event: PageTransitionEvent) => wake(event.persisted);
  const onResume = () => wake(true);
  const watchdog = setInterval(() => {
    if (!document.hidden) wake(false);
  }, 10_000);
  document.addEventListener("visibilitychange", onVisibility);
  document.addEventListener("resume", onResume);
  addEventListener("pageshow", onShow);
  addEventListener("online", onResume);
  connect();

  return () => {
    closed = true;
    clearTimeout(retry);
    clearInterval(watchdog);
    document.removeEventListener("visibilitychange", onVisibility);
    document.removeEventListener("resume", onResume);
    removeEventListener("pageshow", onShow);
    removeEventListener("online", onResume);
    source?.close();
    source = null;
  };
}
