import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mapCodexItem, CodexAdapter } from "./codex.ts";
import { ClaudeAdapter } from "./claude.ts";
import { ClaudeItemBuilder, parseTranscript } from "./claude-transcript.ts";
import { Hub } from "../hub.ts";
import { validateConfigPatch } from "../session-config.ts";

const png = "iVBORw0KGgo=";
const image = { type: "image", source: { type: "base64", media_type: "image/png", data: png } };
const assistant = (id: string, name: string, input: object) => ({ type: "assistant", uuid: `assistant-${id}`, message: { content: [{ type: "tool_use", id, name, input }] } });
const result = (id: string, content: unknown, toolUseResult?: object, is_error = false) => ({ type: "user", uuid: `result-${id}`, toolUseResult, message: { content: [{ type: "tool_result", tool_use_id: id, content, is_error }] } });

test("Codex native terminal statuses, timings, file diffs and generated/viewed/input images", () => {
  const command = mapCodexItem({ type: "commandExecution", id: "cmd", command: "false", status: "completed", aggregatedOutput: "", exitCode: 7, durationMs: 19 })!;
  assert.equal(command.tool?.status, "error");
  assert.equal(command.tool?.exitCode, 7);
  assert.equal(command.tool?.durationMs, 19);
  assert.equal(mapCodexItem({ type: "commandExecution", id: "empty", status: "completed", exitCode: 0 })?.tool?.status, "ok");
  assert.equal(mapCodexItem({ type: "commandExecution", id: "unknown" })?.tool?.status, "running");
  assert.equal(mapCodexItem({ type: "commandExecution", id: "denied", status: "declined" })?.tool?.status, "denied");
  const edit = mapCodexItem({ type: "fileChange", id: "edit", status: "completed", changes: [
    { path: "/a.ts", kind: { type: "update" }, diff: "--- a/a.ts\n+++ b/a.ts\n@@ -1 +1,2 @@\n-old\n+new\n+line\n" },
    { path: "/b.ts", kind: { type: "add" }, diff: "+only\n" },
  ] })!;
  assert.equal(edit.tool?.additions, 3);
  assert.equal(edit.tool?.deletions, 1);
  assert.deepEqual(edit.tool?.files, [{ path: "/a.ts", additions: 2, deletions: 1 }, { path: "/b.ts", additions: 1, deletions: 0 }]);
  const generated = mapCodexItem({ type: "imageGeneration", id: "gen", status: "completed", result: png, savedPath: "/tmp/generated.png", failure: null, revisedPrompt: "A cat" })!;
  assert.equal(generated.kind, "tool");
  assert.equal(generated.tool?.status, "ok");
  assert.deepEqual(generated.images?.map((entry) => entry.src), [`data:image/png;base64,${png}`, "/tmp/generated.png"]);
  assert.equal(mapCodexItem({ type: "imageGeneration", id: "bad", status: "failed", result: "", failure: { message: "failed" } })?.tool?.status, "error");
  assert.equal(mapCodexItem({ type: "imageView", id: "view", path: "/tmp/view.png" })?.images?.[0]?.src, "/tmp/view.png");
  const user = mapCodexItem({ type: "userMessage", id: "user", content: [{ type: "text", text: "Look" }, { type: "localImage", path: "/tmp/local.png" }, { type: "image", url: "https://example.com/input.png" }] })!;
  assert.equal(user.text, "Look");
  assert.equal(user.images?.length, 2);
  const dynamic = mapCodexItem({ type: "dynamicToolCall", id: "dynamic", tool: "render", status: "completed", success: true, durationMs: 40, contentItems: [{ type: "inputText", text: "Rendered" }, { type: "inputImage", imageUrl: `data:image/png;base64,${png}` }] })!;
  assert.equal(dynamic.tool?.output, "Rendered");
  assert.equal(dynamic.images?.length, 1);
  const mcp = mapCodexItem({ type: "mcpToolCall", id: "mcp", server: "screen", tool: "capture", status: "completed", result: { content: [{ type: "image", data: png, mimeType: "image/png" }] } })!;
  assert.equal(mcp.images?.length, 1);
});

