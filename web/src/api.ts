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

/** EventSource reconnects by itself; `onOpen` fires on every (re)connect so callers can resync. */
export function subscribe(onEvent: (event: RelayEvent) => void, onOpen: () => void, onDown: () => void): () => void {
  const source = new EventSource("/api/events", { withCredentials: true });
  source.onopen = onOpen;
  source.onerror = onDown;
  source.onmessage = (message) => {
    try {
      onEvent(JSON.parse(message.data));
    } catch {
      // ignore malformed frames
    }
  };
  return () => source.close();
}
