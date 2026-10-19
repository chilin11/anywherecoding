import { useState } from "react";
import type { Approval } from "../../../server/types.ts";
import { api } from "../api.ts";
import { cx } from "../util.ts";

export function ApprovalCard({ approval, onError }: { approval: Approval; onError: (message: string) => void }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [picked, setPicked] = useState<Record<string, string[]>>({});
  const [other, setOther] = useState<Record<string, string>>({});

  async function choose(choice: string) {
    setBusy(choice);
    try {
      const answers: Record<string, string[]> = {};
      for (const question of approval.questions ?? []) {
        const values = [...(picked[question.id] ?? [])];
        if (other[question.id]?.trim()) values.push(other[question.id].trim());
        if (values.length) answers[question.id] = values;
      }
      await api.resolve(approval.id, { choice, answers });
    } catch (error) {
      onError((error as Error).message);
      setBusy(null);
    }
  }

  function toggle(questionId: string, label: string, multiSelect = false) {
    setPicked((all) => {
      const current = all[questionId] ?? [];
      return { ...all, [questionId]: current.includes(label) ? current.filter((value) => value !== label) : multiSelect ? [...current, label] : [label] };
    });
  }

  return (
    <div role="alertdialog" aria-label={approval.title} className="rounded-2xl border border-amber-500/50 bg-amber-50 p-3 shadow-sm dark:bg-amber-500/10">
      <div className="mb-2 flex items-center gap-2 text-sm font-semibold text-amber-900 dark:text-amber-200">
        <span className="relative flex size-2.5 shrink-0"><span className="absolute inline-flex size-full animate-ping rounded-full bg-amber-400 opacity-60 motion-reduce:animate-none" /><span className="relative inline-flex size-2.5 rounded-full bg-amber-500" /></span>
        <span className="min-w-0 break-words">{approval.title}</span>
      </div>
      {approval.detail && (
        <pre className="scroll-thin mb-3 max-h-40 overflow-auto rounded-lg bg-white/80 p-2 font-mono text-xs whitespace-pre-wrap break-words text-zinc-800 dark:bg-zinc-900/70 dark:text-zinc-200">
          {approval.detail}
        </pre>
      )}
      {approval.questions?.map((question) => (
        <fieldset key={question.id} className="mb-3 space-y-1.5">
          {question.header && <legend className="text-xs text-zinc-500">{question.header}</legend>}
          <div className="text-sm">{question.question}{question.multiSelect && <span className="ml-1 text-xs text-zinc-500">（可多选）</span>}</div>
          <div className="flex flex-wrap gap-1.5">
            {question.options.map((option) => (
              <button
                key={option.label}
                title={option.description}
                onClick={() => toggle(question.id, option.label, question.multiSelect)}
                aria-pressed={picked[question.id]?.includes(option.label) ?? false}
                className={cx(
                  "min-h-9 rounded-lg border px-3 text-sm",
                  picked[question.id]?.includes(option.label)
                    ? "border-zinc-900 bg-zinc-900 text-white dark:border-zinc-100 dark:bg-zinc-100 dark:text-zinc-900"
                    : "border-zinc-300 bg-white dark:border-zinc-700 dark:bg-zinc-900",
                )}
              >
                {option.label}
              </button>
            ))}
          </div>
          {question.allowOther && (
            <input
              value={other[question.id] ?? ""}
              onChange={(event) => setOther((all) => ({ ...all, [question.id]: event.target.value }))}
              placeholder="其他回答（可选）"
              className="min-h-10 w-full rounded-lg border border-zinc-300 bg-white px-3 text-base outline-none sm:text-sm dark:border-zinc-700 dark:bg-zinc-900"
            />
          )}
        </fieldset>
      ))}
      <div className="flex flex-wrap gap-2">
        {approval.choices.map((choice) => (
          <button
            key={choice.id}
            disabled={busy !== null}
            onClick={() => choose(choice.id)}
            className={cx(
              "min-h-10 flex-1 basis-[calc(33%-0.5rem)] rounded-xl px-3 text-sm font-medium whitespace-nowrap disabled:opacity-50 sm:flex-none sm:basis-auto",
              choice.tone === "primary" && "bg-zinc-900 text-white hover:bg-zinc-700 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-300",
              choice.tone === "danger" && "bg-red-600/10 text-red-700 hover:bg-red-600/20 dark:text-red-300",
              (!choice.tone || choice.tone === "default") && "bg-white text-zinc-800 ring-1 ring-zinc-300 hover:bg-zinc-50 dark:bg-zinc-900 dark:text-zinc-200 dark:ring-zinc-700",
            )}
          >
            {busy === choice.id ? "…" : choice.label}
          </button>
        ))}
      </div>
    </div>
  );
}
