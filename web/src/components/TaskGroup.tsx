import { memo, useId, useState } from "react";
import type { Item } from "../../../server/types.ts";
import { cx, isTouch } from "../util.ts";
import { ItemView } from "./ItemView.tsx";

export type TimelineEntry =
  | { type: "item"; item: Item }
  | { type: "task"; taskId: string; items: Item[] };

/**
 * Group chat items so child bot details (having parentTaskId) are aggregated by subtask taskId.
 * Items without parentTaskId remain top-level items.
 * Non-continuous items with the same taskId are aggregated into the same task group
 * at the position of its first appearance to avoid fragmentation or data loss.
 */
export function groupTimelineEntries(items: Item[]): TimelineEntry[] {
  const entries: TimelineEntry[] = [];
  const taskMap = new Map<string, { type: "task"; taskId: string; items: Item[] }>();

  for (const item of items) {
    const parentTaskId = item.parentTaskId;
    if (typeof parentTaskId === "string" && parentTaskId.trim().length > 0) {
      const taskId = item.taskId || parentTaskId;
      const existing = taskMap.get(taskId);
      if (existing) {
        existing.items.push(item);
      } else {
        const entry: TimelineEntry = {
          type: "task",
          taskId,
          items: [item],
        };
        taskMap.set(taskId, entry);
        entries.push(entry);
      }
    } else {
      entries.push({ type: "item", item });
    }
  }

  return entries;
}

export type TaskStatus = "running" | "completed" | "error";

function findLast<T>(arr: T[], pred: (item: T) => boolean): T | undefined {
  for (let i = arr.length - 1; i >= 0; i--) {
    if (pred(arr[i])) return arr[i];
  }
  return undefined;
}

function findLastIndex<T>(arr: T[], pred: (item: T) => boolean): number {
  for (let i = arr.length - 1; i >= 0; i--) {
    if (pred(arr[i])) return i;
  }
  return -1;
}

function getTaskStatus(items: Item[], sessionRunning?: boolean): TaskStatus {
  // If session is idle, anything previously streaming is considered completed
  const activeSession = sessionRunning !== false;

  if (activeSession) {
    if (items.some((item) => item.streaming)) {
      return "running";
    }
    if (items.some((item) => item.tool?.status === "running")) {
      return "running";
    }
  }

  const lastItem = items[items.length - 1];
  if (lastItem) {
    if (lastItem.kind === "error") return "error";
    if (lastItem.tool?.status === "error") return "error";
    if (typeof lastItem.tool?.exitCode === "number" && lastItem.tool.exitCode !== 0) return "error";
  }

  const lastErrorIndex = findLastIndex(
    items,
    (item) => item.kind === "error" || item.tool?.status === "error" || (typeof item.tool?.exitCode === "number" && item.tool.exitCode !== 0)
  );
  if (lastErrorIndex !== -1) {
    const hasSubsequentSuccess = items.slice(lastErrorIndex + 1).some(
      (item) => item.kind === "assistant" && !item.streaming && Boolean(item.text.trim())
    );
    if (!hasSubsequentSuccess) {
      return "error";
    }
  }

  return "completed";
}

function getSummaryText(items: Item[], status: TaskStatus): string {
  if (status === "running") {
    const runningTool = items.find((item) => item.tool?.status === "running");
    if (runningTool?.tool?.name) {
      return `正在调用 ${runningTool.tool.name}…`;
    }
    const streamingItem = items.find((item) => item.streaming);
    if (streamingItem?.kind === "reasoning") {
      return "正在思考…";
    }
    if (streamingItem?.kind === "assistant" && streamingItem.text.trim()) {
      const line = streamingItem.text.split("\n").map((s) => s.trim()).find(Boolean);
      return line ? line.slice(0, 50) : "正在回复…";
    }
    return "正在执行…";
  }

  if (status === "error") {
    const errorItem = findLast(items, (item) => item.kind === "error" || item.tool?.status === "error");
    if (errorItem?.kind === "error" && errorItem.text.trim()) {
      return errorItem.text.split("\n")[0].trim().slice(0, 50);
    }
    if (errorItem?.tool?.name) {
      return `工具 ${errorItem.tool.name} 调用失败`;
    }
    return "执行出错";
  }

  // Completed: look for the last meaningful assistant reply or summary
  const lastAssistant = findLast(items, (item) => item.kind === "assistant" && Boolean(item.text.trim()));
  if (lastAssistant) {
    const line = lastAssistant.text.split("\n").map((s) => s.trim()).find(Boolean);
    if (line) {
      return line.startsWith("历史摘要：") ? line : line.slice(0, 60);
    }
  }

  const toolCount = items.filter((item) => item.kind === "tool").length;
  if (toolCount > 0) {
    return `完成 ${toolCount} 次工具调用`;
  }

  return "已完成";
}

