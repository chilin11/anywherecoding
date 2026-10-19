import type { Agent, AgentAvailability, Approval, SessionStatus, SessionSummary } from "./types.ts";

export type ActiveSession = {
  id: string;
  agent: Agent;
  title: string;
  cwd: string | null;
  status: Extract<SessionStatus, "running" | "approval">;
  updatedAt: number;
};

/** Compact activity snapshot for the macOS menu bar and other lightweight clients. */
export type StatusSnapshot = {
  version: string;
  running: number;
  approval: number;
  unknown: number;
  active: ActiveSession[];
  agents: AgentAvailability[];
  errors: Record<string, string>;
};

const ACTIVE_LIMIT = 20;

/** Same counting as the web page: a pending approval overrides the session's reported status. */
export function summarize(
  sessions: SessionSummary[],
  approvals: Approval[],
  agents: AgentAvailability[],
  errors: Record<string, string>,
  version: string,
): StatusSnapshot {
  const waiting = new Set(approvals.map((approval) => approval.sessionId));
  const seen = new Set<string>();
  const active: ActiveSession[] = [];
  let running = 0;
  let approval = 0;
  let unknown = 0;
  for (const session of sessions) {
    if (seen.has(session.id)) continue;
    seen.add(session.id);
    const status = waiting.has(session.id) ? "approval" : session.status;
    if (status === "running") running++;
    else if (status === "approval") approval++;
    else if (status === "unknown") unknown++;
    if (status === "running" || status === "approval") {
      active.push({ id: session.id, agent: session.agent, title: session.title, cwd: session.cwd, status, updatedAt: session.updatedAt });
    }
  }
  for (const request of approvals) {
    if (seen.has(request.sessionId)) continue;
    seen.add(request.sessionId);
    approval++;
    active.push({ id: request.sessionId, agent: request.agent, title: request.title, cwd: null, status: "approval", updatedAt: request.createdAt });
  }
  active.sort((left, right) => (left.status === right.status ? right.updatedAt - left.updatedAt : left.status === "approval" ? -1 : 1));
  return { version, running, approval, unknown, active: active.slice(0, ACTIVE_LIMIT), agents, errors };
}
