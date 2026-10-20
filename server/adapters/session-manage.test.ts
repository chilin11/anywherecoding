import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hub } from "../hub.ts";

test("Claude rename appends a native custom-title; delete moves transcript and sidecar folder to the relay trash", async () => {
  const root = mkdtempSync(join(tmpdir(), "aw-claude-manage-"));
  const previous = { config: process.env.CLAUDE_CONFIG_DIR, home: process.env.ANYWHERE_HOME, trash: process.env.ANYWHERE_TRASH };
  process.env.CLAUDE_CONFIG_DIR = join(root, "claude");
  process.env.ANYWHERE_HOME = join(root, "aw");
  process.env.ANYWHERE_TRASH = join(root, "trash");
  try {
    const project = join(root, "claude", "projects", "-tmp-project");
    mkdirSync(join(project, "abc", "subagents"), { recursive: true });
    const transcript = join(project, "abc.jsonl");
    writeFileSync(transcript, JSON.stringify({ type: "user", cwd: root, message: { content: "first prompt" }, sessionId: "abc" }) + "\n");
    const { ClaudeAdapter } = await import(`./claude.ts?manage=${Date.now()}`);
    const hub = new Hub();
    const adapter = new ClaudeAdapter(hub, process.execPath, []);
    assert.equal((await adapter.listSessions())[0]?.title, "first prompt");

    hub.status("claude:abc", "running");
    await assert.rejects(adapter.rename("abc", "Busy"), (error: any) => error.status === 409);
    await assert.rejects(adapter.remove("abc"), (error: any) => error.status === 409);
    hub.status("claude:abc", "idle");

    await adapter.rename("abc", "My title");
    assert.deepEqual(JSON.parse(readFileSync(transcript, "utf8").trim().split("\n").at(-1)!), { type: "custom-title", customTitle: "My title", sessionId: "abc" });
    assert.equal((await adapter.listSessions())[0]?.title, "My title");

    await adapter.remove("abc");
    assert.equal(existsSync(transcript), false);
    assert.equal(existsSync(join(project, "abc")), false);
    assert.deepEqual(await adapter.listSessions(), []);
    const trashed = readdirSync(join(root, "trash", "claude"));
    assert.equal(trashed.filter((name) => name.endsWith("-abc.jsonl")).length, 1);
    assert.equal(trashed.filter((name) => name.endsWith("-abc")).length, 1);
    assert.equal(hub.liveStatus("claude:abc"), undefined);
  } finally {
    for (const [key, value] of [["CLAUDE_CONFIG_DIR", previous.config], ["ANYWHERE_HOME", previous.home], ["ANYWHERE_TRASH", previous.trash]] as const) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    rmSync(root, { recursive: true, force: true });
  }
});

test("Hub.forget drops approvals, status and relay errors of a deleted session", () => {
  const hub = new Hub();
  hub.status("codex:t", "running");
  hub.addApproval({ id: "a", sessionId: "codex:t", agent: "codex", title: "x", detail: "", choices: [], createdAt: 0 });
  hub.notice("error", "boom", "codex:t");
  hub.forget("codex:t");
  assert.equal(hub.liveStatus("codex:t"), undefined);
  assert.deepEqual(hub.pendingApprovals(), []);
  assert.deepEqual(hub.errorItems("codex:t"), []);
});
