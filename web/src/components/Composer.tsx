import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { cx, isTouch } from "../util.ts";

type Props = {
  placeholder: string;
  running: boolean;
  disabled?: boolean;
  onSend: (text: string) => Promise<void>;
  onStop?: () => void;
  draftKey: string;
};

const drafts = new Map<string, string>();

export function Composer({ placeholder, running, disabled, onSend, onStop, draftKey }: Props) {
  const [text, setText] = useState(() => drafts.get(draftKey) ?? "");
  const [sending, setSending] = useState(false);
  const ref = useRef<HTMLTextAreaElement>(null);
  const activeDraft = useRef(draftKey);
  const pendingSend = useRef<symbol | null>(null);
  activeDraft.current = draftKey;

  useEffect(() => {
    setText(drafts.get(draftKey) ?? "");
    pendingSend.current = null;
    setSending(false);
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
    if (!value || pendingSend.current || disabled) return;
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

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    // On phones Enter inserts a newline; the button sends.
    if (event.key === "Enter" && !event.shiftKey && !isTouch && !event.nativeEvent.isComposing) {
      event.preventDefault();
      void submit();
    }
  }

  return (
    <div className="flex items-end gap-2 rounded-3xl border border-zinc-200 bg-white p-2 pl-4 shadow-sm focus-within:border-zinc-400 dark:border-zinc-700 dark:bg-zinc-800/60">
      <textarea
        ref={ref}
        rows={1}
        value={text}
        disabled={disabled}
        onChange={(event) => update(event.target.value)}
        onKeyDown={onKeyDown}
        placeholder={placeholder}
        className="scroll-thin max-h-60 min-h-[2.25rem] flex-1 resize-none bg-transparent py-1.5 text-[15px] leading-6 outline-none placeholder:text-zinc-400 disabled:opacity-50"
      />
      {running && onStop && !text.trim() ? (
        <button onClick={onStop} title="停止" className="flex size-9 shrink-0 items-center justify-center rounded-full bg-zinc-900 dark:bg-zinc-100">
          <span className="size-3 rounded-sm bg-white dark:bg-zinc-900" />
        </button>
      ) : (
        <button
          onClick={() => void submit()}
          disabled={!text.trim() || sending || disabled}
          title={running ? "追加消息" : "发送"}
          className={cx("flex size-9 shrink-0 items-center justify-center rounded-full bg-zinc-900 text-white disabled:opacity-30 dark:bg-zinc-100 dark:text-zinc-900")}
        >
          {sending ? <span className="size-3 animate-spin rounded-full border-2 border-current border-t-transparent" /> : "↑"}
        </button>
      )}
    </div>
  );
}
