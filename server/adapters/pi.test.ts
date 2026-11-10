import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PiAdapter, mapPiMessage } from "./pi.ts";
import { Hub } from "../hub.ts";
import type { RelayEvent } from "../types.ts";

async function finishRefresh(adapter: PiAdapter, sessionId: string): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
  await (adapter as any).watched.get(sessionId)?.poll;
}

test("PI isolates failed sessions and retires repeatedly failing idle watches", async () => {
  const hub = new Hub();
  const events: RelayEvent[] = [];
  hub.subscribe((event) => events.push(event));
  const adapter = new PiAdapter(hub);
  const reads: string[] = [];
  (adapter as any).invoke = async (operation: string, args: any[]) => {
    if (operation === "agent/getStatus") return { status: { isRunning: false } };
    if (operation === "agent/pendingInteractive") return { asks: [], permissions: [] };
    assert.equal(operation, "session/get");
    reads.push(args[0].id);
    if (args[0].id === "bad") throw new Error("session disappeared");
    return { session: { messageStart: 0, messages: [{ id: "good-reply", role: "assistant", content: "fresh" }] } };
  };
  try {
    adapter.watch("bad");
    adapter.watch("good");
    await (adapter as any).poll();
    assert.deepEqual(reads, ["bad", "good"]);
    assert.ok(events.some((event) => event.type === "item" && event.sessionId === "pi:good"));
    for (let index = 0; index < 4; index++) await (adapter as any).poll();
    assert.equal((adapter as any).watched.has("bad"), false);
    assert.equal((adapter as any).watched.has("good"), true);
  } finally { await adapter.stop(); }
});

test("PI history crosses child-only pages and refreshes a parent tool outside the live window", async () => {
  const hub = new Hub();
  const events: RelayEvent[] = [];
  hub.subscribe((event) => events.push(event));
  const adapter = new PiAdapter(hub);
  let running = true;
  const parent = { id: "parent-tool", role: "tool", toolName: "delegate", toolStatus: "running" };
  const messages = [
    { id: "human", role: "user", content: "start" }, parent,
    ...Array.from({ length: 70 }, (_, index) => ({ id: `child-${index}`, role: "assistant", parentToolCallId: "delegation", content: `step ${index}` })),
  ];
  const reads: any[] = [];
  (adapter as any).invoke = async (operation: string, args: any[]) => {
    if (operation === "agent/getStatus") return { status: { isRunning: running } };
    if (operation === "agent/pendingInteractive") return { asks: [], permissions: [] };
    assert.equal(operation, "session/get");
    const input = args[0];
    reads.push(input);
    const end = input.messageBefore ?? messages.length;
    const start = Math.max(0, end - input.messageLimit);
    return { session: { messages: messages.slice(start, end), messageStart: start, hasMoreBefore: start > 0 } };
  };
  try {
    const history = await adapter.history("one", null);
    assert.equal(history.items.length, 72);
    assert.equal(history.items[0].kind, "user");
    assert.equal(history.before, null);
    assert.equal(history.items.filter((item) => item.parentTaskId === "delegation").length, 70);
    assert.deepEqual(reads.map((input) => input.messageBefore), [undefined, 12]);
    await (adapter as any).poll();
    events.length = 0;
    parent.toolStatus = "ok";
    running = false;
    await (adapter as any).poll();
    const completion = events.findIndex((event) => event.type === "item" && event.item.id === "parent-tool" && event.item.tool?.status === "ok");
    const idle = events.findIndex((event) => event.type === "status" && event.status === "idle");
    assert.ok(completion >= 0 && idle > completion, "parent completion is delivered before idle");
    assert.ok(reads.some((input) => input.messageBefore === 2 && input.messageLimit === 1));
    assert.equal((adapter as any).watched.get("one").active.has("parent-tool"), false);
    const before = reads.length;
    await (adapter as any).poll();
    assert.equal(reads.slice(before).some((input) => input.messageBefore === 2), false, "finished tools no longer need point reads");
  } finally { await adapter.stop(); }
});

