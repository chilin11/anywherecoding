import { mkdirSync, readdirSync, realpathSync, statSync } from "node:fs";
import { dirname, join, sep } from "node:path";
import type { DirListing } from "./types.ts";

function within(path: string, root: string): boolean {
  return path === root || path.startsWith(root.endsWith(sep) ? root : root + sep);
}

/** Resolve a requested folder, refusing anything outside the configured roots (symlinks included). */
export function resolveAllowed(requested: string, roots: string[]): string {
  try {
    const real = realpathSync(requested);
    const realRoots = roots.map((root) => realpathSync(root));
    if (!realRoots.some((root) => within(real, root))) throw new Error("路径不在允许的目录范围内");
    if (!statSync(real).isDirectory()) throw new Error("不是文件夹");
    return real;
  } catch (error) {
    throw Object.assign(new Error((error as Error).message), { status: 400 });
  }
}

export function listDirs(requested: string | null, roots: string[], showHidden: boolean): DirListing {
  const path = resolveAllowed(requested || roots[0]!, roots);
  const realRoots = roots.map((root) => realpathSync(root));
  const dirs = readdirSync(path, { withFileTypes: true })
    .filter((entry) => (showHidden || !entry.name.startsWith(".")) && (entry.isDirectory() || entry.isSymbolicLink()))
    .flatMap((entry) => {
      const full = join(path, entry.name);
      try {
        return statSync(full).isDirectory() ? [{ name: entry.name, path: full }] : [];
      } catch {
        return [];
      }
    })
    .sort((left, right) => left.name.localeCompare(right.name));
  const parent = realRoots.includes(path) ? null : dirname(path);
  return { path, parent, dirs };
}

export function createDir(parent: string, name: string, roots: string[]): DirListing {
  const base = resolveAllowed(parent, roots);
  const leaf = name.trim();
  if (!leaf || leaf === "." || leaf === ".." || /[/\\\x00-\x1f]/.test(leaf) || Buffer.byteLength(leaf) > 255) throw Object.assign(new Error("请输入有效的单层文件夹名称"), { status: 400 });
  const path = join(base, leaf);
  try { mkdirSync(path, { mode: 0o755 }); }
  catch (error) { throw Object.assign(new Error((error as NodeJS.ErrnoException).code === "EEXIST" ? "文件夹或文件已存在" : "无法创建文件夹"), { status: (error as NodeJS.ErrnoException).code === "EEXIST" ? 409 : 400 }); }
  return listDirs(path, roots, false);
}
