import test from "node:test";
import assert from "node:assert/strict";
import { Hub } from "../hub.ts";
import { errorText } from "../errors.ts";
import { CodexAdapter } from "./codex.ts";
import { ClaudeAdapter } from "./claude.ts";
import { ClaudeItemBuilder } from "./claude-transcript.ts";

test("native diagnostic fields remain readable without unrelated request payloads", () => {
  const value = errorText({ message: "Rate limit", errors: ["429 retry later", { message: "quota exhausted" }], code: "rate_limit", requestId: "req-1", additionalDetails: "Try again", apiKey: "must-not-display", input: "private prompt" });
  for (const text of ["Rate limit", "429 retry later", "quota exhausted", "rate_limit", "req-1", "Try again"]) assert.ok(value.includes(text));
  assert.ok(!value.includes("must-not-display")); assert.ok(!value.includes("private prompt"));
  assert.equal(errorText({}, "failed"), "failed");
});

test("session errors are emitted as transcript items, retained with stable ids and bounded", () => {
  const hub = new Hub(); const events: any[] = []; hub.subscribe((event) => events.push(event));
  hub.notice("error", "connection lost", "codex:test");
  assert.equal(events.at(-2).item.kind, "error");
  assert.equal(hub.errorItems("codex:test")[0].text, "connection lost");
  hub.item("codex:test", { id: "same", kind: "error", text: "first" });
  hub.item("codex:test", { id: "same", kind: "error", text: "updated" });
  assert.equal(hub.errorItems("codex:test").filter((item) => item.id === "same").length, 1);
  for (let i = 0; i < 40; i++) hub.item("codex:test", { id: String(i), kind: "error", text: String(i) });
  assert.equal(hub.errorItems("codex:test").length, 30);
  hub.clearAgent("codex"); assert.deepEqual(hub.errorItems("codex:test"), []);
});

test("Codex retries retain diagnostic details without ending the turn; final errors restore idle and history", async () => {
  const hub = new Hub(); const adapter: any = new CodexAdapter(hub);
  adapter.onNotification("turn/started", { threadId: "test", turn: { id: "turn" } });
  adapter.onNotification("error", { threadId: "test", error: { message: "HTTP 429", code: "quota", additionalDetails: "retry later" }, willRetry: true });
  assert.equal(hub.liveStatus("codex:test"), "running");
  assert.match(hub.errorItems("codex:test")[0].text, /HTTP 429[\s\S]*retry later[\s\S]*自动重试/);
  adapter.onNotification("turn/completed", { threadId: "test", turn: { id: "turn", status: "failed", error: { message: "HTTP 401", code: "auth", additionalDetails: "login again" } } });
  assert.equal(hub.liveStatus("codex:test"), "idle");
  assert.match(hub.errorItems("codex:test").at(-1)!.text, /HTTP 401[\s\S]*login again[\s\S]*auth/);
  adapter.rpc = { alive: true, request: async () => ({ data: [{ id: "turn", status: "failed", error: { message: "HTTP 401", code: "auth" }, items: [] }], nextCursor: null }) };
  assert.match((await adapter.history("test", null)).items[0].text, /HTTP 401[\s\S]*auth/);
});

test("Claude error results preserve native errors array in both live and replay, exit diagnostics remain visible", () => {
  const hub = new Hub(); const adapter: any = new ClaudeAdapter(hub, undefined, []);
  const run: any = { sessionId: "test", builder: new ClaudeItemBuilder(), controls: new Map(), busy: true, exited: false, idleTimer: null, stderrTail: "network disconnected" };
  const message = { type: "result", uuid: "failure", is_error: true, subtype: "error_during_execution", errors: ["API Error: 429", "retry budget exceeded"] };
  adapter.onMessage(run, message); clearTimeout(run.idleTimer);
  const error = hub.errorItems("claude:test")[0]; assert.match(error.text, /API Error: 429[\s\S]*retry budget exceeded/);
  assert.equal(hub.liveStatus("claude:test"), "idle");
  assert.equal(new ClaudeItemBuilder().add(message)[0].text, error.text);
  adapter.onMessage(run, { type: "error", error: { message: "authentication failed", code: "401" } });
  assert.match(hub.errorItems("claude:test").at(-1)!.text, /authentication failed[\s\S]*401/);
  run.busy = true; adapter.onExit(run, 1);
  assert.match(hub.errorItems("claude:test").at(-1)!.text, /进程退出[\s\S]*network disconnected/);
});