test("PI idle watches use status-only slow polls and all session probes share four slots", async () => {
  const adapter = new PiAdapter(new Hub());
  const details: string[] = [];
  const statuses: string[] = [];
  let concurrent = 0;
  let peak = 0;
  (adapter as any).invoke = async (operation: string, args: any[]) => {
    if (operation === "agent/getStatus") {
      statuses.push(args[0]);
      peak = Math.max(peak, ++concurrent);
      await new Promise<void>((resolve) => setImmediate(resolve));
      concurrent--;
      return { status: { isRunning: args[0] === "running" } };
    }
    if (operation === "agent/pendingInteractive") return { asks: [], permissions: [] };
    assert.equal(operation, "session/get");
    details.push(args[0].id);
    return { session: { messageStart: 0, messages: [] } };
  };
  try {
    for (const id of ["idle-1", "idle-2", "idle-3", "idle-4", "idle-5", "running"]) {
      adapter.watch(id);
      (adapter as any).watched.get(id).activeUntil = 0;
    }
    (adapter as any).watched.get("running").running = true;
    (adapter as any).pollRound = 4;
    await (adapter as any).poll();
    assert.equal(statuses.length, 6);
    assert.deepEqual(details, ["running"]);
    assert.equal(peak, 4);
    statuses.length = 0;
    details.length = 0;
    await (adapter as any).poll();
    assert.deepEqual(statuses, ["running"]);
    assert.deepEqual(details, ["running"]);
  } finally { await adapter.stop(); }
});

test("PI send coalesces an immediate refresh with an older poll without applying its stale idle", async () => {
  const hub = new Hub();
  const events: RelayEvent[] = [];
  hub.subscribe((event) => events.push(event));
  const adapter = new PiAdapter(hub);
  let release!: () => void;
  const oldStatus = new Promise<void>((resolve) => { release = resolve; });
  let statusReads = 0;
  let detailReads = 0;
  (adapter as any).invoke = async (operation: string) => {
    if (operation === "agent/getStatus") {
      const read = ++statusReads;
      if (read === 1) await oldStatus;
      return { status: { isRunning: read >= 3 } };
    }
    if (operation === "agent/prompt") return { accepted: true };
    if (operation === "agent/pendingInteractive") return { asks: [], permissions: [] };
    assert.equal(operation, "session/get");
    detailReads++;
    return { session: { messageStart: 0, messages: [{ id: "fresh", role: "assistant", content: "arrived" }] } };
  };
  try {
    adapter.watch("one");
    const poll = (adapter as any).poll();
    await adapter.send("one", "hello");
    release();
    await poll;
    await finishRefresh(adapter, "one");
    assert.equal(detailReads, 1, "only the post-send poll reads the transcript");
    assert.equal(statusReads, 3);
    assert.ok(events.some((event) => event.type === "item" && event.item.id === "fresh"));
    assert.equal(events.some((event) => event.type === "status" && event.status === "idle"), false);
  } finally { release(); await adapter.stop(); }
});

test("PI stop ignores an in-flight transcript response", async () => {
  const hub = new Hub();
  const events: RelayEvent[] = [];
  hub.subscribe((event) => events.push(event));
  const adapter = new PiAdapter(hub);
  let release!: () => void;
  let entered!: () => void;
  const ready = new Promise<void>((resolve) => { entered = resolve; });
  const response = new Promise<void>((resolve) => { release = resolve; });
  (adapter as any).invoke = async (operation: string) => {
    if (operation === "agent/getStatus") return { status: { isRunning: true } };
    assert.equal(operation, "session/get");
    entered();
    await response;
    return { session: { messageStart: 0, messages: [{ id: "late", role: "assistant", content: "ignore" }] } };
  };
  try {
    adapter.watch("one");
    const poll = (adapter as any).poll();
    await ready;
    await adapter.stop();
    release();
    await poll;
    assert.equal(events.some((event) => event.type === "item" || event.type === "status"), false);
  } finally { release(); await adapter.stop(); }
});

test("PI session list returns cached status without awaiting a slow upstream probe", async () => {
  const hub = new Hub();
  const adapter = new PiAdapter(hub);
  let release!: () => void;
  const delayed = new Promise<void>((resolve) => { release = resolve; });
  (adapter as any).invoke = async (operation: string) => {
    if (operation === "session/list") return { sessions: [{ id: "one", title: "T" }] };
    if (operation === "agent/pendingInteractive") return { asks: [], permissions: [] };
    assert.equal(operation, "agent/getStatus");
    await delayed;
    return { status: { isRunning: true } };
  };
  try {
    const start = Date.now();
    const list = await adapter.listSessions();
    assert.ok(Date.now() - start < 500);
    assert.equal(list[0].status, "unknown");
    assert.equal(hub.liveStatus("pi:one"), undefined);
    release();
    await (adapter as any).statusProbe;
    assert.equal(hub.liveStatus("pi:one"), "running");
    assert.equal((await adapter.listSessions())[0].status, "running");
  } finally { release(); await adapter.stop(); }
});

