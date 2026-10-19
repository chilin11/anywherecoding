import test from "node:test";
import assert from "node:assert/strict";
import { PiAdapter } from "./pi.ts";
import { Hub } from "../hub.ts";
import { parseConfigPatch, validateConfigPatch } from "../session-config.ts";

function fixture() {
  const adapter = new PiAdapter(new Hub());
  const calls: { operation: string; args: any[]; confirm: boolean }[] = [];
  let running = false;
  const session: any = {
    id: "test", mode: "plan", providerId: "provider", modelId: "model-a", thinkingLevel: "high", permissionMode: "inherit",
    messages: [{ id: "main", role: "assistant", providerId: "provider", modelId: "model-a", usage: { inputTokens: 100, outputTokens: 20, cacheReadTokens: 30, cacheWriteTokens: 5, reasoningTokens: 10 } }, { id: "sub", parentToolCallId: "task", usage: { inputTokens: 99999 } }],
  };
  (adapter as any).invoke = async (operation: string, args: any[] = [], confirm = false) => {
    calls.push({ operation, args, confirm });
    switch (operation) {
      case "providers/list": return { providers: [{ id: "provider", name: "Provider", enabled: true, models: [
        { id: "model-a", alias: "A", thinkingLevels: ["low", "high"], defaultThinkingLevel: "low", contextWindow: 500, contextWindowSource: "user" },
        { id: "model-b", thinkingLevels: ["medium"], defaultThinkingLevel: "medium", contextWindow: 400, contextWindowSource: "catalog" },
      ] }, { id: "disabled", enabled: false, models: [{ id: "hidden" }] }] };
      case "providers/listModels": return { models: [{ modelId: "model-a", contextWindow: 1000 }, { modelId: "model-b", contextWindow: 2000 }] };
      case "settings/get": return { settings: { defaultProviderId: "provider", defaultModelId: "model-a", defaultPermissionMode: "accept-edits" } };
      case "session/get": return { session: structuredClone(session) };
      case "agent/getStatus": return { status: { isRunning: running } };
      case "session/configure": Object.assign(session, args[1]); return { session: structuredClone(session) };
      case "session/create": return { session: { id: "test" } };
      case "agent/prompt": return { accepted: true };
      default: throw new Error(`unexpected ${operation}`);
    }
  };
  return { adapter, calls, session, setRunning: (value: boolean) => { running = value; } };
}

test("PI configuration uses enabled bindings, native permissions and last parent request context", async () => {
  const { adapter, session } = fixture();
  const config = await adapter.configuration("test");
  assert.equal(config.models.length, 2);
  assert.equal(config.models[0].label, "Provider · A");
  assert.equal(config.models[0].contextWindow, 500); // Manual override wins.
  assert.equal(config.models[1].contextWindow, 2000); // Catalog binding follows catalog.
  assert.deepEqual(config.models[0].thinkingLevels.map((level) => level.value), ["low", "high", "omit"]);
  assert.equal(config.effectivePermissionMode, "accept-edits");
  assert.equal(config.context?.usedTokens, 155); // Reasoning is already in output.
  assert.equal(config.context?.windowTokens, 500);
  session.messages = [];
  assert.equal((await adapter.configuration("test")).context?.usedTokens, null);
});

test("PI saves native fields, preserves mode, validates selected model and rejects active turns", async () => {
  const { adapter, calls, setRunning } = fixture();
  const model = JSON.stringify(["provider", "model-b"]);
  const config = await adapter.configure("test", { model, thinking: "medium", permissionMode: "ask" });
  const call = calls.find((entry) => entry.operation === "session/configure")!;
  assert.equal(call.confirm, true);
  assert.deepEqual(call.args, ["test", { mode: "plan", providerId: "provider", modelId: "model-b", thinkingLevel: "medium", permissionMode: "ask" }]);
  assert.equal(config.model, model);
  await assert.rejects(adapter.configure("test", { thinking: "high" }), /不支持/);
  setRunning(true);
  await assert.rejects(adapter.configure("test", { permissionMode: "auto" }), (error: any) => error.status === 409);
});

test("PI applies new-session choices before first prompt", async () => {
  const { adapter, calls } = fixture();
  await adapter.create("/workspace", "hello", { model: JSON.stringify(["provider", "model-a"]), thinking: "low", permissionMode: "ask" });
  assert.ok(calls.findIndex((call) => call.operation === "session/configure") < calls.findIndex((call) => call.operation === "agent/prompt"));
});

test("configuration wire validation rejects unexpected fields and types", () => {
  assert.throws(() => parseConfigPatch({ permissionMode: 1 }), /无效/);
  assert.throws(() => parseConfigPatch({ sandbox: "bypass" }), /无效/);
  assert.throws(() => parseConfigPatch(null), /无效/);
  assert.deepEqual(parseConfigPatch({ model: null, thinking: "high" }), { model: null, thinking: "high" });
  assert.throws(() => validateConfigPatch({ model: "missing" }, { model: null, thinking: null, permissionMode: null, models: [], permissionModes: [] }), /模型不可用/);
});
