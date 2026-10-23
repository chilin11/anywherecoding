import { existsSync } from "node:fs";
import net from "node:net";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

type Json = Record<string, any>;

/**
 * Message versions the Codex desktop router accepts (its `ke` table). A request
 * whose version differs is rejected with `request-version-mismatch`, so a
 * desktop upgrade that bumps one fails loudly instead of misbehaving.
 */
const VERSIONS: Record<string, number> = {
  "thread-owner-discovery": 1,
  "thread-follower-start-turn": 2,
  "thread-follower-steer-turn": 1,
  "thread-follower-read-model-settings": 1,
};
const INTERRUPT = "thread-follower-interrupt-turn";
const MAX_FRAME = 256 * 1024 * 1024;

export type IpcResponse = { type: "response"; requestId: string; resultType: "success" | "error"; result?: any; error?: string; handledByClientId?: string };

/** Desktop router socket: `$CODEX_HOME/ipc/ipc.sock`, else the legacy tmp path. */
export function codexIpcSocket(): string {
  const home = process.env.CODEX_HOME ?? join(homedir(), ".codex");
  const primary = join(home, "ipc", "ipc.sock");
  if (existsSync(primary)) return primary;
  const uid = process.getuid?.();
  const legacy = join(tmpdir(), "codex-ipc", uid != null ? `ipc-${uid}.sock` : "ipc.sock");
  return existsSync(legacy) ? legacy : primary;
}

export function textInput(text: string): Json[] {
  return [{ type: "text", text, text_elements: [] }];
}

/**
 * Follower client for the Codex desktop app's local IPC router. A thread that the
 * desktop window owns keeps its writer lock in the desktop app-server; instead of
 * fighting for that lock we ask the owning window to start, steer or interrupt the
 * turn, exactly like a second desktop window does.
 */
