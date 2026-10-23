import test from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hub } from "../hub.ts";
import { CodexAdapter } from "./codex.ts";
import { CodexDesktopIpc } from "./codex-ipc.ts";

function fakeRpc(handlers: Record<string, (params: any) => any> = {}) {
  const calls: { method: string; params: any }[] = [];
  return {
    calls,
    rpc: { alive: true, kill() {}, async request(method: string, params: any) {
      calls.push({ method, params });
      if (handlers[method]) return handlers[method](params);
      if (method === "thread/resume") return { model: "m", thread: { id: params.threadId } };
      if (method === "turn/start") return { turn: { id: `turn-${calls.length}` } };
      if (method === "thread/unsubscribe") return { status: "unsubscribed" };
      throw new Error(method);
    } },
  };
}

function fakeIpc(owner: string | null = "owner-1") {
  const calls: string[] = [];
  return {
    calls,
    ipc: {
      close() {},
      async findOwner(threadId: string) { calls.push(`find ${threadId}`); return owner; },
      async startTurn(o: string, threadId: string, text: string) { calls.push(`start ${o} ${threadId} ${text}`); },
      async steerTurn(o: string, threadId: string, text: string) { calls.push(`steer ${o} ${threadId} ${text}`); },
      async interruptTurn(o: string, threadId: string, turnId?: string | null) { calls.push(`interrupt ${o} ${threadId} ${turnId}`); },
    } as unknown as CodexDesktopIpc,
  };
}

const lockHeld = { "thread/resume": (params: any) => { throw new Error(`thread ${params.threadId} already has an active writer`); } };

function adapterWith(hub: Hub, rpc: any, ipc: CodexDesktopIpc) {
  const adapter: any = new CodexAdapter(hub, undefined, ipc);
  adapter.rpc = rpc;
  return adapter;
}

test("Codex releases the thread writer lock after each turn and resumes before the next send", async () => {
  const { rpc, calls } = fakeRpc();
  const adapter = adapterWith(new Hub(), rpc, fakeIpc().ipc);
  await adapter.send("t", "one");
  assert.deepEqual(calls.map((call) => call.method), ["thread/resume", "turn/start"]);
  adapter.onNotification("turn/completed", { threadId: "t", turn: { id: calls[1].params.turn } });
  assert.equal(calls.at(-1)!.method, "thread/unsubscribe");
  assert.equal(adapter.loaded.has("t"), false);
  // Sending right away waits for the unsubscribe, then reacquires the thread.
  await adapter.send("t", "two");
  assert.deepEqual(calls.slice(3).map((call) => call.method), ["thread/resume", "turn/start"]);
  assert.equal(adapter.releasing.size, 0);
});

test("Codex keeps an active turn loaded and ignores app-servers without thread/unsubscribe", async () => {
  const { rpc, calls } = fakeRpc({ "thread/unsubscribe": () => { throw new Error("unknown method"); } });
  const adapter = adapterWith(new Hub(), rpc, fakeIpc().ipc);
  await adapter.send("t", "one");
  adapter.release("t");
  assert.ok(!calls.some((call) => call.method === "thread/unsubscribe"), "active turn must stay loaded");
  adapter.onNotification("turn/completed", { threadId: "t", turn: {} });
  await adapter.send("t", "two");
  assert.equal(calls.filter((call) => call.method === "turn/start").length, 2);
});

test("Codex explains a locked thread that no desktop window owns", async () => {
  const { rpc } = fakeRpc({ ...lockHeld, "thread/turns/list": () => ({ data: [] }) });
  const ipc = fakeIpc(null);
  const adapter = adapterWith(new Hub(), rpc, ipc.ipc);
  await assert.rejects(adapter.send("t", "hi"), (error: any) => {
    assert.equal(error.status, 409);
    assert.match(error.message, /Codex 桌面 App[\s\S]*打开这个会话[\s\S]*already has an active writer/);
    return true;
  });
  assert.equal(adapter.loaded.has("t"), false);
  assert.ok(!ipc.calls.some((call) => call.startsWith("start")));
  adapter.unfollow("t");
});

