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
  const available = relay.agents.filter((entry) => entry.ok).length;
  const canCreate = relay.agents.some((entry) => entry.ok);

  return (
    <div className="flex h-full flex-col bg-zinc-50 dark:bg-zinc-950/60">
      <div className="flex items-center gap-2 px-3 pt-[max(env(safe-area-inset-top),0.75rem)] pb-1">
        <img src="/icon.svg" alt="" className="size-6" />
        <span className="font-semibold">AnywhereCoding</span>
        <span
          className={cx("size-1.5 rounded-full", relay.connected ? "bg-emerald-500" : "animate-pulse bg-amber-500")}
          title={relay.connected ? "已连接" : "连接中断，正在重连"}
        />
        <button onClick={onLogout} className="ml-auto min-h-8 rounded-md px-2 text-xs text-zinc-500 hover:bg-zinc-200 dark:hover:bg-zinc-800">
          退出
        </button>
      </div>
      <ActivitySummary relay={relay} />

      <div className="space-y-2 px-3 pb-2">
        <div className="flex gap-2">
          <input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="搜索会话或项目"
            aria-label="搜索会话或项目"
            className="min-h-9 min-w-0 flex-1 rounded-lg bg-zinc-200/60 px-3 text-sm outline-none placeholder:text-zinc-500 focus-visible:ring-2 focus-visible:ring-blue-500 dark:bg-zinc-800/80"
          />
          <button
            onClick={() => canCreate ? onNew(undefined, filter === "all" ? undefined : filter) : onConnections()}
            title={canCreate ? "新会话（可选择项目文件夹）" : "先添加连接"}
            className="flex min-h-9 shrink-0 items-center gap-1 rounded-lg bg-zinc-900 px-3 text-sm font-medium text-white hover:bg-zinc-700 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-300"
          >
            <span aria-hidden="true" className="text-base leading-none">＋</span>新会话
          </button>
        </div>
        {pendingApprovals > 0 && (
          <button
            onClick={() => onOpen(relay.approvals[0].sessionId)}
            className="flex min-h-9 w-full items-center gap-2 rounded-lg bg-amber-500/15 px-3 text-left text-sm text-amber-800 dark:text-amber-300"
          >
            <span className="size-2 rounded-full bg-amber-500" />
            {pendingApprovals} 个请求等待审批
            <span aria-hidden="true" className="ml-auto">›</span>
          </button>
        )}
        {relay.agents.length > 1 && (
          <div className="flex flex-wrap gap-1 text-xs" role="group" aria-label="按 IDE 筛选">
            {(["all", ...relay.agents.map((entry) => entry.agent)] as Filter[]).map((value) => {
              const availability = value === "all" ? null : relay.agents.find((agent) => agent.agent === value);
              return (
                <button
                  key={value}
                  onClick={() => setFilter(value)}
                  aria-pressed={filter === value}
                  title={availability && !availability.ok ? availability.reason : undefined}
                  className={cx(
                    "flex min-h-7 shrink-0 items-center gap-1 rounded-full px-2.5 whitespace-nowrap",
                    filter === value ? "bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900" : "bg-zinc-200/60 text-zinc-600 hover:bg-zinc-200 dark:bg-zinc-800/70 dark:text-zinc-400 dark:hover:bg-zinc-800",
                  )}
                >
                  {value !== "all" && <span className={cx("size-1.5 rounded-full", availability?.ok ? AGENT_META[value].dot : "bg-zinc-400")} />}
                  {value === "all" ? "全部" : AGENT_META[value].label}
                </button>
              );
            })}
          </div>
        )}
      </div>

      <nav className="scroll-thin min-h-0 flex-1 overflow-y-auto border-t border-zinc-200 px-2 pb-2 dark:border-zinc-800" aria-label="会话">
        {groups.map(([cwd, sessions]) => {
          const isCollapsed = collapsed[cwd];
          return (
            <div key={cwd || "-"} className="mb-1">
              <div className="sticky top-0 z-10 flex items-center gap-1 bg-zinc-50 pt-2 dark:bg-zinc-950">
                <button
                  onClick={() => setCollapsed((all) => ({ ...all, [cwd]: !isCollapsed }))}
                  title={shortPath(cwd)}
                  aria-expanded={!isCollapsed}
                  aria-label={`${isCollapsed ? "展开" : "收起"}项目 ${basename(cwd)}`}
                  className="flex min-h-8 min-w-0 flex-1 items-center gap-1.5 rounded-md px-2 text-left text-xs font-semibold text-zinc-600 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-200"
                >
                  <span aria-hidden="true" className={cx("inline-block text-zinc-400 transition-transform", isCollapsed ? "-rotate-90" : "")}>▾</span>
                  <span aria-hidden="true">📁</span>
                  <span className="truncate">{basename(cwd)}</span>
                  <span className="ml-auto font-normal text-zinc-400">{sessions.length}</span>
                </button>
                {cwd && <button
                  onClick={() => onNew(cwd, filter === "all" ? sessions.find((session) => session.id === activeId)?.agent ?? sessions[0]?.agent : filter)}
                  aria-label={`在项目 ${basename(cwd)} 中新建会话`}
                  title={`在 ${shortPath(cwd)} 中新建会话`}
                  className="flex size-8 shrink-0 items-center justify-center rounded-md text-lg text-zinc-500 hover:bg-zinc-200 hover:text-zinc-900 focus-visible:ring-2 focus-visible:ring-blue-500 dark:hover:bg-zinc-800 dark:hover:text-zinc-100"
                >＋</button>}
              </div>
              {!isCollapsed &&
                sessions.map((session) => {
                  const status = relay.statusOf(session);
                  const active = activeId === session.id;
                  return (
                    <button
                      key={session.id}
                      onClick={() => onOpen(session.id)}
                      aria-current={active ? "page" : undefined}
                      title={`${AGENT_META[session.agent].label} · ${session.title}`}
                      className={cx(
                        "group flex min-h-10 w-full items-center gap-2 rounded-lg py-2 pr-2 pl-6 text-left text-sm",
                        active ? "bg-zinc-200 font-medium dark:bg-zinc-800" : "text-zinc-700 hover:bg-zinc-200/60 dark:text-zinc-300 dark:hover:bg-zinc-800/60",
                      )}
                    >
                      <span className={cx("size-1.5 shrink-0 rounded-full", AGENT_META[session.agent].dot)} aria-label={AGENT_META[session.agent].label} />
                      <span className="min-w-0 flex-1 truncate">{session.title}</span>
                      <StatusDot status={status} />
                      <span className="shrink-0 text-[11px] font-normal text-zinc-400">{relativeTime(session.updatedAt)}</span>
                    </button>
                  );
                })}
            </div>
          );
        })}
        {groups.length === 0 && (
          <p className="px-3 py-8 text-center text-sm text-zinc-500">
            {query.trim() ? "没有匹配的会话" : relay.agents.length ? "没有会话" : "添加连接后显示本机会话"}
          </p>
        )}
      </nav>

      <section className="border-t border-zinc-200 px-2 pt-1.5 pb-[max(env(safe-area-inset-bottom),0.5rem)] dark:border-zinc-800" aria-label="连接的 IDE">
        <button onClick={onConnections} aria-label="添加或管理连接" className="flex min-h-10 w-full items-center gap-2 rounded-lg px-2 text-left text-xs hover:bg-zinc-200 dark:hover:bg-zinc-800">
          <span className="font-medium text-zinc-600 dark:text-zinc-300">连接的 IDE</span>
          <span className="flex items-center gap-1" aria-hidden="true">
            {relay.agents.map((entry) => <span key={entry.agent} title={AGENT_META[entry.agent].label} className={cx("size-2 rounded-full", entry.ok ? AGENT_META[entry.agent].dot : "bg-zinc-300 ring-1 ring-amber-500 dark:bg-zinc-700")} />)}
          </span>
          <span className="ml-auto text-zinc-500">{relay.agents.length ? `${available}/${relay.agents.length} 可用` : "＋ 添加"}</span>
          <span aria-hidden="true" className="text-zinc-400">›</span>
        </button>
        {Object.entries(relay.errors).map(([agent, message]) => (
          <p key={agent} className="mx-2 mb-1 line-clamp-2 text-[11px] text-amber-700 dark:text-amber-400" title={message}>
            {AGENT_META[agent as Agent]?.label}：{message}
          </p>
        ))}
      </section>
    </div>
  );
}
