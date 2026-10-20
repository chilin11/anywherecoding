// Parsing of Claude Code's own session files (~/.claude/projects/<dir>/<id>.jsonl).
import { closeSync, openSync, readFileSync, readSync, statSync } from "node:fs";
import type { Item, ToolInfo } from "../types.ts";
import { asText, clip } from "../util.ts";
import { extractImages, textLineCount } from "../artifacts.ts";
import { errorText } from "../errors.ts";

type Json = Record<string, any>;

const REMINDER = /<system-reminder>[\s\S]*?<\/system-reminder>/g;

export function cleanUserText(text: string): string {
  return text.replace(REMINDER, "").trim();
}

/** A one-line summary of a tool call's input, falling back to its JSON. */
export function toolInput(name: string, input: Json | undefined): string {
  if (!input) return "";
  if (typeof input.command === "string") return input.command;
  if (typeof input.file_path === "string") {
    if (name === "Edit" && typeof input.old_string === "string") {
      return `${input.file_path}\n--- old\n${input.old_string}\n+++ new\n${input.new_string ?? ""}`;
    }
    return input.file_path;
  }
  if (typeof input.pattern === "string") return `${input.pattern}${input.path ? `  in ${input.path}` : ""}`;
  if (typeof input.url === "string") return input.url;
  if (typeof input.description === "string" && typeof input.prompt === "string") return `${input.description}\n\n${input.prompt}`;
  return asText(input);
}

export function toolResultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map((part: Json) => (part?.type === "text" ? part.text : part?.type === "image" ? "[图片]" : "")).join("\n");
  }
  return asText(content);
}

function editStats(name: string, input: Json, result?: Json): Pick<ToolInfo, "additions" | "deletions" | "files"> {
  const path = result?.filePath ?? result?.file_path ?? input.file_path;
  if (typeof path !== "string" || !["Edit", "MultiEdit", "Write"].includes(name)) return {};
  let additions = 0;
  let deletions = 0;
  if (Array.isArray(result?.structuredPatch)) {
    for (const hunk of result.structuredPatch) {
      // Hunk lines contain literal source prefixes, including source text starting ++/--.
      for (const line of hunk.lines ?? []) {
        if (typeof line !== "string") continue;
        if (line.startsWith("+")) additions++;
        else if (line.startsWith("-")) deletions++;
      }
    }
  } else if (name === "Write") {
    additions = textLineCount(typeof result?.content === "string" ? result.content : input.content ?? "");
    if (typeof result?.originalFile === "string") deletions = textLineCount(result.originalFile);
  } else {
    const edits = name === "MultiEdit" ? input.edits ?? [] : [input];
    for (const edit of edits) {
      additions += textLineCount(edit.new_string ?? "");
      deletions += textLineCount(edit.old_string ?? "");
    }
  }
  return { additions, deletions, files: [{ path, additions, deletions }] };
}

function resultMetrics(...values: Json[]): Pick<ToolInfo, "exitCode" | "durationMs"> {
  const metrics: Pick<ToolInfo, "exitCode" | "durationMs"> = {};
  for (const value of values) {
    const exitCode = value?.exitCode ?? value?.exit_code;
    const durationMs = value?.durationMs ?? value?.duration_ms;
    if (typeof exitCode === "number") metrics.exitCode = exitCode;
    if (typeof durationMs === "number") metrics.durationMs = durationMs;
  }
  return metrics;
}

/**
 * Turn Claude message envelopes (JSONL lines or stream-json events, which share
 * the shape) into items. Tool results update the tool item they answer, so the
 * caller keeps `tools` across calls.
 */
export class ClaudeItemBuilder {
  readonly items: Item[] = [];
  private readonly index = new Map<string, number>();
  readonly tools = new Map<string, ToolInfo>();
  private readonly inputs = new Map<string, Json>();
  private readonly nativeResults = new Map<string, Json>();

  private put(item: Item): Item {
    const at = this.index.get(item.id);
    if (at === undefined) {
      this.index.set(item.id, this.items.length);
      this.items.push(item);
    } else {
      this.items[at] = item;
    }
    return item;
  }