test("Codex hands a message for a desktop-owned thread to the owning window and mirrors the turn", async () => {
  let turns: any[] = [{ id: "old", status: "completed", items: [] }];
  const { rpc } = fakeRpc({ ...lockHeld, "thread/turns/list": () => ({ data: [...turns].reverse() }) });
  const ipc = fakeIpc();
  const hub = new Hub();
  const events: any[] = [];
  hub.subscribe((event) => events.push(event));
  const adapter = adapterWith(hub, rpc, ipc.ipc);
  await adapter.send("t", "hello");
  assert.deepEqual(ipc.calls, ["find t", "start owner-1 t hello"]);
  assert.equal(hub.liveStatus("codex:t"), "running");
  // The new turn is not persisted yet: still running, not falsely idle.
  await adapter.pollFollow("t");
  assert.equal(hub.liveStatus("codex:t"), "running");
  turns = [...turns, { id: "new", status: "inProgress", items: [{ type: "userMessage", id: "u1", content: [{ type: "text", text: "hello" }] }] }];
  await adapter.pollFollow("t");
  assert.ok(events.some((event) => event.type === "item" && event.item.id === "u1"));
  // A second message while it runs steers the same turn through the cached owner.
  await adapter.send("t", "more");
  assert.equal(ipc.calls.at(-1), "steer owner-1 t more");
  await adapter.interrupt("t");
  assert.equal(ipc.calls.at(-1), "interrupt owner-1 t new");
  turns = [turns[0], { ...turns[1], status: "interrupted", items: [...turns[1].items, { type: "agentMessage", id: "a1", text: "done" }] }];
  await adapter.pollFollow("t");
  assert.equal(hub.liveStatus("codex:t"), "idle");
  assert.ok(events.some((event) => event.type === "item" && event.item.id === "a1"));
  assert.ok(events.some((event) => event.type === "notice" && /桌面 App/.test(event.message)));
  adapter.unfollow("t");
});

test("Codex rediscovers the owner once when the cached window went away", async () => {
  const { rpc } = fakeRpc({ ...lockHeld, "thread/turns/list": () => ({ data: [] }) });
  const ipc = fakeIpc();
  let failures = 1;
  const start = ipc.ipc.startTurn.bind(ipc.ipc);
  (ipc.ipc as any).startTurn = async (...args: [string, string, string]) => { if (failures-- > 0) throw new Error("client-not-found"); return start(...args); };
  const adapter = adapterWith(new Hub(), rpc, ipc.ipc);
  adapter.follow("t").owner = "stale";
  await adapter.send("t", "x");
  assert.deepEqual(ipc.calls, ["find t", "start owner-1 t x"]);
  adapter.unfollow("t");
});

test("Codex desktop IPC speaks the router's framed protocol with the expected versions", async () => {
  const dir = mkdtempSync(join(tmpdir(), "aw-ipc-"));
  const path = join(dir, "ipc.sock");
  const seen: any[] = [];
  const server = net.createServer((socket) => {
    let buffer = Buffer.alloc(0);
    const reply = (message: any) => {
      const body = Buffer.from(JSON.stringify(message));
      const header = Buffer.alloc(4);
      header.writeUInt32LE(body.length);
      socket.write(Buffer.concat([header, body]));
    };
    socket.on("data", (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      while (buffer.length >= 4 && buffer.length >= 4 + buffer.readUInt32LE(0)) {
        const message = JSON.parse(buffer.subarray(4, 4 + buffer.readUInt32LE(0)).toString());
        buffer = buffer.subarray(4 + buffer.readUInt32LE(0));
        seen.push(message);
        if (message.method === "initialize") reply({ type: "response", requestId: message.requestId, resultType: "success", method: "initialize", result: { clientId: "me" } });
        else if (message.method === "thread-owner-discovery") reply(message.params.conversationId === "owned"
          ? { type: "response", requestId: message.requestId, resultType: "success", handledByClientId: "desk", result: {} }
          : { type: "response", requestId: message.requestId, resultType: "error", error: "no-client-found" });
        else reply({ type: "response", requestId: message.requestId, resultType: "success", method: message.method, result: {} });
      }
    });
    // Discovery probes from the router must be declined.
    reply({ type: "client-discovery-request", requestId: "probe", request: { method: "thread-owner-discovery" } });
  });
  await new Promise<void>((resolve) => server.listen(path, resolve));
  const ipc = new CodexDesktopIpc(() => path);
  try {
    assert.equal(await ipc.findOwner("other"), null);
    assert.equal(await ipc.findOwner("owned"), "desk");
    await ipc.startTurn("desk", "owned", "hi");
    await ipc.steerTurn("desk", "owned", "more");
    await ipc.interruptTurn("desk", "owned", "turn-1");
    await ipc.interruptTurn("desk", "owned", null);
    const byMethod = (method: string) => seen.filter((message) => message.method === method);
    assert.equal(byMethod("initialize")[0].params.clientType, "anywherecoding");
    assert.ok(seen.some((message) => message.type === "client-discovery-response" && message.response.canHandle === false));
    assert.equal(byMethod("thread-owner-discovery")[0].version, 1);
    const start = byMethod("thread-follower-start-turn")[0];
    assert.equal(start.version, 2);
    assert.equal(start.targetClientId, "desk");
    assert.equal(start.sourceClientId, "me");
    assert.deepEqual(start.params.turnStart.request, { threadId: "owned", input: [{ type: "text", text: "hi", text_elements: [] }] });
    assert.equal(byMethod("thread-follower-steer-turn")[0].version, 1);
    assert.deepEqual(byMethod("thread-follower-interrupt-turn").map((message) => [message.version, message.params.expectedTurnId]), [[4, "turn-1"], [3, undefined]]);
  } finally {
    ipc.close();
    server.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
