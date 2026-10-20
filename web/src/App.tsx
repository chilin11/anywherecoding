import { useCallback, useEffect, useState } from "react";
import type { Agent, SessionSummary } from "../../server/types.ts";
import { api, ApiError } from "./api.ts";
import { Chat } from "./components/Chat.tsx";
import { Login } from "./components/Login.tsx";
import { NewSession } from "./components/NewSession.tsx";
import { Sidebar } from "./components/Sidebar.tsx";
import { activityCounts } from "./components/SessionStatus.tsx";
import { ConnectionsPanel } from "./components/Connections.tsx";
import { useRelay } from "./store.ts";
import { AGENT_META, cx } from "./util.ts";
import { SIDEBAR_MIN, useSidebarWidth } from "./useSidebarWidth.ts";

function currentRoute(): string | null {
  const match = location.hash.match(/^#\/s\/(.+)$/);
  return match ? decodeURIComponent(match[1]) : null;
}

export function App() {
  const [authed, setAuthed] = useState<boolean | null>(null);
  const [activeId, setActiveId] = useState<string | null>(currentRoute);
  const [drawer, setDrawer] = useState(false);
  const [creating, setCreating] = useState<{ cwd: string | null; agent?: Agent; projectOnly: boolean } | null>(null);
  const [managingConnections, setManagingConnections] = useState(false);
  // Sessions we just created, shown until the list catches up.
  const [pending, setPending] = useState<Record<string, SessionSummary>>({});
  const relay = useRelay(authed === true);
  const sidebar = useSidebarWidth();

  useEffect(() => {
    api.me().then(() => setAuthed(true)).catch((error) => setAuthed(error instanceof ApiError && error.status === 401 ? false : true));
    const onHash = () => { setActiveId(currentRoute()); setCreating(null); };
    addEventListener("hashchange", onHash);
    return () => removeEventListener("hashchange", onHash);
  }, []);

  useEffect(() => {
    if (authed && "Notification" in window && Notification.permission === "default") {
      // Approvals can arrive while the tab is in the background.
      void Notification.requestPermission().catch(() => undefined);
    }
  }, [authed]);

  // The drawer only overlays content on phones; track that to make the page behind it inert.
  const [narrow, setNarrow] = useState(() => matchMedia("(max-width: 767px)").matches);
  useEffect(() => {
    const query = matchMedia("(max-width: 767px)");
    const update = () => { setNarrow(query.matches); if (!query.matches) setDrawer(false); };
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);
  useEffect(() => {
    if (!drawer) return;
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") setDrawer(false); };
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  }, [drawer]);

  const open = useCallback((id: string) => {
    location.hash = `#/s/${encodeURIComponent(id)}`;
    setDrawer(false);
    setCreating(null);
  }, []);

  const activity = activityCounts(relay);
  useEffect(() => {
    document.title = authed && activity.approval > 0 ? `! (${activity.approval}) AnywhereCoding`
      : authed && activity.running > 0 ? `⏳ (${activity.running}) AnywhereCoding` : "AnywhereCoding";
    return () => { document.title = "AnywhereCoding"; };
  }, [authed, activity.approval, activity.running]);

  if (authed === null) return null;
  if (!authed) return <Login onDone={() => setAuthed(true)} />;

  const candidate = relay.sessions.find((session) => session.id === activeId) ?? (activeId ? pending[activeId] : undefined);
  const active = candidate && relay.agents.some((entry) => entry.agent === candidate.agent) ? candidate : undefined;
  const activeCwd = active?.cwd ?? relay.sessions[0]?.cwd ?? null;

  function onNew(cwd?: string, agent?: Agent) {
    if (!relay.agents.some((entry) => entry.ok)) { setManagingConnections(true); setDrawer(false); return; }
    setCreating({ cwd: cwd ?? activeCwd, agent: agent ?? active?.agent, projectOnly: Boolean(cwd) });
    setDrawer(false);
  }

  async function logout() {
    await api.logout().catch(() => undefined);
    setAuthed(false);
  }

  function created(id: string, agent: Agent, cwd: string, text: string) {
    setPending((all) => ({
      ...all,
      [id]: { id, agent, nativeId: id.slice(agent.length + 1), title: text.slice(0, 60), cwd, updatedAt: Date.now(), status: "running" },
    }));
    setCreating(null);
    open(id);
    void relay.refreshSessions();
  }

  function deleted(id: string) {
    setPending((all) => { const { [id]: _removed, ...rest } = all; return rest; });
    if (id !== activeId) return;
    // Leave the deleted chat without keeping it in back-navigation.
    history.replaceState(null, "", location.pathname + location.search);
    setActiveId(null);
  }

  const sidebarHidden = !narrow && sidebar.collapsed;
  const showMenu = () => (narrow ? setDrawer(true) : sidebar.setCollapsed(false));
  const menuButton = (
    <button onClick={showMenu} className={cx("flex size-10 items-center justify-center rounded-lg text-xl leading-none hover:bg-zinc-100 dark:hover:bg-zinc-800", !sidebarHidden && "md:hidden")} aria-label="菜单" title={narrow ? "会话列表" : "显示侧栏"}>☰</button>
  );

  return (
    <div className="flex h-dvh overflow-hidden">
      <aside
        aria-label="会话列表"
        hidden={sidebarHidden}
        style={narrow ? undefined : { width: sidebar.width }}
        className={cx(
          "fixed inset-y-0 left-0 z-30 w-[86vw] max-w-80 shrink-0 border-r border-zinc-200 bg-white shadow-xl md:static md:max-w-none md:translate-x-0 md:shadow-none dark:border-zinc-800 dark:bg-zinc-900",
          !sidebar.dragging && "transition-transform duration-200",
          drawer ? "translate-x-0" : "-translate-x-full",
        )}
      >
        <Sidebar relay={relay} activeId={activeId} onOpen={open} onNew={onNew} onConnections={() => { setCreating(null); setManagingConnections(true); setDrawer(false); }} onLogout={() => void logout()} onDeleted={deleted} onHide={narrow ? () => setDrawer(false) : () => sidebar.setCollapsed(true)} />
      </aside>
      {!narrow && !sidebarHidden && (
        <div
          role="separator"
          aria-orientation="vertical"
          aria-label="调整侧栏宽度"
          aria-valuemin={SIDEBAR_MIN}
          aria-valuemax={sidebar.max}
          aria-valuenow={sidebar.width}
          tabIndex={0}
          title="拖动调整宽度，双击恢复默认，拖到最左隐藏"
          {...sidebar.handle}
          className={cx(
            "group relative z-10 -mx-1 w-2 shrink-0 cursor-col-resize touch-none outline-none",
            "after:absolute after:inset-y-0 after:left-1/2 after:w-0.5 after:-translate-x-1/2 after:transition-colors",
            sidebar.dragging ? "after:bg-blue-500" : "after:bg-transparent hover:after:bg-blue-400/70 focus-visible:after:bg-blue-500",
          )}
        />
      )}
      {drawer && <div className="fixed inset-0 z-20 bg-black/30 md:hidden" onClick={() => setDrawer(false)} aria-hidden="true" />}

      <main className="min-w-0 flex-1" inert={drawer && narrow ? true : undefined}>
        {creating?.projectOnly ? (
          <div className="flex h-full flex-col">
            <header className="flex items-center px-2 pt-[max(env(safe-area-inset-top),0.375rem)] md:hidden">{menuButton}</header>
            <div className="min-h-0 flex-1"><NewSession key={`${creating.cwd}:${creating.agent}`} relay={relay} initialCwd={creating.cwd} initialAgent={creating.agent} projectOnly onClose={() => setCreating(null)} onCreated={created} /></div>
          </div>
        ) : active ? (
          <Chat key={active.id} relay={relay} session={active} onMenu={showMenu} menuAlways={sidebarHidden} onNew={onNew} onDeleted={() => deleted(active.id)} />
        ) : (
          <div className="flex h-full flex-col">
            <header className="flex items-center px-2 pt-[max(env(safe-area-inset-top),0.375rem)] pb-1 md:hidden">
              {menuButton}
              <span className="ml-1 font-semibold">AnywhereCoding</span>
            </header>
            <div className="flex flex-1 flex-col items-center justify-center gap-4 p-6 text-center">
              <img src="/icon.svg" alt="" className="size-12 opacity-80" />
              <div className="space-y-1">
                <p className="font-medium">{relay.agents.length ? "继续你的编程会话" : "连接本机 IDE"}</p>
                <p className="text-sm text-zinc-500">{relay.agents.length ? "从会话列表选一个继续，或新建一个" : "添加本机 IDE 连接，查看并继续你的会话"}</p>
              </div>
              {relay.agents.length > 0 && <div className="flex flex-wrap justify-center gap-x-3 gap-y-1 text-xs text-zinc-500">
                {relay.agents.map((agent) => (
                  <span key={agent.agent} className="flex items-center gap-1" title={agent.reason}>
                    <span className={cx("size-1.5 rounded-full", agent.ok ? AGENT_META[agent.agent].dot : "bg-zinc-400")} />
                    {AGENT_META[agent.agent].label}
                    {!agent.ok && "（不可用）"}
                  </span>
                ))}
              </div>}
              <div className="flex flex-wrap justify-center gap-2">
                <button onClick={() => relay.agents.length ? onNew() : setManagingConnections(true)} className="min-h-11 rounded-xl bg-zinc-900 px-5 text-sm font-medium text-white hover:bg-zinc-700 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-300">
                  {relay.agents.length ? "＋ 新会话" : "添加连接"}
                </button>
                {relay.sessions.length > 0 && (
                  <button onClick={() => setDrawer(true)} className="min-h-11 rounded-xl border border-zinc-200 px-5 text-sm font-medium hover:bg-zinc-100 md:hidden dark:border-zinc-700 dark:hover:bg-zinc-800">
                    浏览会话
                  </button>
                )}
              </div>
            </div>
          </div>
        )}
      </main>

      {creating && !creating.projectOnly && <NewSession relay={relay} initialCwd={creating.cwd} initialAgent={creating.agent} onClose={() => setCreating(null)} onCreated={created} />}
      {managingConnections && <ConnectionsPanel relay={relay} onClose={() => setManagingConnections(false)} />}

      <div className="pointer-events-none fixed inset-x-0 top-3 z-50 flex flex-col items-center gap-2 px-3">
        {relay.toasts.map((toast) => (
          <div
            key={toast.id}
            className={cx(
              "pointer-events-auto max-w-md rounded-xl px-4 py-2 text-sm shadow-lg",
              toast.level === "error" ? "bg-red-600 text-white" : "bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900",
            )}
          >
            {toast.message}
          </div>
        ))}
      </div>
    </div>
  );
}
