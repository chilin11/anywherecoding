import test from "node:test";
import assert from "node:assert/strict";
import { formatArgs } from "../util.ts";
import { mapCodexItem } from "./codex.ts";

test("tool arguments show real newlines instead of JSON escapes", () => {
  assert.equal(formatArgs({ path: "a.ts", content: "one\ntwo", count: 2, flags: { x: true } }),
    "path: a.ts\ncontent:\n  one\n  two\ncount: 2\nflags: {\"x\":true}");
  assert.equal(formatArgs("plain"), "plain");
  assert.equal(formatArgs(null), "");
  assert.ok(!formatArgs({ code: "a\nb" }).includes("\\n"));
});

test("Codex MCP results display their text content", () => {
  const ok = mapCodexItem({ type: "mcpToolCall", id: "m", server: "s", tool: "t", status: "completed", arguments: { q: "x" },
    result: { content: [{ type: "text", text: "{\"code\":1}\nsecond" }], structuredContent: null, _meta: { big: true } } });
  assert.equal(ok?.tool?.output, "{\"code\":1}\nsecond");
  assert.equal(ok?.tool?.input, "q: x");
  const failed = mapCodexItem({ type: "mcpToolCall", id: "e", server: "s", tool: "t", status: "failed", error: { message: "boom" } });
  assert.equal(failed?.tool?.output, "boom");
  assert.equal(failed?.tool?.status, "error");
  const structured = mapCodexItem({ type: "mcpToolCall", id: "j", server: "s", tool: "t", status: "completed", result: { content: [], structuredContent: { a: 1 } } });
  assert.match(structured?.tool?.output ?? "", /"a": 1/);
});
