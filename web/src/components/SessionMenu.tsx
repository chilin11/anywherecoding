import { useEffect, useId, useLayoutEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import type { SessionSummary } from "../../../server/types.ts";
import { api } from "../api.ts";
import type { Relay } from "../store.ts";
import { usePins } from "../usePins.ts";
import { copyText, cx, DELETE_META, shortPath } from "../util.ts";

export function Dialog({ title, onClose, children, busy }: { title: string; onClose: () => void; children: ReactNode; busy?: boolean }) {
  const titleId = useId();
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape" && !busy) onClose(); };
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  }, [onClose, busy]);
  return createPortal(
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 sm:items-center" onClick={() => { if (!busy) onClose(); }}>
      <section
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onClick={(event) => event.stopPropagation()}
        className="w-full max-w-md space-y-3 rounded-t-2xl bg-white p-5 pb-[max(env(safe-area-inset-bottom),1.25rem)] shadow-xl sm:rounded-2xl dark:bg-zinc-900"
      >
        <h2 id={titleId} className="text-base font-semibold">{title}</h2>
        {children}
      </section>
    </div>,
    document.body,
  );
}

const buttonBase = "min-h-10 rounded-lg px-4 text-sm font-medium disabled:opacity-50";
const secondary = cx(buttonBase, "border border-zinc-200 hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-800");

function RenameDialog({ relay, session, onClose }: { relay: Relay; session: SessionSummary; onClose: () => void }) {
  const [title, setTitle] = useState(session.title);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => { input.current?.select(); }, []);
  async function submit(event: FormEvent) {
    event.preventDefault();
    const value = title.trim();
    if (!value || busy) return;
    if (value === session.title) { onClose(); return; }
    setBusy(true); setError(null);
    try {
      await api.renameSession(session.id, value);
      await relay.refreshSessions();
      onClose();
    } catch (failure) {
      setError((failure as Error).message);
      setBusy(false);
    }
  }
  return (
    <Dialog title="重命名会话" onClose={onClose} busy={busy}>
      <form onSubmit={(event) => void submit(event)} className="space-y-3">
        <input
          ref={input}
          value={title}
          maxLength={200}
          onChange={(event) => setTitle(event.target.value)}
          aria-label="会话标题"
          className="min-h-11 w-full rounded-lg border border-zinc-200 bg-transparent px-3 text-base outline-none focus-visible:border-blue-500 focus-visible:ring-2 focus-visible:ring-blue-500/30 sm:text-sm dark:border-zinc-700"
        />
        <p className="text-xs text-zinc-500">标题写入原生客户端，在对应 IDE 中同样可见。</p>
        {error && <p role="alert" className="text-sm break-words text-red-600 dark:text-red-400">{error}</p>}
        <div className="flex justify-end gap-2">
          <button type="button" onClick={onClose} disabled={busy} className={secondary}>取消</button>
          <button type="submit" disabled={busy || !title.trim()} className={cx(buttonBase, "bg-zinc-900 text-white hover:bg-zinc-700 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-300")}>
            {busy ? "保存中…" : "保存"}
          </button>
        </div>
      </form>
    </Dialog>
  );
}

function DeleteDialog({ relay, session, onClose, onDeleted }: { relay: Relay; session: SessionSummary; onClose: () => void; onDeleted?: () => void }) {
  const { unpin } = usePins();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const meta = DELETE_META[session.agent];
  async function confirm() {
    setBusy(true); setError(null);
    try {
      await api.deleteSession(session.id);
      unpin(session.id);
      relay.toast("info", `已${meta.action}：${session.title}`);
      onDeleted?.();
      onClose();
      void relay.refreshSessions();
    } catch (failure) {
      setError((failure as Error).message);
      setBusy(false);
    }
  }
  return (
    <Dialog title={`${meta.action}会话？`} onClose={onClose} busy={busy}>
      <p className="line-clamp-3 rounded-lg bg-zinc-100 px-3 py-2 text-sm font-medium break-words dark:bg-zinc-800">{session.title}</p>
      <p className={cx("text-sm", meta.permanent ? "text-red-600 dark:text-red-400" : "text-zinc-600 dark:text-zinc-400")}>{meta.detail}</p>
      {error && <p role="alert" className="text-sm break-words text-red-600 dark:text-red-400">{error}</p>}
      <div className="flex justify-end gap-2">
        <button type="button" onClick={onClose} disabled={busy} className={secondary} autoFocus>取消</button>
        <button type="button" onClick={() => void confirm()} disabled={busy} className={cx(buttonBase, "bg-red-600 text-white hover:bg-red-500")}>
          {busy ? `${meta.action}中…` : meta.action}
        </button>
      </div>
    </Dialog>
  );
}

type Props = {
  relay: Relay;
  session: SessionSummary;
  /** Called after a successful delete, e.g. to leave the deleted chat. */
  onDeleted?: () => void;
  className?: string;
};

