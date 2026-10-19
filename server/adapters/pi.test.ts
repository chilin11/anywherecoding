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
