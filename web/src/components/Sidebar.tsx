import { useEffect, useMemo, useState } from "react";
import type { Agent, SessionSummary } from "../../../server/types.ts";
import type { Relay } from "../store.ts";
import { AGENT_META, basename, cx, relativeTime, shortPath } from "../util.ts";
import { ActivitySummary } from "./SessionStatus.tsx";

type Filter = "all" | Agent;

type Props = {
  relay: Relay;
  activeId: string | null;
  onOpen: (id: string) => void;
  onNew: (cwd?: string, agent?: Agent) => void;
  onLogout: () => void;
  onConnections: () => void;
};

function StatusDot({ status }: { status: string }) {
  if (status === "running") return <span className="size-2 shrink-0 animate-pulse rounded-full bg-blue-500" title="运行中" />;
  if (status === "approval") return <span className="size-2 shrink-0 rounded-full bg-amber-500" title="待审批" />;
  return null;
}

export function Sidebar({ relay, activeId, onOpen, onNew, onLogout, onConnections }: Props) {
  const [filter, setFilter] = useState<Filter>("all");
  const [query, setQuery] = useState("");
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  useEffect(() => { if (filter !== "all" && !relay.agents.some((entry) => entry.agent === filter)) setFilter("all"); }, [filter, relay.agents]);

  const groups = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const visible = relay.sessions.filter(
      (session) =>
        (filter === "all" || session.agent === filter) &&
        (!needle || session.title.toLowerCase().includes(needle) || (session.cwd ?? "").toLowerCase().includes(needle)),
    );
    // Projects ordered by their most recent session, like the Codex app.
    const byProject = new Map<string, SessionSummary[]>();
    for (const session of visible) {
      const key = session.cwd ?? "";
      byProject.set(key, [...(byProject.get(key) ?? []), session]);
    }
    return [...byProject.entries()];
  }, [relay.sessions, filter, query]);

  const pendingApprovals = relay.approvals.length;

  return (
    <div className="flex h-full flex-col bg-zinc-50 dark:bg-zinc-950/60">
      <div className="flex items-center gap-2 px-3 pt-[max(env(safe-area-inset-top),0.75rem)] pb-2">
        <img src="/icon.svg" alt="" className="size-6" />
        <span className="font-semibold">AnywhereCoding</span>
        <span
          className={cx("ml-1 size-1.5 rounded-full", relay.connected ? "bg-emerald-500" : "bg-zinc-400")}
          title={relay.connected ? "已连接" : "连接中断，正在重连"}
        />
        <button onClick={onLogout} className="ml-auto rounded-md px-2 py-1 text-xs text-zinc-500 hover:bg-zinc-200 dark:hover:bg-zinc-800">
          退出
        </button>
      </div>
      <ActivitySummary relay={relay} />
      <section className="space-y-2 border-y border-zinc-200 px-3 py-3 dark:border-zinc-800" aria-label="连接的 IDE">
        <div className="flex items-center text-xs font-medium text-zinc-500"><span>连接的 IDE</span><button onClick={onConnections} aria-label="添加或管理连接" className="ml-auto rounded px-2 py-1 text-zinc-700 hover:bg-zinc-200 dark:text-zinc-300 dark:hover:bg-zinc-800">＋ 添加</button></div>
        {relay.agents.length ? relay.agents.map((entry) => <button key={entry.agent} onClick={onConnections} className="flex w-full items-center gap-2 text-left text-xs" title={entry.reason}><span className={cx("size-1.5 shrink-0 rounded-full", entry.ok ? AGENT_META[entry.agent].dot : "bg-amber-500")} /><span>{AGENT_META[entry.agent].label}</span><span className="ml-auto text-zinc-500">{entry.ok ? "可用" : "不可用"}</span></button>) : <p className="text-xs text-zinc-500">尚未添加连接</p>}
      </section>

      <div className="space-y-2 px-3 pb-2">
        <button
          onClick={() => relay.agents.some((entry) => entry.ok) ? onNew(undefined, filter === "all" ? undefined : filter) : onConnections()}
          className="flex w-full items-center gap-2 rounded-lg border border-zinc-200 bg-white px-3 py-2 text-sm font-medium shadow-sm hover:bg-zinc-100 dark:border-zinc-800 dark:bg-zinc-900 dark:hover:bg-zinc-800"
        >
          <span className="text-lg leading-none">＋</span> 新会话
        </button>
        {pendingApprovals > 0 && (
          <button
            onClick={() => onOpen(relay.approvals[0].sessionId)}
            className="flex w-full items-center gap-2 rounded-lg bg-amber-500/15 px-3 py-2 text-left text-sm text-amber-800 dark:text-amber-300"
          >
            <span className="size-2 rounded-full bg-amber-500" />
            {pendingApprovals} 个请求等待审批
          </button>
        )}
        <input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="搜索会话或项目"
          className="w-full rounded-lg bg-zinc-200/60 px-3 py-1.5 text-sm outline-none placeholder:text-zinc-500 dark:bg-zinc-800/80"
        />
        <div className="flex flex-wrap gap-1 text-xs">
          {(["all", ...relay.agents.map((entry) => entry.agent)] as Filter[]).map((value) => {
            const availability = value === "all" ? null : relay.agents.find((agent) => agent.agent === value);
            return (
              <button
                key={value}
                onClick={() => setFilter(value)}
                title={availability && !availability.ok ? availability.reason : undefined}
                className={cx(
                  "flex items-center gap-1 rounded-md px-2 py-1",
                  filter === value ? "bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900" : "text-zinc-600 hover:bg-zinc-200 dark:text-zinc-400 dark:hover:bg-zinc-800",
                )}
              >
                {value !== "all" && <span className={cx("size-1.5 rounded-full", availability?.ok ? AGENT_META[value].dot : "bg-zinc-400")} />}
                {value === "all" ? "全部" : AGENT_META[value].label}
              </button>
            );
          })}
        </div>
        {Object.entries(relay.errors).map(([agent, message]) => (
          <p key={agent} className="rounded-md bg-zinc-200/60 px-2 py-1 text-xs text-zinc-600 dark:bg-zinc-800/60 dark:text-zinc-400">
            {AGENT_META[agent as Agent]?.label}：{message}
          </p>
        ))}
      </div>

      <nav className="scroll-thin flex-1 overflow-y-auto px-2 pb-[max(env(safe-area-inset-bottom),0.75rem)]">
        {groups.map(([cwd, sessions]) => {
          const isCollapsed = collapsed[cwd];
          return (
            <div key={cwd || "-"} className="mb-1">
              <div className="flex items-center gap-1 pt-2">
                <button
                  onClick={() => setCollapsed((all) => ({ ...all, [cwd]: !isCollapsed }))}
                  title={shortPath(cwd)}
                  aria-expanded={!isCollapsed}
                  aria-label={`${isCollapsed ? "展开" : "收起"}项目 ${basename(cwd)}`}
                  className="flex min-w-0 flex-1 items-center gap-1 rounded-md px-2 py-1 text-left text-xs font-medium text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-300"
                >
                  <span aria-hidden="true" className={cx("inline-block transition-transform", isCollapsed ? "-rotate-90" : "")}>▾</span>
                  <span className="truncate">{basename(cwd)}</span>
                  <span className="ml-auto text-zinc-400">{sessions.length}</span>
                </button>
                {cwd && <button
                  onClick={() => onNew(cwd, filter === "all" ? sessions.find((session) => session.id === activeId)?.agent ?? sessions[0]?.agent : filter)}
                  aria-label={`在项目 ${basename(cwd)} 中新建会话`}
                  title={`在 ${shortPath(cwd)} 中新建会话`}
                  className="flex size-8 shrink-0 items-center justify-center rounded-md text-lg text-zinc-500 hover:bg-zinc-200 focus-visible:ring-2 focus-visible:ring-blue-500 dark:hover:bg-zinc-800"
                >＋</button>}
              </div>
              {!isCollapsed &&
                sessions.map((session) => {
                  const status = relay.statusOf(session);
                  return (
                    <button
                      key={session.id}
                      onClick={() => onOpen(session.id)}
                      className={cx(
                        "group flex w-full items-center gap-2 rounded-lg px-2 py-2 text-left text-sm",
                        activeId === session.id ? "bg-zinc-200 dark:bg-zinc-800" : "hover:bg-zinc-200/60 dark:hover:bg-zinc-800/60",
                      )}
                    >
                      <span className={cx("size-1.5 shrink-0 rounded-full", AGENT_META[session.agent].dot)} title={AGENT_META[session.agent].label} />
                      <span className="min-w-0 flex-1 truncate">{session.title}</span>
                      <StatusDot status={status} />
                      <span className="shrink-0 text-[11px] text-zinc-400">{relativeTime(session.updatedAt)}</span>
                    </button>
                  );
                })}
            </div>
          );
        })}
        {groups.length === 0 && <p className="px-3 py-6 text-center text-sm text-zinc-500">没有会话</p>}
      </nav>
    </div>
  );
}
