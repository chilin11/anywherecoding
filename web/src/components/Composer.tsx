import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { isTouch } from "../util.ts";

type Props = {
  placeholder: string;
  running: boolean;
  disabled?: boolean;
  onSend: (text: string) => Promise<void>;
  onStop?: () => void | Promise<void>;
  draftKey: string;
  /** Left side of the action row, e.g. a session settings chip. */
  toolbar?: ReactNode;
};

const drafts = new Map<string, string>();

export function Composer({ placeholder, running, disabled, onSend, onStop, draftKey, toolbar }: Props) {
  const [text, setText] = useState(() => drafts.get(draftKey) ?? "");
  const [sending, setSending] = useState(false);
  const [stopping, setStopping] = useState(false);
  const ref = useRef<HTMLTextAreaElement>(null);
  const activeDraft = useRef(draftKey);
  const pendingSend = useRef<symbol | null>(null);
  const pendingStop = useRef<symbol | null>(null);
  activeDraft.current = draftKey;

  useEffect(() => {
    setText(drafts.get(draftKey) ?? "");
    pendingSend.current = null;
    pendingStop.current = null;
    setSending(false);
    setStopping(false);
  }, [draftKey]);

  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    element.style.height = "auto";
    element.style.height = `${Math.min(element.scrollHeight, 240)}px`;
  }, [text]);

  function update(value: string) {
    setText(value);
    drafts.set(draftKey, value);
  }

  async function submit() {
    const value = text.trim();
    if (!value || pendingSend.current || pendingStop.current || disabled) return;
    const request = Symbol();
    pendingSend.current = request;
    setSending(true);
    try {
      await onSend(value);
      // Keep edits made while sending, including drafts in another session.
      if (drafts.get(draftKey) === text) {
        drafts.set(draftKey, "");
        if (activeDraft.current === draftKey) setText((current) => current === text ? "" : current);
      }
    } catch {
      // Chat reports the failure; retain the draft and consume the rejection.
    } finally {
      if (pendingSend.current === request) {
        pendingSend.current = null;
        setSending(false);
      }
    }
  }

  async function stop() {
    if (!onStop || pendingStop.current) return;
    const request = Symbol();
    pendingStop.current = request;
    setStopping(true);
    try {
      await onStop();
    } catch {
      // Chat reports the failure; never discard the draft on stop.
    } finally {
      if (pendingStop.current === request) {
        pendingStop.current = null;
        setStopping(false);
      }
    }
  }

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    // Safari can report isComposing=false for the Enter that confirms an IME candidate.
    // On phones Enter inserts a newline; the button sends.
    if (event.key === "Enter" && !event.shiftKey && !isTouch && !event.nativeEvent.isComposing && event.nativeEvent.keyCode !== 229) {
      event.preventDefault();
      void submit();
    }
  }

  const canSend = Boolean(text.trim()) && !sending && !stopping && !disabled;
  return (
    <div className="rounded-lg border border-zinc-200 bg-white shadow-sm focus-within:border-zinc-400 dark:border-zinc-700 dark:bg-zinc-800/60 dark:focus-within:border-zinc-500">
      <textarea
        ref={ref}
        rows={1}
        value={text}
        disabled={disabled}
        onChange={(event) => update(event.target.value)}
        onKeyDown={onKeyDown}
        placeholder={placeholder}
        enterKeyHint={isTouch ? "enter" : "send"}
        aria-label={placeholder}
        className="scroll-thin block max-h-60 min-h-9 w-full resize-none bg-transparent px-3 pt-1.5 pb-0 text-base leading-6 outline-none placeholder:text-zinc-400 disabled:opacity-50 sm:text-sm"
      />
      <div className="flex items-center gap-2 px-1.5 pb-1 pt-0.5">
        <div className="min-w-0 flex-1">{toolbar}</div>
        {!isTouch && <span className="hidden shrink-0 text-[11px] text-zinc-400 lg:inline">Enter 发送 · Shift+Enter 换行</span>}
        {(running || stopping) && onStop && (
          <button type="button" onClick={() => void stop()} disabled={stopping} title={stopping ? "正在停止…" : "停止"} aria-label={stopping ? "正在停止…" : "停止"} className="flex size-8 shrink-0 items-center justify-center rounded-full border border-zinc-300 text-zinc-600 hover:bg-zinc-100 disabled:opacity-50 dark:border-zinc-600 dark:text-zinc-300 dark:hover:bg-zinc-700">
            {stopping ? <span className="size-3.5 animate-spin rounded-full border-2 border-current border-t-transparent" /> : <span className="size-3 rounded-sm bg-current" />}
          </button>
        )}
        {(!running || !onStop || Boolean(text.trim()) || sending) && (
          <button
            onClick={() => void submit()}
            disabled={!canSend}
            title={running ? "追加消息" : "发送"}
            aria-label={running ? "追加消息" : "发送"}
            className="flex size-8 shrink-0 items-center justify-center rounded-full bg-zinc-900 text-base text-white hover:bg-zinc-700 disabled:bg-zinc-300 disabled:text-white dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-300 dark:disabled:bg-zinc-700 dark:disabled:text-zinc-500"
          >
            {sending ? <span className="size-3.5 animate-spin rounded-full border-2 border-current border-t-transparent" /> : "↑"}
          </button>
        )}
      </div>
    </div>
  );
}