  finishPending(output: string, ts = Date.now()): Item[] {
    const changed: Item[] = [];
    for (const [id, tool] of this.tools) {
      if (tool.status !== "running") continue;
      tool.status = "error";
      tool.output = tool.output || output;
      const previous = this.items[this.index.get(id)!];
      changed.push(this.put({ ...previous, id, kind: "tool", text: "", ts, tool: { ...tool } }));
    }
    return changed;
  }

  deny(id: string, output: string): Item | null {
    const tool = this.tools.get(id);
    if (!tool) return null;
    tool.status = "denied";
    tool.output = output;
    return this.put({ ...this.items[this.index.get(id)!], id, kind: "tool", text: "", tool: { ...tool } });
  }

  cancel(id: string, output: string): Item | null {
    const tool = this.tools.get(id);
    if (!tool || tool.status !== "running") return null;
    tool.status = "error";
    tool.output = tool.output || output;
    return this.put({ ...this.items[this.index.get(id)!], id, kind: "tool", text: "", tool: { ...tool } });
  }

  /** Returns the items created or updated by this envelope. */
  add(line: Json): Item[] {
    if (line.type === "result" && (line.is_error || String(line.subtype ?? "").startsWith("error"))) {
      return [this.put({ id: `result:${line.uuid ?? line.session_id ?? "error"}`, kind: "error", text: errorText(line, "Claude 请求失败"), ts: line.timestamp ? Date.parse(line.timestamp) : Date.now() })];
    }
    if ((line.type !== "user" && line.type !== "assistant") || line.isSidechain || line.isMeta) return [];
    const message = line.message as Json | undefined;
    if (!message) return [];
    const ts = line.timestamp ? Date.parse(line.timestamp) : Date.now();
    const uuid: string = line.uuid ?? message.id ?? `${ts}`;
    const blocks: Json[] = typeof message.content === "string" ? [{ type: "text", text: message.content }] : message.content ?? [];
    const changed: Item[] = [];
    blocks.forEach((block, position) => {
      const id = `${uuid}:${position}`;
      if (line.type === "user") {
        if (block.type === "text") {
          const text = cleanUserText(block.text ?? "");
          if (text) changed.push(this.put({ id, kind: "user", text, ts }));
        } else if (block.type === "image") {
          changed.push(this.put({ id, kind: "user", text: "", ts, images: extractImages(block) }));
        } else if (block.type === "tool_result") {
          const tool = this.tools.get(block.tool_use_id);
          if (!tool) return;
          const resultBlocks = blocks.filter((part) => part.type === "tool_result");
          const native = block.toolUseResult ?? (resultBlocks.length === 1 || line.toolUseResult?.tool_use_id === block.tool_use_id ? line.toolUseResult : undefined);
          const result: Json = { ...this.nativeResults.get(block.tool_use_id), ...(native && typeof native === "object" && !Array.isArray(native) ? native : {}) };
          this.nativeResults.set(block.tool_use_id, result);
          const output = block.content == null && (typeof result.stdout === "string" || typeof result.stderr === "string")
            ? [result.stdout, result.stderr].filter(Boolean).join("\n") : toolResultText(block.content);
          tool.output = clip(output);
          Object.assign(tool, resultMetrics(line, result, block));
          const denied = tool.status === "denied" || line.permissionDecision === "deny" || line.permissionDecision?.behavior === "deny" || result.status === "denied"
            || (block.is_error && /permission.*denied|user.*(denied|rejected)|用户.*拒绝/i.test(output));
          tool.status = denied ? "denied" : block.is_error || result.is_error || result.isError || result.interrupted || ["cancelled", "canceled", "interrupted", "failed"].includes(result.status) || (tool.exitCode != null && tool.exitCode !== 0) ? "error" : "ok";
          Object.assign(tool, editStats(tool.name, this.inputs.get(block.tool_use_id) ?? {}, result));
          const previous = this.items[this.index.get(block.tool_use_id)!];
          const images = [...(previous?.images ?? []), ...extractImages([block.content, native])].filter((image, index, all) => all.findIndex((candidate) => candidate.src === image.src) === index);
          changed.push(this.put({ ...previous, id: block.tool_use_id, kind: "tool", text: "", ts, tool: { ...tool }, ...(images.length ? { images } : {}) }));
        }
        return;
      }
      if (block.type === "text" && block.text?.trim()) {
        changed.push(this.put({ id, kind: line.error || message.error ? "error" : "assistant", text: block.text, ts }));
      } else if (block.type === "image") {
        changed.push(this.put({ id, kind: "assistant", text: "", ts, images: extractImages(block) }));
      } else if (block.type === "thinking" && block.thinking?.trim()) {
        changed.push(this.put({ id, kind: "reasoning", text: block.thinking, ts }));
      } else if (block.type === "tool_use") {
        // SDK replay may repeat a tool_use after its result; keep the terminal item.
        if (this.tools.has(block.id)) return;
        const input = block.input ?? {};
        const tool: ToolInfo = { name: block.name, input: clip(toolInput(block.name, input)), status: "running", ...editStats(block.name, input), ...resultMetrics(line, block) };
        this.inputs.set(block.id, input);
        this.tools.set(block.id, tool);
        changed.push(this.put({ id: block.id, kind: "tool", text: "", ts, tool: { ...tool } }));
      }
    });
    return changed;
  }
}

