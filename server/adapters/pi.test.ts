import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PiAdapter, mapPiMessage } from "./pi.ts";
import { Hub } from "../hub.ts";
import type { RelayEvent } from "../types.ts";

test("PI control envelopes, running state, equal-length edits and interactive resolution", async () => {
  const dir = mkdtempSync(join(tmpdir(), "aw-pi-test-"));
  const events: RelayEvent[] = [];
  const calls: any[] = [];
  let text = "first";
  let pending = true;
  const server = createServer(async (req, res) => {
    assert.equal(req.headers.authorization, "Bearer local-test-token");
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString());
    res.setHeader("content-type", "application/json");
    if (body.method === "notifications/initialized") { res.writeHead(202); res.end(); return; }
    if (body.method === "initialize") {
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
    assert.equal((await adapter.listSessions()).length, 1);
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
  assert.deepEqual(mapPiMessage({ id: "x", parentToolCallId: "delegate", role: "tool" }), []);
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
    calls.length = 0;
    steerEnded = true;
    await adapter.send("one", "late");
    assert.deepEqual(ops(), ["agent/getStatus", "agent/steer", "agent/queue/push"]);
    calls.length = 0;
    steerEnded = false;
    exposed = new Set();
    // Upstream: no steer/queue, so stop gracefully after the current step and prompt once idle.
    await adapter.send("one", "x");
    assert.deepEqual(ops(), ["agent/getStatus", "agent/steer", "agent/queue/push", "agent/stop"]);
    assert.deepEqual(calls.at(-1)!.args, [{ sessionId: "one", turnId: "turn-7" }]);
    calls.length = 0;
    await adapter.send("one", "y");
    assert.deepEqual(ops(), ["agent/getStatus", "agent/stop"], "unsupported operations are not retried");
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
