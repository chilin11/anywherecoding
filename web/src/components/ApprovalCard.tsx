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
    <div className="rounded-2xl border border-amber-500/40 bg-amber-50 p-3 shadow-sm dark:bg-amber-500/10">
      <div className="mb-1 flex items-center gap-2 text-sm font-medium text-amber-900 dark:text-amber-200">
        <span className="size-2 rounded-full bg-amber-500" /> {approval.title}
      </div>
      {approval.detail && (
        <pre className="scroll-thin mb-3 max-h-48 overflow-auto rounded-lg bg-white/70 p-2 font-mono text-xs whitespace-pre-wrap text-zinc-800 dark:bg-zinc-900/70 dark:text-zinc-200">
          {approval.detail}
        </pre>
      )}
      {approval.questions?.map((question) => (
        <div key={question.id} className="mb-3 space-y-1.5">
          {question.header && <div className="text-xs text-zinc-500">{question.header}</div>}
          <div className="text-sm">{question.question}</div>
          <div className="flex flex-wrap gap-1.5">
            {question.options.map((option) => (
              <button
                key={option.label}
                title={option.description}
                onClick={() => toggle(question.id, option.label, question.multiSelect)}
                aria-pressed={picked[question.id]?.includes(option.label) ?? false}
                className={cx(
                  "rounded-lg border px-2.5 py-1 text-sm",
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
              className="w-full rounded-lg border border-zinc-300 bg-white px-2.5 py-1.5 text-sm outline-none dark:border-zinc-700 dark:bg-zinc-900"
            />
          )}
        </div>
      ))}
      <div className="flex flex-wrap gap-2">
        {approval.choices.map((choice) => (
          <button
            key={choice.id}
            disabled={busy !== null}
            onClick={() => choose(choice.id)}
            className={cx(
              "rounded-lg px-3 py-1.5 text-sm font-medium disabled:opacity-50",
              choice.tone === "primary" && "bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900",
              choice.tone === "danger" && "bg-red-600/10 text-red-700 dark:text-red-300",
              (!choice.tone || choice.tone === "default") && "bg-white text-zinc-800 ring-1 ring-zinc-300 dark:bg-zinc-900 dark:text-zinc-200 dark:ring-zinc-700",
            )}
          >
            {busy === choice.id ? "…" : choice.label}
          </button>
        ))}
      </div>
    </div>
  );
}