test("Codex notifications force started tools running and emit terminal updates without output", () => {
  const hub = new Hub();
  const adapter = new CodexAdapter(hub);
  const events: any[] = [];
  hub.subscribe((event) => events.push(event));
  const notify = (method: string, item: object) => (adapter as any).onNotification(method, { threadId: "fixture", item });
  notify("item/started", { type: "imageView", id: "view", path: "/tmp/view.png", status: "completed" });
  assert.equal(events.at(-1).item.tool.status, "running");
  notify("item/completed", { type: "imageView", id: "view", path: "/tmp/view.png" });
  assert.equal(events.at(-1).item.tool.status, "ok");
  notify("item/started", { type: "commandExecution", id: "interrupted" });
  (adapter as any).onNotification("turn/completed", { threadId: "fixture", turn: { status: "interrupted" } });
  const terminal = events.filter((event) => event.type === "item").at(-1).item;
  assert.equal(terminal.id, "interrupted");
  assert.equal(terminal.tool.status, "error");
});

test("Codex prefix aliases inherit thinking only through explicit alias mapping; default permissions come from config/read", async () => {
  const adapter = new CodexAdapter(new Hub());
  let currentModel = "codex/gpt-6.1-sol";
  let sandbox_mode = "workspace-write";
  (adapter as any).rpc = { alive: true, request: async (method: string) => {
    if (method === "model/list") return { data: [{ model: "gpt-6.1-sol", displayName: "Sol", defaultReasoningEffort: "high", supportedReasoningEfforts: [{ reasoningEffort: "high" }] }] };
    if (method === "config/read") return { config: { model: currentModel, approval_policy: "on-request", sandbox_mode } };
    throw Error(method);
  } };
  const config = await adapter.configuration(null);
  assert.equal(config.permissionMode, "workspace-write");
  assert.equal(config.models.find((model) => model.value === currentModel)?.thinkingLevels[0]?.value, "high");
  assert.doesNotThrow(() => validateConfigPatch({ thinking: "high" }, config));
  currentModel = "unrelated/gpt-6.1-sol";
  sandbox_mode = "read-only";
  const unknown = await adapter.configuration(null);
  assert.equal(unknown.permissionMode, "read-only");
  assert.deepEqual(unknown.models.find((model) => model.value === currentModel)?.thinkingLevels, []);
  assert.throws(() => validateConfigPatch({ thinking: "high" }, unknown));
});

test("Claude structuredPatch overrides Edit fallback and preserves result images, ids and native timings", () => {
  const builder = new ClaudeItemBuilder();
  const started = builder.add(assistant("edit", "Edit", { file_path: "/before.ts", old_string: "old\n", new_string: "new\n" }))[0];
  assert.equal(started.tool?.additions, 1);
  assert.equal(started.tool?.deletions, 1);
  const completed = builder.add(result("edit", [image], { filePath: "/actual.ts", structuredPatch: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 2, lines: [" context", "-old", "+new", "+extra"] }], durationMs: 125, exitCode: 0 }))[0];
  assert.equal(completed.id, started.id);
  assert.equal(completed.tool?.status, "ok");
  assert.equal(completed.tool?.durationMs, 125);
  assert.equal(completed.tool?.exitCode, 0);
  assert.deepEqual(completed.tool?.files, [{ path: "/actual.ts", additions: 2, deletions: 1 }]);
  assert.equal(completed.images?.[0]?.src, `data:image/png;base64,${png}`);
  builder.add(result("edit", "replayed"));
  assert.equal(builder.tools.get("edit")?.additions, 2);
  assert.equal(builder.add(assistant("edit", "Edit", { file_path: "/before.ts", old_string: "old", new_string: "new" })).length, 0);
  assert.equal(builder.tools.get("edit")?.status, "ok");
  const duplicate = builder.add(result("edit", "echoed", { filePath: "/actual.ts", structuredPatch: [] }))[0];
  assert.equal(duplicate.images?.length, 1);
  assert.equal(duplicate.tool?.additions, 0);
  assert.equal(builder.items.length, 1);
});

