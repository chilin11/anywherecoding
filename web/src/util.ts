import type { Agent, SessionStatus } from "../../server/types.ts";

export const AGENT_META: Record<Agent, { label: string; dot: string; badge: string }> = {
  codex: { label: "Codex", dot: "bg-emerald-500", badge: "bg-emerald-500/12 text-emerald-700 dark:text-emerald-300" },
  claude: { label: "Claude Code", dot: "bg-orange-500", badge: "bg-orange-500/12 text-orange-700 dark:text-orange-300" },
  pi: { label: "PI-Desktop", dot: "bg-indigo-500", badge: "bg-indigo-500/12 text-indigo-700 dark:text-indigo-300" },
  "pi-native": { label: "Pi CLI", dot: "bg-fuchsia-500", badge: "bg-fuchsia-500/12 text-fuchsia-700 dark:text-fuchsia-300" },
};

export const STATUS_LABEL: Record<SessionStatus, string> = {
  idle: "空闲",
  running: "运行中",
  approval: "待审批",
  unknown: "",
};

export function basename(path: string | null | undefined): string {
  if (!path) return "无项目";
  const parts = path.replace(/\/+$/, "").split("/");
  return parts[parts.length - 1] || path;
}

export function shortPath(path: string | null | undefined): string {
  if (!path) return "";
  return path.replace(/^\/Users\/[^/]+/, "~");
}

export function relativeTime(ms: number): string {
  const diff = Date.now() - ms;
  if (diff < 60_000) return "刚刚";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`;
  if (diff < 7 * 86_400_000) return `${Math.floor(diff / 86_400_000)} 天前`;
  const date = new Date(ms);
  return `${date.getMonth() + 1}/${date.getDate()}`;
}

export function clockTime(ms: number | undefined): string {
  if (!ms) return "";
  return new Date(ms).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });
}

export function cx(...names: (string | false | null | undefined)[]): string {
  return names.filter(Boolean).join(" ");
}

export const isTouch = typeof window !== "undefined" && window.matchMedia("(pointer: coarse)").matches;