export class CodexDesktopIpc {
  private socket: net.Socket | null = null;
  private connecting: Promise<net.Socket> | null = null;
  private clientId = "initializing-client";
  private readonly pending = new Map<string, { resolve: (response: IpcResponse) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();

  private readonly socketPath: () => string;

  constructor(socketPath: () => string = codexIpcSocket) {
    this.socketPath = socketPath;
  }

  available(): boolean {
    return existsSync(this.socketPath());
  }

  close(): void {
    this.socket?.destroy();
    this.socket = null;
  }

  private connect(): Promise<net.Socket> {
    if (this.socket && !this.socket.destroyed) return Promise.resolve(this.socket);
    if (this.connecting) return this.connecting;
    this.connecting = new Promise<net.Socket>((resolve, reject) => {
      const socket = net.connect(this.socketPath());
      let buffer = Buffer.alloc(0);
      socket.on("data", (chunk: Buffer) => {
        buffer = Buffer.concat([buffer, chunk]);
        while (buffer.length >= 4) {
          const length = buffer.readUInt32LE(0);
          if (length === 0 || length > MAX_FRAME) { socket.destroy(new Error(`invalid IPC frame (${length} bytes)`)); return; }
          if (buffer.length < 4 + length) break;
          const frame = buffer.subarray(4, 4 + length);
          buffer = buffer.subarray(4 + length);
          try { this.onMessage(socket, JSON.parse(frame.toString("utf8"))); } catch { /* ignore malformed frames */ }
        }
      });
      socket.once("connect", async () => {
        this.socket = socket;
        try {
          const response = await this.send(socket, "initialize", { clientType: "anywherecoding" }, { version: 0, timeoutMs: 5000 });
          if (response.resultType !== "success" || !response.result?.clientId) throw new Error(response.error ?? "IPC initialize failed");
          this.clientId = response.result.clientId;
          resolve(socket);
        } catch (error) {
          socket.destroy();
          reject(error as Error);
        }
      });
      const fail = (error?: Error) => {
        if (this.socket === socket) this.socket = null;
        this.clientId = "initializing-client";
        for (const [id, entry] of this.pending) { clearTimeout(entry.timer); entry.reject(new Error("Codex 桌面 App IPC 连接已关闭")); this.pending.delete(id); }
        reject(error ?? new Error("Codex 桌面 App IPC 连接已关闭"));
      };
      socket.on("error", fail);
      socket.on("close", () => fail());
    }).finally(() => { this.connecting = null; });
    return this.connecting;
  }

  private write(socket: net.Socket, message: Json): void {
    const body = Buffer.from(JSON.stringify(message), "utf8");
    const header = Buffer.alloc(4);
    header.writeUInt32LE(body.length, 0);
    socket.write(Buffer.concat([header, body]));
  }

  private onMessage(socket: net.Socket, message: Json): void {
    if (message.type === "response") {
      const entry = this.pending.get(message.requestId);
      if (!entry) return;
      clearTimeout(entry.timer);
      this.pending.delete(message.requestId);
      entry.resolve(message as IpcResponse);
    } else if (message.type === "client-discovery-request") {
      // We never own threads; let the router pick a desktop window.
      this.write(socket, { type: "client-discovery-response", requestId: message.requestId, response: { canHandle: false } });
    } else if (message.type === "request") {
      this.write(socket, { type: "response", requestId: message.requestId, resultType: "error", error: "no-handler-for-request" });
    }
  }

  private send(socket: net.Socket, method: string, params: Json, options: { version: number; targetClientId?: string; timeoutMs: number }): Promise<IpcResponse> {
    const requestId = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(requestId); reject(new Error(`timeout: ${method}`)); }, options.timeoutMs + 2000);
      this.pending.set(requestId, { resolve, reject, timer });
      this.write(socket, {
        type: "request", requestId, sourceClientId: this.clientId, version: options.version, method, params,
        ...(options.targetClientId ? { targetClientId: options.targetClientId } : {}), timeoutMs: options.timeoutMs,
      });
    });
  }

  async request(method: string, params: Json, options: { targetClientId?: string; timeoutMs?: number; version?: number } = {}): Promise<any> {
    const socket = await this.connect();
    const response = await this.send(socket, method, params, { version: options.version ?? VERSIONS[method] ?? 0, targetClientId: options.targetClientId, timeoutMs: options.timeoutMs ?? 10_000 });
    if (response.resultType !== "success") throw new Error(response.error ?? `${method} failed`);
    return response;
  }

  /** Client id of the desktop window that owns the thread, or null when none does. */
  async findOwner(threadId: string, timeoutMs = 12_000): Promise<string | null> {
    if (!this.available()) return null;
    try {
      const response = await this.request("thread-owner-discovery", { hostId: "local", conversationId: threadId }, { timeoutMs });
      return response.handledByClientId ?? null;
    } catch (error) {
      const message = (error as Error).message;
      if (/no-client-found|timeout|ECONNREFUSED|ENOENT|连接已关闭/.test(message)) return null;
      throw error;
    }
  }

  async startTurn(owner: string, threadId: string, text: string): Promise<void> {
    await this.request("thread-follower-start-turn", {
      conversationId: threadId,
      turnStart: { request: { threadId, input: textInput(text) }, context: {} },
    }, { targetClientId: owner, timeoutMs: 60_000 });
  }

  async steerTurn(owner: string, threadId: string, text: string): Promise<void> {
    await this.request("thread-follower-steer-turn", { conversationId: threadId, input: textInput(text) }, { targetClientId: owner, timeoutMs: 60_000 });
  }

  async interruptTurn(owner: string, threadId: string, turnId?: string | null): Promise<void> {
    await this.request(INTERRUPT, { conversationId: threadId, mode: "user-stop", ...(turnId ? { expectedTurnId: turnId } : {}) },
      { targetClientId: owner, timeoutMs: 30_000, version: turnId ? 4 : 3 });
  }
}