test("Claude MultiEdit and Write counts, result images and interrupted/denied tools", () => {
  const builder = new ClaudeItemBuilder();
  const multi = builder.add(assistant("multi", "MultiEdit", { file_path: "/multi.ts", edits: [{ old_string: "a", new_string: "b\nc\n" }, { old_string: "d\ne", new_string: "" }] }))[0];
  assert.equal(multi.tool?.additions, 2);
  assert.equal(multi.tool?.deletions, 3);
  const write = builder.add(assistant("write", "Write", { file_path: "/write.ts", content: "a\nb\n" }))[0];
  assert.equal(write.tool?.additions, 2);
  const written = builder.add(result("write", "done", { type: "update", filePath: "/write.ts", content: "x\n", originalFile: "a\nb\n", structuredPatch: [{ lines: ["-a", "-b", "+x"] }] }))[0];
  assert.equal(written.tool?.additions, 1);
  assert.equal(written.tool?.deletions, 2);
  builder.add(assistant("shell", "Bash", { command: "pwd" }));
  const shell = builder.add(result("shell", "", { stdout: "", stderr: "", interrupted: true, duration_ms: 17, exit_code: 130, images: [image] }))[0];
  assert.equal(shell.tool?.status, "error");
  assert.equal(shell.tool?.durationMs, 17);
  assert.equal(shell.images?.length, 1);
  builder.add(assistant("denied", "Bash", { command: "rm file" }));
  builder.deny("denied", "用户拒绝");
  builder.finishPending("cancelled");
  assert.equal(builder.tools.get("multi")?.status, "error");
  assert.equal(builder.tools.get("denied")?.status, "denied");
  const denied = builder.add(result("denied", "Permission denied", undefined, true))[0];
  assert.equal(denied.tool?.status, "denied");
  assert.equal(builder.add({ type: "assistant", uuid: "image-a", message: { content: [image] } })[0].images?.length, 1);
  assert.equal(builder.add({ type: "user", uuid: "image-u", message: { content: [image] } })[0].images?.length, 1);
});

test("Claude transcript and live builder retain identical tool ids and image results", () => {
  const dir = mkdtempSync(join(process.env.PI_SCRATCH_DIR ?? tmpdir(), "artifact-fixture-"));
  try {
    const path = join(dir, "fixture.jsonl");
    const lines = [assistant("capture", "Read", { file_path: "/screen.png" }), result("capture", [image], { filePath: "/screen.png" })];
    writeFileSync(path, lines.map((line) => JSON.stringify(line)).join("\n"));
    const live = new ClaudeItemBuilder();
    for (const line of lines) live.add(line);
    assert.deepEqual(parseTranscript(path).map(({ id, images, tool }) => ({ id, images, tool })), live.items.map(({ id, images, tool }) => ({ id, images, tool })));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("Claude result and exit publish pending tool terminals before idle, preserving denied", () => {
  const hub = new Hub();
  const adapter = new ClaudeAdapter(hub, undefined, []);
  const events: any[] = [];
  hub.subscribe((event) => events.push(event));
  const run: any = { sessionId: "fixture", builder: new ClaudeItemBuilder(), controls: new Map(), busy: true, exited: false, idleTimer: null, stderrTail: "" };
  run.builder.add(assistant("pending", "Bash", { command: "pwd" }));
  run.builder.add(assistant("denied", "Bash", { command: "rm file" }));
  run.builder.deny("denied", "denied");
  run.builder.add(assistant("cancelled", "Bash", { command: "pwd" }));
  run.controls.set("cancel-request", { toolUseId: "cancelled" });
  (adapter as any).onMessage(run, { type: "control_cancel_request", request_id: "cancel-request" });
  assert.equal(run.builder.tools.get("cancelled").status, "error");
  (adapter as any).onMessage(run, { type: "result", is_error: true });
  clearTimeout(run.idleTimer);
  assert.equal(events.find((event) => event.type === "item").item.tool.status, "error");
  assert.equal(run.builder.tools.get("denied").status, "denied");
  run.builder.add(assistant("exit", "Bash", { command: "pwd" }));
  (adapter as any).onExit(run, 1);
  assert.equal(events.filter((event) => event.type === "item" && event.item.id === "exit").at(-1).item.tool.status, "error");
});
