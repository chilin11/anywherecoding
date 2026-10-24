import { useEffect, useMemo, useRef, useState } from "react";
import type { Agent, SessionSummary } from "../../../server/types.ts";
import type { Relay } from "../store.ts";
import { AGENT_META, basename, cx, isTouch, relativeTime, shortPath } from "../util.ts";
import { usePins } from "../usePins.ts";
import { SessionMenu } from "./SessionMenu.tsx";
import { ActivitySummary } from "./SessionStatus.tsx";

type Filter = "all" | Agent;

type Props = {
  relay: Relay;
  activeId: string | null;
  onOpen: (id: string) => void;
  onNew: (cwd?: string, agent?: Agent) => void;
  onLogout: () => void;
  onConnections: () => void;
  /** A session was deleted from its row menu. */
  onDeleted: (id: string) => void;
  /** Close the drawer on phones, collapse the sidebar on desktop. */
  onHide?: () => void;
};

function StatusDot({ status }: { status: string }) {
  if (status === "running") return <span className="size-2 shrink-0 animate-pulse rounded-full bg-blue-500" title="运行中" />;
  if (status === "approval") return <span className="size-2 shrink-0 rounded-full bg-amber-500" title="待审批" />;
  return null;
}

const COLLAPSED_KEY = "aw-collapsed-projects";

function SessionRow({ relay, session, active, onOpen, onDeleted, pinned }: { relay: Relay; session: SessionSummary; active: boolean; onOpen: (id: string) => void; onDeleted: (id: string) => void; pinned?: boolean }) {
  const status = relay.statusOf(session);
  return (
    <div
      className={cx(
        "group relative flex items-center rounded", isTouch ? "min-h-9" : "min-h-7",
        active ? "bg-zinc-200 dark:bg-zinc-800" : "hover:bg-zinc-200/60 dark:hover:bg-zinc-800/60",
      )}
    >
      <button
        onClick={() => onOpen(session.id)}
        aria-current={active ? "page" : undefined}
        title={`${AGENT_META[session.agent].label} · ${session.title}${session.cwd ? `\n${shortPath(session.cwd)}` : ""}`}
        className={cx(
          "flex min-w-0 flex-1 items-center gap-2 rounded pl-5 text-left text-[12.5px] outline-none focus-visible:ring-2 focus-visible:ring-blue-500",
          isTouch ? "min-h-9 py-1.5" : "min-h-7 py-0.5",
          isTouch ? "pr-10" : "pr-2",
          active ? "font-medium" : "text-zinc-700 dark:text-zinc-300",
        )}
      >
        <span className={cx("size-1.5 shrink-0 rounded-full", AGENT_META[session.agent].dot)} aria-label={AGENT_META[session.agent].label} />
        <span className="min-w-0 flex-1">
          <span className="block truncate">{session.title}</span>
          {pinned && session.cwd && <span className="block truncate text-[11px] font-normal text-zinc-400">{basename(session.cwd)}</span>}
        </span>
        <StatusDot status={status} />
        <span className={cx("shrink-0 text-[11px] font-normal text-zinc-400", !isTouch && "group-focus-within:invisible group-hover:invisible")}>{relativeTime(session.updatedAt)}</span>
      </button>
      <div className={cx("absolute top-1/2 right-1 -translate-y-1/2", !isTouch && "opacity-0 group-focus-within:opacity-100 group-hover:opacity-100 has-[[aria-expanded=true]]:opacity-100")}>
        <SessionMenu relay={relay} session={session} onDeleted={() => onDeleted(session.id)} className={isTouch ? "size-8" : "size-6"} />
      </div>
    </div>
  );
}