test("PI new sessions configure before prompt without redundant status or history reads", async () => {
  const hub = new Hub();
  const events: RelayEvent[] = [];
  hub.subscribe((event) => events.push(event));
  const adapter = new PiAdapter(hub);
  const calls: { operation: string; args: any[]; confirm: boolean }[] = [];
  (adapter as any).invoke = async (operation: string, args: any[] = [], confirm = false) => {
    calls.push({ operation, args, confirm });
    if (operation === "providers/list") return { providers: [{ id: "provider", name: "P", enabled: true, models: [{ id: "model", defaultThinkingLevel: "low", thinkingLevels: ["low"] }] }] };
    if (operation === "providers/listModels") return { models: [] };
    if (operation === "settings/get") return { settings: { defaultProviderId: "provider", defaultModelId: "model" } };
    if (operation === "session/create") return { session: { id: "new" } };
    if (operation === "session/configure" || operation === "agent/prompt") return { ok: true };
    if (operation === "agent/getStatus") return { status: { isRunning: true } };
    if (operation === "agent/pendingInteractive") return { asks: [], permissions: [] };
    if (operation === "session/get") return { session: { messageStart: 0, messages: [{ id: "new-reply", role: "assistant", content: "hello" }] } };
    throw new Error(`unexpected ${operation}`);
  };
  try {
    const id = await adapter.create("/workspace", "hello", { model: JSON.stringify(["provider", "model"]), thinking: "low", permissionMode: "ask" });
    assert.equal(id, "new");
    assert.ok(calls.length <= 7);
    assert.equal(calls.some((call) => call.operation === "session/get" || call.operation === "agent/getStatus"), false);
    const configure = calls.findIndex((call) => call.operation === "session/configure");
    const prompt = calls.findIndex((call) => call.operation === "agent/prompt");
    assert.ok(configure >= 0 && configure < prompt);
    assert.deepEqual(calls[configure], { operation: "session/configure", args: ["new", { mode: "agent", providerId: "provider", modelId: "model", thinkingLevel: "low", permissionMode: "ask" }], confirm: true });
    await finishRefresh(adapter, "new");
    assert.ok(events.some((event) => event.type === "item" && event.item.id === "new-reply"), "creation refreshes without waiting for the periodic timer");
  } finally { await adapter.stop(); }
});