/** "⋯" button with pin, rename, copy path and delete for one session. */
export function SessionMenu({ relay, session, onDeleted, className }: Props) {
  const { pins, toggle } = usePins();
  const [open, setOpen] = useState(false);
  const [dialog, setDialog] = useState<"rename" | "delete" | null>(null);
  const [position, setPosition] = useState<{ top: number; right: number; up: boolean } | null>(null);
  const button = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const menuId = useId();
  const status = relay.statusOf(session);
  const busy = status === "running" || status === "approval";
  const pinned = pins.includes(session.id);
  const meta = DELETE_META[session.agent];

  useLayoutEffect(() => {
    if (!open || !button.current) return;
    const rect = button.current.getBoundingClientRect();
    const up = rect.bottom + 200 > innerHeight;
    setPosition({ top: up ? rect.top - 4 : rect.bottom + 4, right: Math.max(8, innerWidth - rect.right), up });
  }, [open]);

  useEffect(() => {
    if (!open) return;
    menu.current?.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus();
    const close = () => setOpen(false);
    const onPointer = (event: PointerEvent) => {
      if (!menu.current?.contains(event.target as Node) && !button.current?.contains(event.target as Node)) close();
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") { close(); button.current?.focus(); }
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        const items = [...(menu.current?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)") ?? [])];
        const index = items.indexOf(document.activeElement as HTMLButtonElement);
        items[(index + (event.key === "ArrowDown" ? 1 : items.length - 1)) % items.length]?.focus();
      }
    };
    addEventListener("pointerdown", onPointer, true);
    addEventListener("keydown", onKey);
    addEventListener("resize", close);
    addEventListener("scroll", close, true);
    return () => {
      removeEventListener("pointerdown", onPointer, true);
      removeEventListener("keydown", onKey);
      removeEventListener("resize", close);
      removeEventListener("scroll", close, true);
    };
  }, [open]);

  function pick(action: () => void) {
    setOpen(false);
    action();
  }

  const item = "flex min-h-10 w-full items-center gap-2.5 rounded-md px-3 text-left text-sm hover:bg-zinc-100 focus-visible:bg-zinc-100 focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-40 dark:hover:bg-zinc-800 dark:focus-visible:bg-zinc-800";

  return (
    <>
      <button
        ref={button}
        type="button"
        onClick={(event) => { event.stopPropagation(); setOpen((value) => !value); }}
        aria-label={`会话操作：${session.title}`}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        title="更多操作"
        className={cx("flex shrink-0 items-center justify-center rounded-md text-zinc-500 hover:bg-zinc-200 hover:text-zinc-900 focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:outline-none dark:hover:bg-zinc-700 dark:hover:text-zinc-100", className)}
      >
        <svg aria-hidden="true" viewBox="0 0 16 16" className="size-4" fill="currentColor"><circle cx="3.5" cy="8" r="1.3" /><circle cx="8" cy="8" r="1.3" /><circle cx="12.5" cy="8" r="1.3" /></svg>
      </button>
      {open && position && createPortal(
        <div
          ref={menu}
          id={menuId}
          role="menu"
          aria-label="会话操作"
          style={{ top: position.top, right: position.right, transform: position.up ? "translateY(-100%)" : undefined }}
          className="fixed z-50 w-48 rounded-xl border border-zinc-200 bg-white p-1 shadow-lg dark:border-zinc-700 dark:bg-zinc-900"
        >
          <button role="menuitem" className={item} onClick={() => pick(() => toggle(session.id))}>
            <span aria-hidden="true" className="w-4 text-center">{pinned ? "☆" : "★"}</span>{pinned ? "取消置顶" : "置顶"}
          </button>
          <button role="menuitem" className={item} disabled={busy} title={busy ? "运行中不能重命名" : undefined} onClick={() => pick(() => setDialog("rename"))}>
            <span aria-hidden="true" className="w-4 text-center">✎</span>重命名
          </button>
          {session.cwd && (
            <button role="menuitem" className={item} onClick={() => pick(() => {
              copyText(session.cwd!).then(() => relay.toast("info", `已复制 ${shortPath(session.cwd)}`), (error) => relay.toast("error", `复制失败：${(error as Error).message}`));
            })}>
              <span aria-hidden="true" className="w-4 text-center">⧉</span>复制项目路径
            </button>
          )}
          <div className="my-1 h-px bg-zinc-200 dark:bg-zinc-700" role="separator" />
          <button role="menuitem" className={cx(item, "text-red-600 dark:text-red-400")} disabled={busy} title={busy ? "运行中或等待审批时不能删除，请先停止" : undefined} onClick={() => pick(() => setDialog("delete"))}>
            <span aria-hidden="true" className="w-4 text-center">{session.agent === "codex" ? "⤓" : "✕"}</span>{meta.action}
          </button>
        </div>,
        document.body,
      )}
      {dialog === "rename" && <RenameDialog relay={relay} session={session} onClose={() => setDialog(null)} />}
      {dialog === "delete" && <DeleteDialog relay={relay} session={session} onClose={() => setDialog(null)} onDeleted={onDeleted} />}
    </>
  );
}