export function Sidebar({ relay, activeId, onOpen, onNew, onLogout, onConnections, onDeleted, onHide }: Props) {
  const [filter, setFilter] = useState<Filter>("all");
  const [query, setQuery] = useState("");
  const { pins } = usePins();
  const search = useRef<HTMLInputElement>(null);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>(() => {
    try { return JSON.parse(localStorage.getItem(COLLAPSED_KEY) ?? "{}") ?? {}; } catch { return {}; }
  });
  useEffect(() => { localStorage.setItem(COLLAPSED_KEY, JSON.stringify(Object.fromEntries(Object.entries(collapsed).filter(([, value]) => value)))); }, [collapsed]);
  // Cmd/Ctrl+K jumps to search from anywhere.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k" && search.current?.offsetParent) {
        event.preventDefault();
        search.current.focus();
        search.current.select();
      }
    };
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  }, []);
  useEffect(() => { if (filter !== "all" && !relay.agents.some((entry) => entry.agent === filter)) setFilter("all"); }, [filter, relay.agents]);

  const { pinned, groups } = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const visible = relay.sessions.filter(
      (session) =>
        (filter === "all" || session.agent === filter) &&
        (!needle || session.title.toLowerCase().includes(needle) || (session.cwd ?? "").toLowerCase().includes(needle)),
    );
    const pinnedSet = new Set(pins);
    const pinned = pins.map((id) => visible.find((session) => session.id === id)).filter((session): session is SessionSummary => Boolean(session));
    // Projects ordered by their most recent session, like the Codex app.
    const byProject = new Map<string, SessionSummary[]>();
    for (const session of visible) {
      if (pinnedSet.has(session.id)) continue;
      const key = session.cwd ?? "";
      byProject.set(key, [...(byProject.get(key) ?? []), session]);
    }
    return { pinned, groups: [...byProject.entries()] };
  }, [relay.sessions, filter, query, pins]);

  const pendingApprovals = relay.approvals.length;
  const available = relay.agents.filter((entry) => entry.ok).length;
  const canCreate = relay.agents.some((entry) => entry.ok);

  return (
    <div className="flex h-full flex-col bg-zinc-50 dark:bg-zinc-950/60">
      <div className="flex items-center gap-2 px-3 pt-[max(env(safe-area-inset-top),0.5rem)] pb-0.5">
        <img src="/icon.svg" alt="" className="size-5" />
        <span className="text-sm font-semibold">AnywhereCoding</span>
        <span
          className={cx("size-1.5 rounded-full", relay.connected ? "bg-emerald-500" : "animate-pulse bg-amber-500")}
          title={relay.connected ? "已连接" : "连接中断，正在重连"}
        />
        <button onClick={onLogout} className="ml-auto min-h-7 rounded px-2 text-xs text-zinc-500 hover:bg-zinc-200 dark:hover:bg-zinc-800">
          退出
        </button>
        {onHide && <button onClick={onHide} aria-label="收起侧栏" title="收起侧栏" className="flex size-7 items-center justify-center rounded text-zinc-500 hover:bg-zinc-200 dark:hover:bg-zinc-800">
          <svg aria-hidden="true" viewBox="0 0 16 16" className="size-4" fill="none" stroke="currentColor" strokeWidth="1.4"><rect x="1.75" y="2.75" width="12.5" height="10.5" rx="2" /><path d="M6 3v10" /><path d="M10.5 6.5 9 8l1.5 1.5" strokeLinecap="round" strokeLinejoin="round" /></svg>
        </button>}
      </div>
      <ActivitySummary relay={relay} />

      <div className="space-y-1.5 px-3 pb-1.5">
        <div className="flex gap-1.5">
          <input
            ref={search}
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={isTouch ? "搜索会话或项目" : "搜索会话或项目  ⌘K"}
            aria-label="搜索会话或项目"
            className="min-h-8 min-w-0 flex-1 rounded-md bg-zinc-200/60 px-2.5 text-[13px] outline-none placeholder:text-zinc-500 focus-visible:ring-2 focus-visible:ring-blue-500 dark:bg-zinc-800/80"
          />
          <button
            onClick={() => canCreate ? onNew(undefined, filter === "all" ? undefined : filter) : onConnections()}
            title={canCreate ? "新会话（可选择项目文件夹）" : "先添加连接"}
            className="flex min-h-8 shrink-0 items-center gap-1 rounded-md bg-zinc-900 px-2.5 text-[13px] font-medium text-white hover:bg-zinc-700 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-300"
          >
            <span aria-hidden="true" className="text-base leading-none">＋</span>新会话
          </button>
        </div>
        {pendingApprovals > 0 && (
          <button
            onClick={() => onOpen(relay.approvals[0].sessionId)}
            className="flex min-h-8 w-full items-center gap-2 rounded-md bg-amber-500/15 px-2.5 text-left text-[13px] text-amber-800 dark:text-amber-300"
          >
            <span className="size-2 rounded-full bg-amber-500" />
            {pendingApprovals} 个请求等待审批
            <span aria-hidden="true" className="ml-auto">›</span>
          </button>
        )}
        {relay.agents.length > 1 && (
          <div className="flex flex-wrap gap-1 text-[11px]" role="group" aria-label="按 IDE 筛选">
            {(["all", ...relay.agents.map((entry) => entry.agent)] as Filter[]).map((value) => {
              const availability = value === "all" ? null : relay.agents.find((agent) => agent.agent === value);
              return (
                <button
                  key={value}
                  onClick={() => setFilter(value)}
                  aria-pressed={filter === value}
                  title={availability && !availability.ok ? availability.reason : undefined}
                  className={cx(
                    "flex shrink-0 items-center gap-1 rounded-full px-2 whitespace-nowrap", isTouch ? "min-h-7" : "min-h-[22px]",
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
        {pinned.length > 0 && (
          <div className="mb-0.5">
            <div className="sticky top-0 z-10 flex min-h-6 items-center gap-1.5 bg-zinc-50 px-2 pt-1 text-[11.5px] font-semibold text-zinc-600 dark:bg-zinc-950 dark:text-zinc-400">
              <span aria-hidden="true" className="text-amber-500">★</span>置顶
              <span className="ml-auto font-normal text-zinc-400">{pinned.length}</span>
            </div>
            {pinned.map((session) => <SessionRow key={session.id} relay={relay} session={session} active={activeId === session.id} onOpen={onOpen} onDeleted={onDeleted} pinned />)}
          </div>
        )}
        {groups.map(([cwd, sessions]) => {
          const isCollapsed = collapsed[cwd];
          return (
            <div key={cwd || "-"} className="mb-0.5">
              <div className="sticky top-0 z-10 flex items-center gap-1 bg-zinc-50 pt-1 dark:bg-zinc-950">
                <button
                  onClick={() => setCollapsed((all) => ({ ...all, [cwd]: !isCollapsed }))}
                  title={shortPath(cwd)}
                  aria-expanded={!isCollapsed}
                  aria-label={`${isCollapsed ? "展开" : "收起"}项目 ${basename(cwd)}`}
                  className="flex min-h-6 min-w-0 flex-1 items-center gap-1.5 rounded px-1.5 text-left text-[11.5px] font-semibold text-zinc-600 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-200"
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
                  className="flex size-6 shrink-0 items-center justify-center rounded text-sm text-zinc-500 hover:bg-zinc-200 hover:text-zinc-900 focus-visible:ring-2 focus-visible:ring-blue-500 dark:hover:bg-zinc-800 dark:hover:text-zinc-100"
                >＋</button>}
              </div>
              {!isCollapsed && sessions.map((session) => <SessionRow key={session.id} relay={relay} session={session} active={activeId === session.id} onOpen={onOpen} onDeleted={onDeleted} />)}
            </div>
          );
        })}
        {groups.length === 0 && pinned.length === 0 && (
          <p className="px-3 py-8 text-center text-sm text-zinc-500">
            {query.trim() ? "没有匹配的会话" : relay.agents.length ? "没有会话" : "添加连接后显示本机会话"}
          </p>
        )}
      </nav>

      <section className="border-t border-zinc-200 px-2 pt-1.5 pb-[max(env(safe-area-inset-bottom),0.5rem)] dark:border-zinc-800" aria-label="连接的 IDE">
        <button onClick={onConnections} aria-label="添加或管理连接" className="flex min-h-8 w-full items-center gap-2 rounded-md px-2 text-left text-xs hover:bg-zinc-200 dark:hover:bg-zinc-800">
          <span className="font-medium text-zinc-600 dark:text-zinc-300">连接的 IDE</span>
          <span className="flex items-center gap-1" aria-hidden="true">
            {relay.agents.map((entry) => <span key={entry.agent} title={AGENT_META[entry.agent].label} className={cx("size-2 rounded-full", entry.ok ? AGENT_META[entry.agent].dot : "bg-zinc-300 ring-1 ring-amber-500 dark:bg-zinc-700")} />)}
          </span>
          <span className="ml-auto text-zinc-500">{relay.agents.length ? `${available}/${relay.agents.length} 可用` : "＋ 添加"}</span>
          <span aria-hidden="true" className="text-zinc-400">›</span>
        </button>
        {relay.agents.filter((entry) => entry.ok && entry.warning).map((entry) => (
          <p key={`warn-${entry.agent}`} className="mx-2 mb-1 line-clamp-2 text-[11px] text-amber-700 dark:text-amber-400" title={entry.warning}>
            ⚠ {AGENT_META[entry.agent].label}：{entry.warning}
          </p>
        ))}
        {Object.entries(relay.errors).map(([agent, message]) => (
          <p key={agent} className="mx-2 mb-1 line-clamp-2 text-[11px] text-amber-700 dark:text-amber-400" title={message}>
            {AGENT_META[agent as Agent]?.label}：{message}
          </p>
        ))}
      </section>
    </div>
  );
}