test("PI control envelopes, running state, equal-length edits and interactive resolution", async () => {
  const dir = mkdtempSync(join(tmpdir(), "aw-pi-test-"));
  const events: RelayEvent[] = [];
  const calls: any[] = [];
  let text = "first";
  let pending = true;
  let initializations = 0;
  const server = createServer(async (req, res) => {
    assert.equal(req.headers.authorization, "Bearer local-test-token");
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString());
    res.setHeader("content-type", "application/json");
    if (body.method === "notifications/initialized") { res.writeHead(202); res.end(); return; }
    if (body.method === "initialize") {
      initializations++;
      res.setHeader("mcp-session-id", "test-session");
      res.end(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: {} })); return;
    }
    const { name, arguments: input } = body.params;
    calls.push({ name, input });
    if (name === "pi_session_get" && input.messageLimit > 30) {
      res.end(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: { structuredContent: { truncated: true } } }));
      return;
    }
    const op = name === "pi_session_get" ? "session/get" : input.operation;
    let value: any;
    switch (op) {
      case "session/list": value = { sessions: [{ id: "one", title: "Test", updatedAt: new Date().toISOString() }, { id: "native-pi:duplicate", source: "pi-native" }] }; break;
      case "session/get": value = { session: { messages: [{ id: "reply", role: "assistant", content: text }], messageStart: 5, hasMoreBefore: true } }; break;
      case "agent/getStatus": value = { status: { isRunning: true } }; break;
      case "agent/pendingInteractive": value = { asks: pending ? [{ requestId: "q", questions: [{ question: "Colors?", options: ["Red", "Blue"], multiSelect: true }] }] : [], permissions: [] }; break;
      case "agent/askTool/resolve": pending = false; value = { ok: true }; break;
      default: throw new Error(`Unexpected operation ${op}`);
    }
    res.end(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: { structuredContent: name === "pi_session_get" ? value : { operation: op, result: value } } }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  writeFileSync(join(dir, "mcp-control.json"), JSON.stringify({ active: true, url: `http://127.0.0.1:${port}`, token: "local-test-token" }));
  const hub = new Hub(); hub.subscribe((event) => events.push(event));
  const adapter = new PiAdapter(hub, dir);
  try {
    const lists = await Promise.all([adapter.listSessions(), adapter.listSessions()]);
    assert.deepEqual(lists.map((list) => list.length), [1, 1]);
    assert.equal(initializations, 1, "concurrent readers share MCP initialization");
    await (adapter as any).statusProbe;
    const history = await adapter.history("one", null);
    assert.deepEqual(calls.filter((call) => call.name === "pi_session_get").map((call) => call.input.messageLimit), [60, 30]);
    assert.equal(history.items[0]?.text, "first");
    assert.equal(history.before, "5");
    await (adapter as any).poll();
    assert.equal(hub.liveStatus("pi:one"), "approval");
    const approval = events.find((event) => event.type === "approval");
    assert.ok(approval?.type === "approval");
    assert.equal(approval.approval.questions?.[0]?.multiSelect, true);
    await adapter.resolve(approval.approval.id, { choice: "submit", answers: { "0": ["Red", "Blue"] } });
    const answer = calls.find((call) => call.input.operation === "agent/askTool/resolve");
    assert.equal(answer.input.confirm, true);
    assert.deepEqual(answer.input.args[0].answers, [["Red", "Blue"]]);
    assert.equal(hub.liveStatus("pi:one"), "running");
    text = "other"; // Same length as "first": length-only signatures miss this edit.
    await (adapter as any).poll();
    assert.ok(events.some((event) => event.type === "item" && event.item.text === "other"));
  } finally {
    await adapter.stop();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(dir, { recursive: true, force: true });
  }
});

test("PI mapping hides internal evidence and preserves tools and reasoning", () => {
  assert.deepEqual(mapPiMessage({ id: "x", role: "system", modelSystem: {}, content: "hidden" }), []);
  const child = mapPiMessage({ id: "x", parentToolCallId: "delegate", role: "assistant", thinking: "child thought", content: "child answer" });
  assert.deepEqual(child.map(({ id, kind, taskId, parentTaskId }) => ({ id, kind, taskId, parentTaskId })), [
    { id: "x:thinking", kind: "reasoning", taskId: "delegate", parentTaskId: "delegate" },
    { id: "x", kind: "assistant", taskId: "delegate", parentTaskId: "delegate" },
  ]);
  assert.equal(child[0].speaker, undefined, "do not fabricate an upstream subagent name");
  assert.equal(mapPiMessage({ id: "u", parentToolCallId: 42, role: "user", content: "task input" })[0].kind, "system");
  assert.equal(mapPiMessage({ id: "u", parentToolCallId: 42, role: "user", content: "task input" })[0].taskId, "42");
  assert.equal(mapPiMessage({ id: "t", parentToolCallId: "delegate", role: "tool", toolStatus: "running" })[0].parentTaskId, "delegate");
  assert.deepEqual(mapPiMessage({ id: "a", role: "assistant", thinking: "think", content: "answer" }).map((item) => item.kind), ["reasoning", "assistant"]);
  assert.equal(mapPiMessage({ id: "t", role: "tool", toolName: "Bash", toolArgs: { command: "pwd" }, toolResult: "ok", toolStatus: "denied" })[0]?.tool?.status, "denied");
});

