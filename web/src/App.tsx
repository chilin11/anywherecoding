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

  return (
    <div className="flex h-dvh overflow-hidden">
      <aside
        className={cx(
          "fixed inset-y-0 left-0 z-30 w-[85vw] max-w-80 border-r border-zinc-200 bg-white transition-transform md:static md:w-72 md:translate-x-0 dark:border-zinc-800 dark:bg-zinc-900",
          drawer ? "translate-x-0" : "-translate-x-full",
        )}
      >
        <Sidebar relay={relay} activeId={activeId} onOpen={open} onNew={onNew} onConnections={() => { setCreating(null); setManagingConnections(true); setDrawer(false); }} onLogout={() => void logout()} />
      </aside>
      {drawer && <div className="fixed inset-0 z-20 bg-black/30 md:hidden" onClick={() => setDrawer(false)} />}

      <main className="min-w-0 flex-1">
        {creating?.projectOnly ? (
          <div className="flex h-full flex-col">
            <header className="px-3 pt-[max(env(safe-area-inset-top),0.5rem)] md:hidden"><button onClick={() => setDrawer(true)} className="rounded-md p-1.5 text-xl leading-none" aria-label="菜单">☰</button></header>
            <div className="min-h-0 flex-1"><NewSession key={`${creating.cwd}:${creating.agent}`} relay={relay} initialCwd={creating.cwd} initialAgent={creating.agent} projectOnly onClose={() => setCreating(null)} onCreated={created} /></div>
          </div>
        ) : active ? (
          <Chat key={active.id} relay={relay} session={active} onMenu={() => setDrawer(true)} onNew={onNew} />
        ) : (
          <div className="flex h-full flex-col">
            <header className="flex items-center px-3 pt-[max(env(safe-area-inset-top),0.5rem)] pb-2 md:hidden">
              <button onClick={() => setDrawer(true)} className="rounded-md p-1.5 text-xl leading-none" aria-label="菜单">☰</button>
            </header>
            <div className="flex flex-1 flex-col items-center justify-center gap-4 p-6 text-center">
              <img src="/icon.svg" alt="" className="size-12 opacity-80" />
              <p className="text-zinc-500">{relay.agents.length ? "从左侧选一个会话继续，或新建一个" : "添加本机 IDE 连接，查看并继续你的会话"}</p>
              <div className="flex flex-wrap gap-3 text-xs text-zinc-500">
                {relay.agents.map((agent) => (
                  <span key={agent.agent} className="flex items-center gap-1" title={agent.reason}>
                    <span className={cx("size-1.5 rounded-full", agent.ok ? AGENT_META[agent.agent].dot : "bg-zinc-400")} />
                    {AGENT_META[agent.agent].label}
                    {!agent.ok && "（不可用）"}
                  </span>
                ))}
              </div>
              <button onClick={() => relay.agents.length ? onNew() : setManagingConnections(true)} className="rounded-xl bg-zinc-900 px-5 py-2.5 text-sm font-medium text-white dark:bg-zinc-100 dark:text-zinc-900">
                {relay.agents.length ? "新会话" : "添加连接"}
              </button>
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