export function parseTranscript(path: string): Item[] {
  const builder = new ClaudeItemBuilder();
  for (const raw of readFileSync(path, "utf8").split("\n")) {
    if (!raw) continue;
    try {
      builder.add(JSON.parse(raw));
    } catch {
      // A line still being written.
    }
  }
  builder.finishPending("工具未返回结果，会话已结束");
  return builder.items;
}

function readSlice(path: string, start: number, length: number): string {
  const fd = openSync(path, "r");
  try {
    const buffer = Buffer.alloc(length);
    const read = readSync(fd, buffer, 0, length, start);
    return buffer.subarray(0, read).toString("utf8");
  } finally {
    closeSync(fd);
  }
}

export type TranscriptMeta = { cwd: string | null; title: string | null; firstPrompt: string | null; /** An explicit rename (`/rename` or the web page). */ customTitle: string | null };

/**
 * Title and cwd from the head and tail of a session file only; transcripts
 * run to tens of MB and the list is rebuilt often.
 */
export function readMeta(path: string): TranscriptMeta {
  const size = statSync(path).size;
  const head = readSlice(path, 0, Math.min(size, 96 * 1024));
  const tail = size > 96 * 1024 ? readSlice(path, Math.max(0, size - 96 * 1024), 96 * 1024) : head;
  let cwd: string | null = null;
  let firstPrompt: string | null = null;
  let title: string | null = null;
  let customTitle: string | null = null;
  for (const raw of head.split("\n")) {
    if (!raw.startsWith("{")) continue;
    let line: Json;
    try {
      line = JSON.parse(raw);
    } catch {
      continue;
    }
    if (!cwd && typeof line.cwd === "string") cwd = line.cwd;
    if (!firstPrompt && line.type === "user" && !line.isMeta && !line.isSidechain) {
      const content = line.message?.content;
      const text = typeof content === "string" ? content : (content ?? []).find((part: Json) => part.type === "text")?.text;
      const cleaned = text ? cleanUserText(text) : "";
      if (cleaned && !cleaned.startsWith("<")) firstPrompt = cleaned;
    }
    if (cwd && firstPrompt) break;
  }
  for (const raw of tail.split("\n").reverse()) {
    if (!raw.includes("title") && !raw.includes("summary") && !raw.includes("agent-name")) continue;
    try {
      const line = JSON.parse(raw);
      if (line.type === "custom-title" && line.customTitle) title = customTitle = line.customTitle;
      else if (line.type === "agent-name" && line.agentName) title = line.agentName;
      else if (line.type === "summary" && line.summary) title = line.summary;
      if (title) break;
    } catch {
      // partial first line of the tail window
    }
  }
  return { cwd, title, firstPrompt, customTitle };
}
