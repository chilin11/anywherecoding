import { cpSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { DATA_DIR } from "./config.ts";

/** Where file-backed session deletions go, so a mistaken delete can be restored by moving the file back. */
export const trashDir = (): string => process.env.ANYWHERE_TRASH ?? join(DATA_DIR, "trash");

/**
 * Move one native session file or folder into the relay trash, with a sidecar note of its original path.
 * Returns the trashed path.
 */
export function moveToTrash(path: string, agent: string, root = trashDir()): string {
  const dir = join(root, agent);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const target = join(dir, `${new Date().toISOString().replace(/[:.]/g, "-")}-${basename(path)}`);
  try {
    renameSync(path, target);
  } catch (error) {
    // A different volume (custom session dir): copy, then remove the original.
    if ((error as NodeJS.ErrnoException).code !== "EXDEV") throw error;
    cpSync(path, target, { recursive: true });
    rmSync(path, { recursive: true });
  }
  writeFileSync(`${target}.origin`, `${path}\n`, { mode: 0o600 });
  return target;
}

export function cleanTitle(value: unknown): string {
  const title = String(value ?? "").replace(/\s+/g, " ").trim();
  if (!title) throw Object.assign(new Error("标题不能为空"), { status: 400 });
  if (title.length > 200) throw Object.assign(new Error("标题过长（最多 200 字）"), { status: 400 });
  return title;
}
