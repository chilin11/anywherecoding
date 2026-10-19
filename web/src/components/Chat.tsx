import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import type { Agent, SessionSummary } from "../../../server/types.ts";
import { api } from "../api.ts";
import type { Relay } from "../store.ts";
import { useSessionConfiguration } from "../useSessionConfiguration.ts";
import { AGENT_META, basename, cx, shortPath, STATUS_LABEL } from "../util.ts";
import { ApprovalCard } from "./ApprovalCard.tsx";
import { Composer } from "./Composer.tsx";
import { ItemView } from "./ItemView.tsx";
import { configSummary, SessionConfiguration } from "./SessionConfiguration.tsx";
import { SessionStatusIcon } from "./SessionStatus.tsx";

const DESKTOP_HINT: Record<string, string> = {
  codex: "Codex 桌面版里已打开的同一会话不会实时刷新，回到电脑后重新打开即可。避免两边同时发消息。",
  claude: "Claude 桌面版里已打开的同一会话不会实时刷新，回到电脑后重新打开即可。避免两边同时发消息。",
};

export function Chat({ relay, session, onMenu, onNew }: { relay: Relay; session: SessionSummary; onMenu: () => void; onNew: (cwd?: string, agent?: Agent) => void }) {
  const thread = relay.threads[session.id];
  const status = relay.statusOf(session);
  const running = status === "running" || status === "approval";
  const configuration = useSessionConfiguration(session.id, session.agent, running);
  const approvals = relay.approvals.filter((approval) => approval.sessionId === session.id);
  const scroller = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const lastTop = useRef(0);
  const [atBottom, setAtBottom] = useState(true);
  const [showSettings, setShowSettings] = useState(false);
  const settingsId = useId();
  const [hintClosed, setHintClosed] = useState(() => localStorage.getItem("aw-hint-closed") === "1");
  const [actionError, setActionError] = useState<string | null>(null);

  useEffect(() => {
    void relay.loadThread(session.id);
    stick.current = true;
    setAtBottom(true);
    if (session.agent !== "pi") return;
    // PI-Desktop is polled; keep the server watching while this page is open.
    const timer = setInterval(() => void api.watch(session.id).catch(() => undefined), 60_000);
    return () => clearInterval(timer);
  }, [session.id, session.agent, relay.loadThread]);

  useLayoutEffect(() => {
    const element = scroller.current;
    if (element && stick.current) element.scrollTop = element.scrollHeight;
  }, [thread?.items, approvals.length]);

  // Keep the latest message visible when the keyboard or bottom panels resize the transcript.
  useEffect(() => {
    const element = scroller.current;
    if (!element || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => { if (stick.current) element.scrollTop = element.scrollHeight; });
    observer.observe(element);
    if (element.firstElementChild) observer.observe(element.firstElementChild);
    return () => observer.disconnect();
  }, []);

  function scrollToBottom() {
    const element = scroller.current;
    if (!element) return;
    stick.current = true;
    setAtBottom(true);
    element.scrollTo({ top: element.scrollHeight, behavior: "smooth" });
  }

  function onScroll() {
    const element = scroller.current;
    if (!element) return;
    const nearBottom = element.scrollHeight - element.scrollTop - element.clientHeight < 80;
    // Content growing under a programmatic scroll is not the user leaving the bottom; only scrolling up is.
    const scrolledUp = element.scrollTop < lastTop.current - 2;
    lastTop.current = element.scrollTop;
    if (nearBottom) stick.current = true;
    else if (scrolledUp) stick.current = false;
    setAtBottom(stick.current || nearBottom);
    if (element.scrollTop < 40 && thread?.before && !thread.loading) {
      const previousHeight = element.scrollHeight;
      void relay.loadThread(session.id, true).then(() => {
        requestAnimationFrame(() => {
          element.scrollTop = element.scrollHeight - previousHeight;
        });
      });
    }
  }

  async function send(text: string) {
    if (configuration.isSaving()) throw new Error("设置正在保存，请稍后发送。");
    stick.current = true;
    setActionError(null);
    try {
      await api.send(session.id, text);
    } catch (error) {
      setActionError(`发送失败：${(error as Error).message}`);
      relay.toast("error", (error as Error).message);
      throw error;
    }
  }

  async function stop() {
    setActionError(null);
    try {
      await api.interrupt(session.id);
    } catch (error) {
      setActionError(`停止失败：${(error as Error).message}`);
      relay.toast("error", (error as Error).message);
    }
  }

  const meta = AGENT_META[session.agent];
  const hint = DESKTOP_HINT[session.agent];
  const summary = configuration.config ? configSummary(configuration.config) : null;
  const settingsOpen = showSettings || Boolean(configuration.error);

  return (
    <div className="flex h-full min-w-0 flex-col">
      <header className="flex items-center gap-1.5 border-b border-zinc-200 bg-white/90 px-2 pt-[max(env(safe-area-inset-top),0.375rem)] pb-1.5 backdrop-blur sm:gap-2 sm:px-3 dark:border-zinc-800 dark:bg-zinc-900/90">
        <button onClick={onMenu} className="flex size-10 shrink-0 items-center justify-center rounded-lg text-xl leading-none hover:bg-zinc-100 md:hidden dark:hover:bg-zinc-800" aria-label="菜单">
          ☰
        </button>
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-sm font-semibold" title={session.title}>{session.title}</h1>
          <div className="flex min-w-0 items-center gap-1.5 text-xs text-zinc-500">
            <SessionStatusIcon status={status} />
            <span className={cx("shrink-0 rounded px-1.5 py-px text-[11px] font-medium", meta.badge)}>{meta.label}</span>
            <span className="min-w-0 truncate" title={session.cwd ?? ""}>{basename(session.cwd)}</span>
            {status !== "idle" && status !== "unknown" && <span className={cx("shrink-0", status === "approval" ? "text-amber-600 dark:text-amber-400" : "text-blue-600 dark:text-blue-400")}>· {STATUS_LABEL[status]}</span>}
          </div>
        </div>
        {session.cwd && <button
          onClick={() => onNew(session.cwd!, session.agent)}
          aria-label="在当前项目中新建会话"
          title={`在 ${shortPath(session.cwd)} 中新建会话`}
          className="flex min-h-10 min-w-10 shrink-0 items-center justify-center gap-1 rounded-lg border border-zinc-200 px-2 text-xs text-zinc-600 hover:bg-zinc-100 focus-visible:ring-2 focus-visible:ring-blue-500 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
        ><span aria-hidden="true" className="text-lg leading-none">＋</span><span className="hidden sm:inline">新会话</span></button>}
      </header>

      <div className="relative min-h-0 flex-1">
        <div ref={scroller} onScroll={onScroll} className="scroll-thin h-full overflow-y-auto overscroll-contain">
          <div className="mx-auto max-w-3xl space-y-4 px-3 py-4 sm:px-4 sm:py-6">
            {thread?.before && (
              <div className="text-center text-xs text-zinc-400">{thread.loading ? "加载中…" : "上滑加载更早的消息"}</div>
            )}
            {thread?.error && <div className="rounded-lg bg-red-500/10 p-3 text-sm text-red-700 dark:text-red-300">{thread.error}</div>}
            {!thread && <div className="text-center text-sm text-zinc-400">加载中…</div>}
            {thread && !thread.loading && !thread.error && thread.items.length === 0 && <div className="py-10 text-center text-sm text-zinc-400">还没有消息</div>}
            {thread?.items.map((item) => <ItemView key={item.id} item={item} />)}
            {running && approvals.length === 0 && (
              <div className="flex items-center gap-2 px-2 text-sm text-zinc-400">
                <span className="size-2 animate-pulse rounded-full bg-blue-500" /> 正在处理…
              </div>
            )}
          </div>
        </div>
        {!atBottom && (
          <button
            onClick={scrollToBottom}
            aria-label="回到最新消息"
            className="absolute right-3 bottom-3 flex size-10 items-center justify-center rounded-full border border-zinc-200 bg-white text-lg text-zinc-600 shadow-md hover:bg-zinc-50 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-200"
          >↓</button>
        )}
      </div>

      <div className="mx-auto w-full max-w-3xl space-y-2 px-2 pt-1 pb-[max(env(safe-area-inset-bottom),0.5rem)] sm:px-3 sm:pb-[max(env(safe-area-inset-bottom),0.75rem)]">
        {approvals.length > 0 && (
          <div className="scroll-thin max-h-[55dvh] space-y-2 overflow-y-auto">
            {approvals.map((approval) => (
              <ApprovalCard key={approval.id} approval={approval} onError={(message) => relay.toast("error", message)} />
            ))}
          </div>
        )}
        {hint && !hintClosed && (
          <div className="flex items-start gap-2 rounded-lg bg-zinc-100 px-3 py-1.5 text-[11px] leading-4 text-zinc-500 dark:bg-zinc-800/60">
            <span className="flex-1">{hint}</span>
            <button
              onClick={() => {
                localStorage.setItem("aw-hint-closed", "1");
                setHintClosed(true);
              }}
              aria-label="关闭提示"
              className="-my-1.5 -mr-2 flex size-8 shrink-0 items-center justify-center text-zinc-400"
            >
              ✕
            </button>
          </div>
        )}
        {settingsOpen && (
          <div id={settingsId} className="space-y-2 rounded-xl border border-zinc-200 bg-zinc-50/60 px-3 py-2 dark:border-zinc-800 dark:bg-zinc-900/60" aria-busy={configuration.loading || configuration.saving}>
            {configuration.config && (
              <SessionConfiguration
                config={configuration.config}
                disabled={configuration.saving || running}
                onChange={(patch) => void configuration.save(patch)}
                showContext={session.agent === "pi" || session.agent === "pi-native"}
              />
            )}
            {configuration.loading && <p role="status" className="text-xs text-zinc-500">正在读取会话设置…</p>}
            {configuration.error && (
              <p role="alert" className="text-xs text-red-600 dark:text-red-400">
                {configuration.error} <button disabled={configuration.saving} onClick={configuration.refresh} className="underline">重新读取</button>
              </p>
            )}
            {running && configuration.config && <p className="text-[11px] text-zinc-500">任务运行或等待审批时暂不能修改设置。</p>}
          </div>
        )}
        {actionError && <div role="alert" className="flex items-start gap-2 rounded-lg bg-red-500/10 p-3 text-sm break-words whitespace-pre-wrap text-red-700 dark:text-red-300"><span className="min-w-0 flex-1">{actionError}</span><button aria-label="关闭操作错误" onClick={() => setActionError(null)} className="shrink-0">✕</button></div>}
        <Composer
          draftKey={session.id}
          placeholder={running ? "追加消息…" : `给 ${meta.label} 发消息`}
          running={running}
          disabled={configuration.saving}
          onSend={send}
          onStop={stop}
          toolbar={
            <button
              type="button"
              onClick={() => setShowSettings((value) => !value)}
              aria-expanded={settingsOpen}
              aria-controls={settingsId}
              title="模型、思考程度与权限"
              className={cx(
                "flex min-h-8 max-w-full min-w-0 items-center gap-1.5 rounded-full px-2.5 text-xs",
                settingsOpen ? "bg-zinc-200 text-zinc-800 dark:bg-zinc-700 dark:text-zinc-100" : "text-zinc-500 hover:bg-zinc-100 dark:hover:bg-zinc-700/60",
              )}
            >
              <span aria-hidden="true">⚙</span>
              <span className="min-w-0 truncate">{configuration.saving ? "正在保存…" : summary?.text || (configuration.loading ? "读取设置…" : "会话设置")}</span>
              {summary?.context && (session.agent === "pi" || session.agent === "pi-native") && <span className="shrink-0 text-zinc-400">· 上下文 {summary.context}</span>}
              <span aria-hidden="true" className={cx("shrink-0 text-zinc-400 transition-transform", settingsOpen && "rotate-180")}>▴</span>
            </button>
          }
        />
      </div>
    </div>
  );
}
