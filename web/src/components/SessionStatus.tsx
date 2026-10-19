import type { SessionStatus } from "../../../server/types.ts";
import type { Relay } from "../store.ts";
import { cx } from "../util.ts";

export function activityCounts(relay: Pick<Relay, "sessions" | "statusOf" | "approvals">) {
  let running = 0;
  let approval = 0;
  let unknown = 0;
  const seen = new Set<string>();
  for (const session of relay.sessions) {
    if (seen.has(session.id)) continue;
    seen.add(session.id);
    const status = relay.statusOf(session);
    if (status === "running") running++;
    if (status === "approval") approval++;
    if (status === "unknown") unknown++;
  }
  for (const request of relay.approvals) {
    if (!seen.has(request.sessionId)) {
      seen.add(request.sessionId);
      approval++;
    }
  }
  return { running, approval, unknown };
}

export function SessionStatusIcon({ status }: { status: SessionStatus }) {
  const label = { running: "运行中", approval: "等待审批", idle: "空闲", unknown: "状态未知" }[status];
  return (
    <span role="img" aria-label={label} title={label} className={cx(
      "inline-flex size-5 shrink-0 items-center justify-center rounded-full text-xs",
      status === "running" ? "bg-blue-500/15 text-blue-600 dark:text-blue-400" :
      status === "approval" ? "bg-amber-500/15 text-amber-700 dark:text-amber-300" :
      "bg-zinc-200/60 text-zinc-500 dark:bg-zinc-800",
    )}>
      {status === "running" ? <span className="size-2 animate-pulse rounded-full bg-current motion-reduce:animate-none" /> : status === "approval" ? "!" : status === "idle" ? "✓" : "?"}
    </span>
  );
}

export function ActivitySummary({ relay }: { relay: Relay }) {
  const counts = activityCounts(relay);
  const status: SessionStatus = counts.approval ? "approval" : counts.running ? "running" : counts.unknown || !relay.connected ? "unknown" : "idle";
  const label = `${counts.running} 个会话运行中，${counts.approval} 个会话等待审批${counts.unknown ? `，${counts.unknown} 个状态未知` : ""}${!relay.connected ? "，连接中断，状态可能未更新" : ""}`;
  return (
    <div role="status" aria-label={label} title={label} className="flex flex-wrap items-center gap-1.5 px-3 pb-2 text-[11px] text-zinc-500">
      <SessionStatusIcon status={status} />
      <span>{counts.running} 运行中 · {counts.approval} 待审批</span>
      {counts.unknown > 0 && <span>· {counts.unknown} 未知</span>}
      {!relay.connected && <span>· 正在重连</span>}
    </div>
  );
}