function getStatsText(items: Item[]): string {
  const toolCount = items.filter((item) => item.kind === "tool").length;
  const assistantCount = items.filter((item) => item.kind === "assistant" && Boolean(item.text.trim())).length;
  if (toolCount > 0) {
    return `${toolCount} 次工具${assistantCount > 0 ? ` · ${assistantCount} 条回复` : ""}`;
  }
  if (assistantCount > 0) {
    return `${assistantCount} 条回复`;
  }
  return `${items.length} 条记录`;
}

export const TaskGroup = memo(function TaskGroup({
  taskId,
  items,
  sessionRunning,
}: {
  taskId: string;
  items: Item[];
  sessionRunning?: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const contentId = useId();

  if (items.length === 0) return null;

  const status = getTaskStatus(items, sessionRunning);
  const speaker = items.find((item) => item.speaker)?.speaker;
  const botName = speaker?.name || speaker?.id || "子 Bot";
  const botId = speaker?.id;
  const summaryText = getSummaryText(items, status);
  const statsText = getStatsText(items);

  const statusBadge =
    status === "running" ? (
      <span className="inline-flex shrink-0 items-center gap-1 rounded-full border border-blue-500/20 bg-blue-500/10 px-2 py-0.5 text-[11px] font-medium text-blue-600 dark:text-blue-400">
        <span className="size-1.5 animate-pulse rounded-full bg-blue-500 motion-reduce:animate-none" />
        <span>运行中</span>
      </span>
    ) : status === "completed" ? (
      <span className="inline-flex shrink-0 items-center gap-1 rounded-full border border-emerald-500/20 bg-emerald-500/10 px-2 py-0.5 text-[11px] font-medium text-emerald-700 dark:text-emerald-300">
        <span aria-hidden="true" className="font-semibold">✓</span>
        <span>已完成</span>
      </span>
    ) : (
      <span className="inline-flex shrink-0 items-center gap-1 rounded-full border border-red-500/20 bg-red-500/10 px-2 py-0.5 text-[11px] font-medium text-red-600 dark:text-red-400">
        <span aria-hidden="true" className="font-semibold">✕</span>
        <span>失败</span>
      </span>
    );

  return (
    <div className="my-1.5 rounded-xl border border-zinc-200/90 bg-zinc-50/60 shadow-xs transition-colors hover:border-zinc-300 dark:border-zinc-800 dark:bg-zinc-900/50 dark:hover:border-zinc-700">
      <button
        type="button"
        onClick={() => setExpanded((prev) => !prev)}
        aria-expanded={expanded}
        aria-controls={contentId}
        className={cx(
          "flex w-full min-w-0 items-center gap-2 rounded-xl px-2.5 py-2 text-left text-xs transition-colors",
          "hover:bg-zinc-100/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 dark:hover:bg-zinc-800/60",
          expanded && "rounded-b-none bg-zinc-100/50 dark:bg-zinc-800/40",
          isTouch ? "min-h-10" : "min-h-9"
        )}
      >
        <span
          aria-hidden="true"
          className={cx(
            "w-3 shrink-0 text-center font-mono text-xs text-zinc-400 transition-transform duration-150",
            expanded && "rotate-90"
          )}
        >
          ▸
        </span>

        <div className="flex min-w-0 shrink-0 items-center gap-1.5" title={`任务 ID: ${taskId}`}>
          <span className="inline-flex size-5 shrink-0 items-center justify-center rounded bg-cyan-500/12 text-xs text-cyan-700 dark:text-cyan-300">
            🤖
          </span>
          <span className="truncate font-medium text-zinc-800 dark:text-zinc-200">
            {botName}
          </span>
          {botId && botId !== botName && (
            <span className="hidden truncate text-[11px] text-zinc-400 sm:inline">
              ({botId})
            </span>
          )}
        </div>

        {statusBadge}

        <span className="min-w-0 flex-1 truncate text-zinc-500 dark:text-zinc-400" title={summaryText}>
          {summaryText}
        </span>

        <div className="flex shrink-0 items-center gap-2 text-[11px] text-zinc-400">
          <span>{statsText}</span>
          <span className="hidden sm:inline text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-200">
            {expanded ? "收起" : "展开"}
          </span>
        </div>
      </button>

      {expanded && (
        <div id={contentId} role="region" aria-label={`${botName} 任务详情`} className="space-y-1 border-t border-zinc-200/80 px-3 pt-2 pb-2.5 sm:px-4 dark:border-zinc-800">
          {items.map((item) => (
            <ItemView key={item.id} item={item} />
          ))}
          <div className="flex justify-end pt-1">
            <button
              type="button"
              onClick={() => setExpanded(false)}
              className="inline-flex items-center gap-1 rounded px-2 py-1 text-[11px] text-zinc-400 hover:bg-zinc-200/60 hover:text-zinc-600 dark:hover:bg-zinc-800/60 dark:hover:text-zinc-300"
            >
              <span>收起详情</span>
              <span aria-hidden="true">▴</span>
            </button>
          </div>
        </div>
      )}
    </div>
  );
});
