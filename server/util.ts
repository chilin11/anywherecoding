import { spawn, type ChildProcessWithoutNullStreams, type SpawnOptions } from "node:child_process";
import { EventEmitter } from "node:events";
import { accessSync, constants } from "node:fs";
import { delimiter, join } from "node:path";
import { createInterface } from "node:readline";

export const MAX_TOOL_TEXT = 20_000;

export function clip(text: string | null | undefined, max = MAX_TOOL_TEXT): string {
  if (!text) return "";
  return text.length > max ? `${text.slice(0, max)}\n… (${text.length - max} more chars)` : text;
}

export function asText(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

/**
 * Tool arguments for display: `key: value` lines with real newlines instead of a JSON
 * string full of literal "\n" escapes; multi-line values are indented under their key.
 */
export function formatArgs(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "string") return value;
  if (typeof value !== "object" || Array.isArray(value)) return asText(value);
  const lines: string[] = [];
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (entry === undefined) continue;
    const text = typeof entry === "string" ? entry : JSON.stringify(entry);
    if (text.includes("\n")) lines.push(`${key}:`, ...text.split("\n").map((line) => `  ${line}`));
    else lines.push(`${key}: ${text}`);
  }
  return lines.join("\n");
}

export function firstLine(text: string, max = 80): string {
  const line = text.trim().split("\n").find((part) => part.trim()) ?? "";
  return line.length > max ? `${line.slice(0, max)}…` : line;
}

/** Resolve an executable: explicit path first, then PATH, then known fallbacks. */
export function findBin(name: string, explicit: string | undefined, fallbacks: string[] = []): string | null {
  const candidates = [
    ...(explicit ? [explicit] : []),
    ...(process.env.PATH ?? "").split(delimiter).filter(Boolean).map((dir) => join(dir, name)),
    "/opt/homebrew/bin/" + name,
    "/usr/local/bin/" + name,
    ...fallbacks,
  ];
  for (const candidate of candidates) {
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // try next
    }
  }
  return null;
}

type Pending = { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout };

export class RpcError extends Error {
  readonly code: number;
  readonly data: unknown;
  constructor(code: number, message: string, data?: unknown) {
    super(message);
    this.code = code;
    this.data = data;
  }
}

/**
 * JSON-RPC 2.0 over a child's stdio, one message per line (Codex app-server).
 * Emits `notification(method, params)`, `request(id, method, params)` and `exit(code)`.
 */
export class LineRpc extends EventEmitter {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly pending = new Map<number, Pending>();
  private nextId = 1;
  stderrTail = "";

  constructor(bin: string, args: string[], options: SpawnOptions = {}) {
    super();
    this.child = spawn(bin, args, { ...options, stdio: ["pipe", "pipe", "pipe"] }) as ChildProcessWithoutNullStreams;
    createInterface({ input: this.child.stdout }).on("line", (line) => this.onLine(line));
    this.child.stderr.on("data", (chunk: Buffer) => {
      this.stderrTail = (this.stderrTail + chunk.toString()).slice(-4000);
    });
    this.child.on("exit", (code) => {
      for (const pending of this.pending.values()) {
        clearTimeout(pending.timer);
        pending.reject(new Error(`process exited (${code})`));
      }
      this.pending.clear();
      this.emit("exit", code);
    });
    this.child.on("error", (error) => this.emit("exit", error.message));
  }

  get alive(): boolean {
    return this.child.exitCode === null && !this.child.killed;
  }

  private onLine(line: string): void {
    let message: { id?: number | string; method?: string; params?: unknown; result?: unknown; error?: { code: number; message: string; data?: unknown } };
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    if (message.method && message.id !== undefined) {
      this.emit("request", message.id, message.method, message.params);
    } else if (message.method) {
      this.emit("notification", message.method, message.params);
    } else if (typeof message.id === "number" && this.pending.has(message.id)) {
      const pending = this.pending.get(message.id)!;
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) pending.reject(new RpcError(message.error.code, message.error.message, message.error.data));
      else pending.resolve(message.result);
    }
  }

  private write(message: object): void {
    if (this.alive) this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
  }

  request<T = any>(method: string, params?: unknown, timeoutMs = 60_000): Promise<T> {
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} timed out`));
      }, timeoutMs);
      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject, timer });
      this.write({ id, method, params });
    });
  }

  notify(method: string, params?: unknown): void {
    this.write({ method, ...(params === undefined ? {} : { params }) });
  }

  respond(id: number | string, result: unknown): void {
    this.write({ id, result });
  }

  respondError(id: number | string, code: number, message: string): void {
    this.write({ id, error: { code, message } });
  }

  kill(): void {
    if (this.alive) this.child.kill("SIGTERM");
  }
}
