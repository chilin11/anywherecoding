import test from "node:test";
import assert from "node:assert/strict";
import { summarize } from "../status.ts";
import type { Approval, SessionSummary } from "../types.ts";

const session = (id: string, status: SessionSummary["status"], updatedAt: number): SessionSummary => ({
  id, agent: id.startsWith("claude:") ? "claude" : "codex", nativeId: id.split(":")[1]!, title: `title ${id}`, cwd: "/p", updatedAt, status,
});
const approval = (id: string, sessionId: string): Approval => ({
  id, sessionId, agent: "pi", title: `approve ${sessionId}`, detail: "", choices: [{ id: "allow", label: "允许" }], createdAt: 5,
});

test("status snapshot mirrors web counting: approvals override, orphan approvals counted, active list ordered", () => {
  const sessions = [
    session("codex:a", "running", 10),
    session("claude:b", "running", 30),
    session("codex:c", "idle", 40),
    session("codex:d", "unknown", 1),
    session("codex:a", "running", 10),
  ];
  const snapshot = summarize(sessions, [approval("pi:1", "claude:b"), approval("pi:2", "pi:orphan")], [{ agent: "codex", ok: true }], { pi: "down" }, "9.9.9");
  assert.equal(snapshot.running, 1);
  assert.equal(snapshot.approval, 2);
  assert.equal(snapshot.unknown, 1);
  assert.deepEqual(snapshot.active.map((entry) => [entry.id, entry.status]), [["claude:b", "approval"], ["pi:orphan", "approval"], ["codex:a", "running"]]);
  assert.equal(snapshot.active[1]!.title, "approve pi:orphan");
  assert.equal(snapshot.version, "9.9.9");
  assert.deepEqual(snapshot.errors, { pi: "down" });
});

test("status snapshot caps the active list but keeps full counts", () => {
  const sessions = Array.from({ length: 30 }, (_, index) => session(`codex:${index}`, "running", index));
  const snapshot = summarize(sessions, [], [], {}, "1");
  assert.equal(snapshot.running, 30);
  assert.equal(snapshot.active.length, 20);
  assert.equal(snapshot.active[0]!.id, "codex:29");
});