test("PI desktop without pendingInteractive reports a visible approval warning", async () => {
  const dir = mkdtempSync(join(tmpdir(), "aw-pi-test-"));
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString());
    res.setHeader("content-type", "application/json");
    if (body.method === "notifications/initialized") { res.writeHead(202); res.end(); return; }
    if (body.method === "initialize") { res.setHeader("mcp-session-id", "s"); res.end(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: {} })); return; }
    const op = body.params.arguments.operation;
    const reply = (structuredContent: unknown, isError = false) => res.end(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: { isError, structuredContent } }));
    if (op === "agent/pendingInteractive") reply({ ok: false, error: { code: "NOT_FOUND", message: "operation is not exposed" } }, true);
    else if (op === "session/list") reply({ result: { sessions: [{ id: "one", title: "T", updatedAt: new Date().toISOString() }] } });
    else if (op === "agent/getStatus") reply({ result: { status: { isRunning: false } } });
    else throw new Error(`Unexpected operation ${op}`);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  writeFileSync(join(dir, "mcp-control.json"), JSON.stringify({ active: true, url: `http://127.0.0.1:${(server.address() as { port: number }).port}`, token: "t" }));
  const adapter = new PiAdapter(new Hub(), dir);
  try {
    assert.equal(adapter.availability().warning, undefined);
    assert.equal((await adapter.listSessions()).length, 1);
    await (adapter as any).statusProbe;
    const availability = adapter.availability();
    assert.equal(availability.ok, true);
    assert.match(availability.warning ?? "", /pendingInteractive/);
  } finally {
    await adapter.stop();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(dir, { recursive: true, force: true });
  }
});

test("PI rename and delete use the native control operations and refuse running sessions", async () => {
  const dir = mkdtempSync(join(tmpdir(), "aw-pi-test-"));
  const calls: any[] = [];
  let running = true;
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString());
    res.setHeader("content-type", "application/json");
    if (body.method === "notifications/initialized") { res.writeHead(202); res.end(); return; }
    if (body.method === "initialize") { res.setHeader("mcp-session-id", "s"); res.end(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: {} })); return; }
    const input = body.params.arguments;
    calls.push(input);
    const value = input.operation === "agent/getStatus" ? { status: { isRunning: running } } : { ok: true };
    res.end(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: { structuredContent: { result: value } } }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  writeFileSync(join(dir, "mcp-control.json"), JSON.stringify({ active: true, url: `http://127.0.0.1:${(server.address() as { port: number }).port}`, token: "t" }));
  const adapter = new PiAdapter(new Hub(), dir);
  try {
    await adapter.rename("one", "New name");
    assert.deepEqual(calls.at(-1), { operation: "session/rename", args: ["one", "New name"] });
    await assert.rejects(adapter.remove("one"), (error: any) => error.status === 409);
    assert.equal(calls.some((call) => call.operation === "session/delete"), false);
    running = false;
    await adapter.remove("one");
    assert.deepEqual(calls.at(-1), { operation: "session/delete", args: ["one"], confirm: true });
  } finally {
    await adapter.stop();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(dir, { recursive: true, force: true });
  }
});

