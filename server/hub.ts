import { randomUUID } from "node:crypto";
import type {
  Agent,
  AgentAvailability,
  Approval,
  ApprovalAnswer,
  History,
  Item,
  RelayEvent,
  SessionStatus,
  SessionSummary,
} from "./types.ts";
import type { SessionConfig, SessionConfigPatch } from "./session-config.ts";

/** What each backend (Codex, Claude Code, PI-Desktop) implements. */
export interface Adapter {
  readonly agent: Agent;
  start(): Promise<void>;
  stop(): Promise<void>;
  availability(): AgentAvailability;
  listSessions(): Promise<SessionSummary[]>;
  history(nativeId: string, before: string | null): Promise<History>;
  send(nativeId: string, text: string): Promise<void>;
  create(cwd: string, text: string, config?: SessionConfigPatch): Promise<string>;
  configuration(nativeId: string | null): Promise<SessionConfig>;
  configure(nativeId: string, patch: SessionConfigPatch): Promise<SessionConfig>;
  interrupt(nativeId: string): Promise<void>;
  /** Set the native session title. */
  rename(nativeId: string, title: string): Promise<void>;
  /** Delete (or archive, where the client only archives) a session that is not running. */
  remove(nativeId: string): Promise<void>;
  resolve(approvalId: string, answer: ApprovalAnswer): Promise<void>;
  /** Hint that a client is looking at this session (polling adapters use it). */
  watch?(nativeId: string): void;
}

export function sessionKey(agent: Agent, nativeId: string): string {
  return `${agent}:${nativeId}`;
}

export function splitKey(key: string): { agent: Agent; nativeId: string } | null {
  const cut = key.indexOf(":");
  if (cut < 0) return null;
  const agent = key.slice(0, cut);
  if (agent !== "codex" && agent !== "claude" && agent !== "pi" && agent !== "pi-native") return null;
  return { agent, nativeId: key.slice(cut + 1) };
}

type Listener = (event: RelayEvent) => void;

/**
 * The adapters' single output: live events fan out to every SSE client, and
 * pending approvals and live statuses are remembered so a client that
 * (re)connects starts from the current state.
 */
export class Hub {
  private readonly listeners = new Set<Listener>();
  private readonly approvals = new Map<string, Approval>();
  private readonly statuses = new Map<string, SessionStatus>();
  private readonly errors = new Map<string, Item[]>();
  private sessionsTimer: NodeJS.Timeout | null = null;
  availability: () => AgentAvailability[] = () => [];

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    listener({ type: "hello", approvals: [...this.approvals.values()], agents: this.availability() });
    return () => this.listeners.delete(listener);
  }

  private emit(event: RelayEvent): void {
    for (const listener of this.listeners) listener(event);
  }

  item(sessionId: string, item: Item): void {
    if (item.kind === "error") {
      const previous = this.errors.get(sessionId) ?? [];
      this.errors.delete(sessionId);
      this.errors.set(sessionId, [...previous.filter((entry) => entry.id !== item.id), item].slice(-30));
      if (this.errors.size > 200) this.errors.delete(this.errors.keys().next().value!);
    }
    this.emit({ type: "item", sessionId, item });
  }

  errorItems(sessionId: string): Item[] { return this.errors.get(sessionId) ?? []; }

  /** Forget relay-side state of a deleted session. */
  forget(sessionId: string): void {
    for (const approval of [...this.approvals.values()]) if (approval.sessionId === sessionId) this.resolveApproval(approval.id);
    this.statuses.delete(sessionId);
    this.errors.delete(sessionId);
    this.sessionsChanged();
  }

  delta(sessionId: string, itemId: string, text: string): void {
    this.emit({ type: "delta", sessionId, itemId, text });
  }

  status(sessionId: string, status: SessionStatus): void {
    if (this.statuses.get(sessionId) === status) return;
    this.statuses.set(sessionId, status);
    this.emit({ type: "status", sessionId, status });
    this.sessionsChanged();
  }

  liveStatus(sessionId: string): SessionStatus | undefined {
    for (const approval of this.approvals.values()) {
      if (approval.sessionId === sessionId) return "approval";
    }
    return this.statuses.get(sessionId);
  }
  busy(agent: Agent): boolean {
    return [...this.statuses].some(([id, status]) => id.startsWith(`${agent}:`) && status === "running")
      || [...this.approvals.values()].some((approval) => approval.agent === agent);
  }

  clearAgent(agent: Agent): void {
    this.retainApprovals(agent, () => false);
    for (const id of this.statuses.keys()) if (id.startsWith(`${agent}:`)) this.statuses.delete(id);
    for (const id of this.errors.keys()) if (id.startsWith(`${agent}:`)) this.errors.delete(id);
    this.sessionsChanged();
  }

  addApproval(approval: Approval): void {
    this.approvals.set(approval.id, approval);
    this.emit({ type: "approval", approval });
    this.sessionsChanged();
  }

  resolveApproval(id: string): void {
    if (!this.approvals.delete(id)) return;
    this.emit({ type: "approvalResolved", id });
    this.sessionsChanged();
  }

  getApproval(id: string): Approval | undefined {
    return this.approvals.get(id);
  }

  pendingApprovals(): Approval[] {
    return [...this.approvals.values()];
  }

  /** Drop every approval an adapter no longer reports (e.g. its process exited). */
  retainApprovals(agent: Agent, keep: (approval: Approval) => boolean): void {
    for (const approval of [...this.approvals.values()]) {
      if (approval.agent === agent && !keep(approval)) this.resolveApproval(approval.id);
    }
  }

  notice(level: "info" | "error", message: string, sessionId?: string): void {
    if (level === "error" && sessionId) this.item(sessionId, { id: `relay-error:${randomUUID()}`, kind: "error", text: message, ts: Date.now() });
    this.emit({ type: "notice", level, message, ...(sessionId ? { sessionId } : {}) });
  }

  /** Coalesce list invalidations; clients refetch /api/sessions. */
  sessionsChanged(): void {
    if (this.sessionsTimer) return;
    this.sessionsTimer = setTimeout(() => {
      this.sessionsTimer = null;
      this.emit({ type: "sessions" });
    }, 300);
  }
}
