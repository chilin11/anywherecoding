import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Connections, parseAgent } from "../connections.ts";
import { Hub, type Adapter } from "../hub.ts";
import type { Agent } from "../types.ts";

test("connections default empty, probe disposable, persist explicit add, remove preserves native history", async () => {
  const root = mkdtempSync(join(tmpdir(), "aw-connections-"));
  const hub = new Hub();
  const made: { agent: Agent; stopped: boolean; started: number }[] = [];
  let fail = false;
  const factory = (agent: Agent): Adapter => {
    const state = { agent, stopped: false, started: 0 }; made.push(state);
    return { agent, async start() { state.started++; }, async stop() { state.stopped = true; }, availability: () => ({ agent, ok: true }),
      async configuration() { if (fail) throw new Error("未检测到 Pi CLI"); return { model: null, thinking: null, permissionMode: null, models: [], permissionModes: [] }; },
      async listSessions() { return []; }, async history() { return { items: [], before: null }; }, async send() {}, async create() { return "new"; }, async configure() { throw Error("unused"); }, async interrupt() {}, async resolve() {} };
  };
  try {
    const path = join(root, "connections.json"); const manager = new Connections(path, hub, factory);
    await manager.start(); assert.equal(made.length, 0); assert.deepEqual(manager.availability(), []); assert.ok(manager.list().every((entry) => !entry.enabled));
    assert.equal((await manager.detect("pi-native")).ok, true); assert.equal(made.at(-1)?.stopped, true); assert.equal(manager.adapters.size, 0);
    fail = true; await assert.rejects(manager.add("pi-native"), /未检测到 Pi CLI/); assert.equal(made.at(-1)?.stopped, true); assert.equal(manager.adapters.size, 0);
    fail = false; await Promise.all([manager.add("pi-native"), manager.add("pi-native")]); assert.equal(manager.adapters.size, 1);
    assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), { enabled: ["pi-native"] });
    const restored = new Connections(path, new Hub(), factory); assert.equal(restored.adapters.size, 1);
    hub.status("pi-native:task", "running"); await assert.rejects(manager.remove("pi-native"), { status: 409 }); assert.equal(manager.adapters.size, 1);
    hub.status("pi-native:task", "idle"); await manager.remove("pi-native"); assert.equal(manager.adapters.size, 0); assert.equal(hub.liveStatus("pi-native:task"), undefined);
    assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), { enabled: [] });
    assert.throws(() => parseAgent("other"), { status: 400 }); assert.equal(parseAgent("pi-native"), "pi-native");
    for (const adapter of restored.adapters.values()) await adapter.stop();
  } finally { rmSync(root, { recursive: true, force: true }); }
});