test("PI messages sent while running steer the turn, queue it, or use a graceful stop on upstream desktops", async () => {
  const dir = mkdtempSync(join(tmpdir(), "aw-pi-steer-"));
  const calls: { op: string; args: any }[] = [];
  let running = true;
  let exposed = new Set(["agent/steer", "agent/queue/push"]);
  let steerEnded = false;
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString());
    res.setHeader("content-type", "application/json");
    if (body.method === "notifications/initialized") { res.writeHead(202); res.end(); return; }
    if (body.method === "initialize") { res.setHeader("mcp-session-id", "s"); res.end(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: {} })); return; }
    if (body.params.name === "pi_session_get") { res.end(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: { structuredContent: { session: { messages: [] } } } })); return; }
    const op = body.params.arguments.operation;
    const args = body.params.arguments.args;
    calls.push({ op, args });
    const fail = (code: string, message: string) => res.end(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: { isError: true, structuredContent: { error: { code, message } } } }));
    const ok = (value: any) => res.end(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: { structuredContent: { operation: op, result: value } } }));
    if ((op === "agent/steer" || op === "agent/queue/push") && !exposed.has(op)) return fail("NOT_FOUND", `operation is not exposed: ${op}`);
    if (op === "agent/steer" && steerEnded) return fail("TURN_NOT_FOUND", "The target turn has ended");
    if (op === "agent/getStatus") return ok({ status: { isRunning: running, currentTurnId: "turn-7" } });
    if (op === "agent/prompt") return running ? fail("AGENT_BUSY", "session already has an active turn") : ok({ accepted: true });
    if (op === "agent/steer") return ok({ accepted: true, turnId: "turn-7" });
    if (op === "agent/queue/push") return ok({ turnId: "q1" });
    if (op === "agent/stop") return ok({ requested: true });
    if (op === "session/get") return ok({ session: { messages: [] } });
    if (op === "agent/pendingInteractive") return ok({ asks: [], permissions: [] });
    return fail("INTERNAL", `unexpected ${op}`);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  writeFileSync(join(dir, "mcp-control.json"), JSON.stringify({ active: true, url: `http://127.0.0.1:${port}`, token: "t" }));
  const adapter = new PiAdapter(new Hub(), dir);
  const ops = () => calls.map((call) => call.op).filter((op) => op !== "session/get" && op !== "agent/pendingInteractive");
  try {
    await adapter.send("one", "more");
    assert.deepEqual(ops(), ["agent/getStatus", "agent/steer"]);
    assert.deepEqual(calls[1].args, [{ sessionId: "one", content: "more", expectedTurnId: "turn-7" }]);
    await finishRefresh(adapter, "one");
    calls.length = 0;
    steerEnded = true;
    await adapter.send("one", "late");
    assert.deepEqual(ops(), ["agent/getStatus", "agent/steer", "agent/queue/push"]);
    await finishRefresh(adapter, "one");
    calls.length = 0;
    steerEnded = false;
    exposed = new Set();
    // Upstream: no steer/queue, so stop gracefully after the current step and prompt once idle.
    await adapter.send("one", "x");
    assert.deepEqual(ops(), ["agent/getStatus", "agent/steer", "agent/queue/push", "agent/stop"]);
    assert.deepEqual(calls.at(-1)!.args, [{ sessionId: "one", turnId: "turn-7" }]);
    await finishRefresh(adapter, "one");
    calls.length = 0;
    await adapter.send("one", "y");
    assert.deepEqual(ops(), ["agent/getStatus", "agent/stop"], "unsupported operations are not retried");
    await finishRefresh(adapter, "one");
    calls.length = 0;
    await (adapter as any).poll();
    assert.ok(!ops().includes("agent/prompt"), "nothing is sent while PI still runs");
    running = false;
    await (adapter as any).poll();
    await (adapter as any).poll();
    assert.deepEqual(calls.filter((call) => call.op === "agent/prompt").map((call) => call.args[0].content), ["x", "y"]);
    calls.length = 0;
    // Idle sessions with nothing queued still use a normal prompt.
    await adapter.send("one", "hi");
    assert.deepEqual(ops(), ["agent/getStatus", "agent/prompt"]);
  } finally {
    await adapter.stop();
    server.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("PI keeps polling briefly after a turn ends so a late final reply still reaches the page", async () => {
  const dir = mkdtempSync(join(tmpdir(), "aw-pi-settle-"));
  let running = true;
  let messages: any[] = [];
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString());
    res.setHeader("content-type", "application/json");
    if (body.method === "notifications/initialized") { res.writeHead(202); res.end(); return; }
    if (body.method === "initialize") { res.setHeader("mcp-session-id", "s"); res.end(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: {} })); return; }
    if (body.params.name === "pi_session_get") { res.end(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: { structuredContent: { session: { messages } } } })); return; }
    const op = body.params.arguments.operation;
    const ok = (value: any) => res.end(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: { structuredContent: { operation: op, result: value } } }));
    if (op === "agent/getStatus") return ok({ status: { isRunning: running } });
    if (op === "agent/pendingInteractive") return ok({ asks: [], permissions: [] });
    return ok({});
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  writeFileSync(join(dir, "mcp-control.json"), JSON.stringify({ active: true, url: `http://127.0.0.1:${port}`, token: "t" }));
  const hub = new Hub();
  const events: any[] = [];
  hub.subscribe((event) => events.push(event));
  const adapter = new PiAdapter(hub, dir);
  try {
    adapter.watch("one");
    await (adapter as any).poll();
    assert.ok(events.some((event) => event.type === "status" && event.status === "running"));
    (adapter as any).watched.get("one").until = 0; // the page stopped renewing its watch
    running = false;
    await (adapter as any).poll();
    assert.equal(events.at(-1).status, "idle");
    messages = [{ id: "final", role: "assistant", content: "全部完成", createdAt: new Date().toISOString() }];
    await (adapter as any).poll();
    assert.ok(events.some((event) => event.type === "item" && event.item.id === "final"), "the final reply persisted after idle is still delivered");
    for (let index = 0; index < 6; index++) await (adapter as any).poll();
    assert.ok(!(adapter as any).watched.has("one"), "polling stops once settled");
  } finally {
    await adapter.stop();
    server.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
