import test from "node:test";
import assert from "node:assert/strict";
import { Hub } from "../hub.ts";
import { CodexAdapter } from "./codex.ts";

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

test("Codex releases the thread writer lock after each turn and resumes before the next send", async () => {
  const adapter: any = new CodexAdapter(new Hub());
  const { rpc, calls } = fakeRpc();
  adapter.rpc = rpc;
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
  const adapter: any = new CodexAdapter(new Hub());
  const { rpc, calls } = fakeRpc({ "thread/unsubscribe": () => { throw new Error("unknown method"); } });
  adapter.rpc = rpc;
  await adapter.send("t", "one");
  adapter.release("t");
  assert.ok(!calls.some((call) => call.method === "thread/unsubscribe"), "active turn must stay loaded");
  adapter.onNotification("turn/completed", { threadId: "t", turn: {} });
  await adapter.send("t", "two");
  assert.equal(calls.filter((call) => call.method === "turn/start").length, 2);
});

test("Codex explains a thread held by another Codex process", async () => {
  const adapter: any = new CodexAdapter(new Hub());
  const { rpc } = fakeRpc({ "thread/resume": (params) => { throw new Error(`thread ${params.threadId} already has an active writer`); } });
  adapter.rpc = rpc;
  await assert.rejects(adapter.send("t", "hi"), (error: any) => {
    assert.equal(error.status, 409);
    assert.match(error.message, /Codex 桌面 App[\s\S]*already has an active writer/);
    return true;
  });
  assert.equal(adapter.loaded.has("t"), false);
});
