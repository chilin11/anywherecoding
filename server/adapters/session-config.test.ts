import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { CodexAdapter } from "./codex.ts";
import { ClaudeAdapter } from "./claude.ts";
import { Hub } from "../hub.ts";

const scratch = process.env.PI_SCRATCH_DIR ?? tmpdir();

test("Codex applies configuration on first turn, restores native policy and persists overrides", async () => {
  const dir = mkdtempSync(join(scratch, "codex-config-"));
  const previousHome = process.env.ANYWHERE_HOME;
  process.env.ANYWHERE_HOME = dir;
  const hub = new Hub();
  const adapter = new CodexAdapter(hub);
  const calls: any[] = [];
  const sandbox = { type: "workspaceWrite", writableRoots: ["/original"], networkAccess: true, excludeTmpdirEnvVar: true, excludeSlashTmp: false };
  const native = { model: "native", reasoningEffort: "medium", approvalPolicy: "untrusted", sandbox };
  const rpc = { alive: true, kill() {}, async request(method: string, params: any) {
    calls.push({ method, params });
    if (method === "model/list") return { data: ["native", "selected"].map((model) => ({ model, displayName: model, isDefault: model === "native", supportedReasoningEfforts: ["medium", "high"].map((reasoningEffort) => ({ reasoningEffort })) })) };
    if (method === "config/read") return { config: { model: "native" } };
    if (method === "thread/start" || method === "thread/resume") return { ...native, thread: { id: "one" } };
    if (method === "thread/read") return { thread: { id: "one", model: "native", reasoningEffort: "medium", status: { type: "idle" } } };
    if (method === "turn/start") return { turn: { id: "turn" } };
    throw new Error(method);
  } };
  (adapter as any).rpc = rpc;
  try {
    assert.equal(await adapter.create(dir, "first", { model: "selected", thinking: "high", permissionMode: "workspace-write" }), "one");
    const first = calls.find((call) => call.method === "turn/start").params;
    assert.equal(first.model, "selected");
    assert.equal(first.effort, "high");
    assert.equal(first.approvalPolicy, "on-request");
    assert.equal(first.sandboxPolicy.type, "workspaceWrite");
    assert.equal(first.sandboxPolicy.networkAccess, false);
    await assert.rejects(adapter.configure("one", { model: "native" }), { status: 409 });
    (adapter as any).onNotification("turn/completed", { threadId: "one", turn: {} });
    await adapter.configure("one", { model: null, thinking: null, permissionMode: null });
    await adapter.send("one", "restore");
    const restored = calls.filter((call) => call.method === "turn/start").at(-1).params;
    assert.equal(restored.model, "native");
    assert.equal(restored.effort, "medium");
    assert.equal(restored.approvalPolicy, "untrusted");
    assert.deepEqual(restored.sandboxPolicy, sandbox);
    const next = new CodexAdapter(new Hub());
    (next as any).rpc = rpc;
    assert.equal((await next.configuration("one")).model, null);
    assert.equal(JSON.parse(readFileSync(join(dir, "codex-session-config.json"), "utf8")).one.patch.permissionMode, null);
    await next.stop();
  } finally {
    await adapter.stop();
    if (previousHome === undefined) delete process.env.ANYWHERE_HOME; else process.env.ANYWHERE_HOME = previousHome;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Claude discovers actual models, configures first send and idle restart, preserves tool approvals", async () => {
  const dir = mkdtempSync(join(scratch, "claude-config-"));
  const previousHome = process.env.ANYWHERE_HOME;
  process.env.ANYWHERE_HOME = dir;
  const bin = join(dir, "claude");
  writeFileSync(bin, `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
if (args.includes('--help')) { console.log('--permission-mode <mode> (choices: "manual", "acceptEdits", "plan")\\n--effort <level>'); process.exit(); }
fs.appendFileSync(${JSON.stringify(join(dir, "args.jsonl"))}, JSON.stringify(args)+'\\n');
require('node:readline').createInterface({input: process.stdin}).on('line', line => {
  const m = JSON.parse(line);
  const emit = x => console.log(JSON.stringify(x));
  if (m.type === 'control_request') emit({ type:'control_response', response:{subtype:'success',request_id:m.request_id,response:{models:[{value:'real',displayName:'Real',supportedEffortLevels:['low','high']}]}} });
  if (m.type === 'user') {
    emit({type:'system',subtype:'init',session_id:'session',model:'real',permissionMode:'manual'});
    emit({type:'control_request',request_id:'permission',request:{subtype:'can_use_tool',tool_name:'Bash',input:{command:'pwd'}}});
    emit({type:'result'});
  }
});
`, { mode: 0o700 });
  const hub = new Hub();
  const adapter = new ClaudeAdapter(hub, bin, []);
  const events: any[] = [];
  hub.subscribe((event) => events.push(event));
  (adapter as any).cwdFor = () => dir;
  (adapter as any).pathFor = () => null;
  try {
    const config = await adapter.configuration(null);
    assert.deepEqual(config.models.map((model) => model.value), ["real"]);
    assert.deepEqual(config.models[0].thinkingLevels.map((level) => level.value), ["low", "high"]);
    assert.ok(!config.permissionModes.some((mode) => mode.value === "bypassPermissions"));
    assert.equal(await adapter.create(dir, "first", { model: "real", thinking: "high", permissionMode: "manual" }), "session");
    let run = (adapter as any).runs.get("session");
    for (let i = 0; i < 100 && !events.some((event) => event.type === "approval"); i++) await delay(10);
    assert.ok(events.some((event) => event.type === "approval"));
    await assert.rejects(adapter.configure("session", { thinking: "low" }), { status: 409 });
    await adapter.resolve("claude:permission", { choice: "allow" });
    await adapter.configure("session", { thinking: "low", permissionMode: "plan" });
    assert.equal(run.alive, false);
    await adapter.send("session", "second");
    run = (adapter as any).runs.get("session");
    const lines = readFileSync(join(dir, "args.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
    const first = lines.find((args) => args.includes("--model"));
    assert.equal(first[first.indexOf("--effort") + 1], "high");
    // Spawn writes its args asynchronously; wait for its first output.
    await new Promise<void>((resolve) => run.child.stdout.once("data", () => resolve()));
    const last = JSON.parse(readFileSync(join(dir, "args.jsonl"), "utf8").trim().split("\n").at(-1)!);
    assert.equal(last[last.indexOf("--effort") + 1], "low");
    assert.equal(last[last.indexOf("--permission-mode") + 1], "plan");
    assert.ok(last.includes("--permission-prompt-tool"));
    assert.equal(JSON.parse(readFileSync(join(dir, "claude-session-config.json"), "utf8")).session.thinking, "low");
    const exit = once(run.child, "exit");
    await adapter.stop(); await exit;
  } finally {
    await adapter.stop();
    if (previousHome === undefined) delete process.env.ANYWHERE_HOME; else process.env.ANYWHERE_HOME = previousHome;
    rmSync(dir, { recursive: true, force: true });
  }
});
