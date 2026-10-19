import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { PiNativeAdapter } from "./pi-native.ts";
import { Hub } from "../hub.ts";
import type { Approval, RelayEvent } from "../types.ts";

// A subprocess fixture, using the installed v1.2 protocol (not the SDK's cumulative updates).
const CLI = String.raw`
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
const dir = process.env.PI_CODING_AGENT_DIR;
const argv = process.argv.slice(2);
const log = join(dir, 'commands.jsonl');
appendFileSync(join(dir, 'pids'), process.pid + '\n');
const opt = n => argv[argv.indexOf(n) + 1];
const ephemeral = argv.includes('--no-session');
let file = ephemeral ? undefined : argv.includes('--session') ? opt('--session') : join(opt('--session-dir'), randomUUID()+'.jsonl');
let header = {type:'session',version:3,id:randomUUID(),cwd:process.cwd(),timestamp:new Date().toISOString()};
let entries = [];
if (file && existsSync(file)) { const rows=readFileSync(file,'utf8').trim().split('\n').map(JSON.parse); header=rows[0]; entries=rows.slice(1); }
else if(file) { mkdirSync(opt('--session-dir'),{recursive:true}); writeFileSync(file,JSON.stringify(header)+'\n'); }
let running = false, model = {provider:'fixture',id:'a',name:'A',reasoning:true,contextWindow:10000}, thinking='high';
let serial = 0, timestamp = 1000;
const emit = data => process.stdout.write(JSON.stringify(data)+'\r\n');
const append = message => {
 const e={type:'message',id:'entry-'+(++serial)+'-'+randomUUID(),parentId:entries.at(-1)?.id??null,timestamp:new Date().toISOString(),message};
 entries.push(e); if(file) appendFileSync(file,JSON.stringify(e)+'\n');
};
const message = m => { emit({type:'message_start',message:m}); append(m); emit({type:'message_end',message:m}); };
const settled = () => { running=false; emit({type:'agent_settled',aborted:false}); };
function command(c) {
 appendFileSync(log,JSON.stringify(c)+'\n');
 const reply = (data={}) => emit({type:'response',id:c.id,command:c.type,success:true,data});
 if(c.type==='extension_ui_response') { emit({type:'extension_ui_request',id:'notice',method:'notify',message:JSON.stringify(c)}); return; }
 switch(c.type) {
  case 'get_state': reply({sessionId:header.id,sessionFile:file,model,thinkingLevel:thinking,isStreaming:running,isCompacting:false,pendingMessageCount:0}); break;
  case 'get_entries': reply({entries,leafId:entries.at(-1)?.id??null}); break;
  case 'get_available_models': reply({models:[{provider:'fixture',id:'a',name:'A',reasoning:true,contextWindow:10000},{provider:'fixture',id:'b',name:'B',reasoning:false,contextWindow:5000}]}); break;
  case 'get_available_thinking_levels': reply({levels:model.id==='a'?['off','low','high']:['off']}); break;
  case 'set_model': model={provider:c.provider,id:c.modelId,name:c.modelId,contextWindow:5000}; reply(model); break;
  case 'set_thinking_level': thinking=c.level; reply(); break;
  case 'abort': reply(); emit({type:'agent_end',messages:[],willRetry:false}); settled(); break;
  case 'prompt': {
   if(c.message==='exit') { process.exit(7); return; }
   if(c.message==='bad-json') { process.stdout.write('broken json\n'); return; }
   if(c.message==='handled') { reply({disposition:'handled'}); return; }
   running=true; emit({type:'agent_start'}); reply({disposition:'started'});
   message({role:'user',timestamp:timestamp++,content:c.message});
   if(c.message==='hold') return;
   if(c.message==='dialogs') {
    for(const method of ['confirm','select','input','editor']) emit({type:'extension_ui_request',id:method,method,title:method,options:['Red','Blue'],placeholder:'value'});
    return;
   }
   if(c.message==='timeout-dialog') {emit({type:'extension_ui_request',id:'timed',method:'confirm',title:'timed',timeout:15}); return;}
   const ts=timestamp++;
   emit({type:'message_start',message:{role:'assistant',content:[],timestamp:ts}});
   emit({type:'message_update',assistantMessageEvent:{type:'thinking_delta',contentIndex:0,delta:'think'}});
   emit({type:'message_update',assistantMessageEvent:{type:'text_delta',contentIndex:2,delta:'hel\u2028lo'}});
   emit({type:'message_update',assistantMessageEvent:{type:'text_end',contentIndex:2,content:'hello\u2028world'}});
   const args={path:'example.ts',edits:[{oldText:'old',newText:'new'}]};
   const assistant={role:'assistant',timestamp:ts,content:[{type:'thinking',thinking:'think'},{type:'toolCall',id:'call-'+ts,name:'edit',arguments:args},{type:'text',text:'hello\u2028world'}]};
   append(assistant); emit({type:'message_end',message:assistant});
   const toolCallId='call-'+ts;
   emit({type:'tool_execution_start',toolCallId,toolName:'edit',args});
   emit({type:'tool_execution_update',toolCallId,toolName:'edit',partialResult:{content:[{type:'text',text:'partial'}]}});
   const result={content:[{type:'text',text:'done'},{type:'image',mimeType:'image/png',data:'aGVsbG8='}],details:{diff:'-1 old\n+1 new',patch:'--- a\n+++ b\n@@ -1 +1 @@\n-old\n+new'}};
   emit({type:'tool_execution_end',toolCallId,toolName:'edit',result,isError:false,durationMs:42});
   message({role:'toolResult',toolCallId,toolName:'edit',timestamp:timestamp++,isError:false,...result});
   emit({type:'agent_end',messages:[],willRetry:true});
   setTimeout(settled,40); break;
  }
  default: emit({type:'response',id:c.id,command:c.type,success:false,error:'unsupported'});
 }
}
let buffer=''; process.stdin.setEncoding('utf8');
process.stdin.on('data',chunk=>{ buffer+=chunk; let i; while((i=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,i);buffer=buffer.slice(i+1);if(line)command(JSON.parse(line));} });
process.stdin.on('end',()=>process.exit(0));
`;

function fixture() {
  const dir = mkdtempSync(join(process.env.PI_SCRATCH_DIR ?? tmpdir(), "pi-native-test-"));
  const bin = join(dir, "pi-fixture.mjs");
  writeFileSync(bin, `#!${process.execPath}\n${CLI}`, { mode: 0o755 });
  const hub = new Hub(), events: RelayEvent[] = [];
  hub.subscribe((event) => events.push(event));
  const adapter = new PiNativeAdapter(hub, bin, dir);
  const commands = (): any[] => existsSync(join(dir, "commands.jsonl")) ? readFileSync(join(dir, "commands.jsonl"), "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)) : [];
  const close = async () => {
    await adapter.stop();
    if (existsSync(join(dir, "pids"))) for (const pid of readFileSync(join(dir, "pids"), "utf8").trim().split("\n")) assert.throws(() => process.kill(Number(pid), 0), /ESRCH/);
    rmSync(dir, { recursive: true, force: true });
  };
  return { dir, bin, hub, events, adapter, commands, close };
}

async function until(check: () => boolean): Promise<void> {
  for (let i = 0; i < 150; i++) { if (check()) return; await delay(10); }
  assert.fail("event did not arrive");
}

function pending(events: RelayEvent[], method: string): Approval {
  const event = events.find((e) => e.type === "approval" && e.approval.title === method);
  assert.ok(event?.type === "approval"); return event.approval;
}

test("discovery is ephemeral, no prompts; empty native directories are normal", async () => {
  const f = fixture();
  try {
    await f.adapter.start(); assert.equal(f.adapter.availability().ok, true);
    assert.deepEqual(await f.adapter.listSessions(), []);
    const config = await f.adapter.configuration(null);
    assert.equal(config.model, '["fixture","a"]');
    assert.deepEqual(config.models[0].thinkingLevels.map((x) => x.value), ["off", "low", "high"]);
    assert.deepEqual(config.models[1].thinkingLevels, []);
    assert.deepEqual(config.permissionModes, []); assert.match(config.notice!, /没有逐次/);
    assert.ok(f.commands().every((c) => c.type.startsWith("get_")));
    assert.equal(existsSync(join(f.dir, "sessions")), false);
  } finally { await f.close(); }
});

test("native tree history follows the latest branch, paginates, and preserves image/tool data", async () => {
  const f = fixture();
  try {
    const storage = join(f.dir, "sessions", "--project--"); mkdirSync(storage, { recursive: true });
    const records: any[] = [{ type: "session", version: 3, id: "tree", cwd: f.dir }];
    for (let i = 0; i < 65; i++) records.push({ type: "message", id: `e${i}`, parentId: i ? `e${i - 1}` : null, message: { role: "user", timestamp: i, content: `u${i}` } });
    records.push({ type: "message", id: "abandoned", parentId: "e64", message: { role: "assistant", timestamp: 100, content: [{ type: "text", text: "abandoned" }] } });
    records.push({ type: "message", id: "branch", parentId: "e64", message: { role: "assistant", timestamp: 101, content: [{ type: "text", text: "active" }, { type: "toolCall", id: "edit", name: "edit", arguments: { path: "x" } }] } });
    records.push({ type: "message", id: "result", parentId: "branch", message: { role: "toolResult", toolName: "edit", toolCallId: "edit", content: [{ type: "image", mimeType: "image/png", data: "aGVsbG8=" }], details: { diff: "-1 old\n+1 new\n+2 more" } } });
    records.push({ type: "session_info", id: "name", parentId: "result", name: "Tree title" });
    writeFileSync(join(storage, "tree.jsonl"), records.map((r) => JSON.stringify(r)).join("\n") + '\n{"type":');
    assert.equal((await f.adapter.listSessions())[0].title, "Tree title");
    const page = await f.adapter.history("tree", null);
    assert.equal(page.items.length, 60); assert.ok(page.before);
    assert.ok(!page.items.some((i) => i.text === "abandoned"));
    const tool = page.items.at(-1)!;
    assert.equal(tool.id, "tool:edit"); assert.equal(tool.tool?.status, "ok");
    assert.equal(tool.tool?.additions, 2); assert.equal(tool.tool?.deletions, 1);
    assert.match(tool.images![0].src, /^data:image\/png/);
    const older = await f.adapter.history("tree", page.before);
    assert.equal(older.items.length, 7); assert.equal(older.before, null);
    assert.equal(new Set([...older.items, ...page.items].map((i) => i.id)).size, 67);
    await assert.rejects(f.adapter.history("tree", "bad-cursor"), /游标/);
    assert.equal(f.commands().length, 0);
  } finally { await f.close(); }
});

test("streaming, settled lifecycle, tool completion and stable IDs survive same-file resume", async () => {
  const f = fixture();
  let next: PiNativeAdapter | undefined;
  try {
    const id = await f.adapter.create(f.dir, "stream", { thinking: "low" });
    assert.equal(f.hub.liveStatus(`pi-native:${id}`), "running");
    await assert.rejects(f.adapter.send(id, "duplicate"), (e: any) => e.status === 409);
    await until(() => f.hub.liveStatus(`pi-native:${id}`) === "idle");
    const history = await f.adapter.history(id, null);
    assert.deepEqual(history.items.map((i) => i.kind), ["user", "reasoning", "assistant", "tool"]);
    assert.equal(history.items[2].text, "hello\u2028world");
    assert.equal(history.items[3].tool?.durationMs, 42); assert.equal(history.items[3].tool?.status, "ok");
    assert.equal(history.items[3].images?.length, 1);
    const streamed = f.events.filter((e) => e.type === "item" && e.item.kind === "assistant");
    assert.ok(streamed.some((e) => e.type === "item" && e.item.streaming));
    assert.equal(new Set(streamed.map((e) => e.type === "item" ? e.item.id : "")).size, 1);
    const commands = f.commands();
    assert.ok(commands.findIndex((c) => c.type === "set_thinking_level") < commands.findIndex((c) => c.type === "prompt"));
    const session = (await f.adapter.listSessions())[0]; assert.equal(session.nativeId, id);
    await f.adapter.stop();
    next = new PiNativeAdapter(new Hub(), f.bin, f.dir);
    assert.deepEqual((await next.history(id, null)).items.map((i) => i.id), history.items.map((i) => i.id));
    await next.configuration(id); // Real --session path, no cloning/new_session.
    assert.deepEqual((await next.history(id, null)).items.map((i) => i.id), history.items.map((i) => i.id));
    await next.send(id, "handled");
  } finally { await next?.stop(); await f.close(); }
});

test("configuration queries actual levels after model changes and rejects permissions/busy turns", async () => {
  const f = fixture();
  try {
    const id = await f.adapter.create(f.dir, "handled");
    const config = await f.adapter.configure(id, { model: '["fixture","b"]', thinking: "off" });
    assert.equal(config.model, '["fixture","b"]'); assert.equal(config.thinking, "off");
    await assert.rejects(f.adapter.configure(id, { thinking: "high" }), /不支持/);
    await assert.rejects(f.adapter.configure(id, { permissionMode: "ask" }), /不支持权限/);
    await f.adapter.send(id, "hold");
    await assert.rejects(f.adapter.configure(id, { thinking: "off" }), (e: any) => e.status === 409);
    await assert.rejects(f.adapter.send(id, "second"), (e: any) => e.status === 409);
    await f.adapter.interrupt(id); assert.equal(f.hub.liveStatus(`pi-native:${id}`), "idle");
    await f.adapter.send(id, "handled"); assert.equal(f.hub.liveStatus(`pi-native:${id}`), "idle");
  } finally { await f.close(); }
});

test("extension confirm/select/input/editor map to approvals; timeout, abort and stop clean them", async () => {
  const f = fixture();
  try {
    const id = await f.adapter.create(f.dir, "dialogs");
    await until(() => f.events.filter((e) => e.type === "approval").length === 4);
    assert.equal(f.hub.liveStatus(`pi-native:${id}`), "approval");
    await f.adapter.resolve(pending(f.events, "confirm").id, { choice: "yes" });
    await assert.rejects(f.adapter.resolve(pending(f.events, "select").id, { choice: "submit", answers: { value: ["invalid"] } }), /无效选择/);
    await f.adapter.resolve(pending(f.events, "select").id, { choice: "submit", answers: { value: ["Blue"] } });
    await f.adapter.resolve(pending(f.events, "input").id, { choice: "submit", answers: { value: ["free text"] } });
    await f.adapter.resolve(pending(f.events, "editor").id, { choice: "cancel" });
    await until(() => f.commands().filter((c) => c.type === "extension_ui_response").length === 4);
    const replies = f.commands().filter((c) => c.type === "extension_ui_response");
    assert.equal(replies[0].confirmed, true); assert.equal(replies[1].value, "Blue"); assert.equal(replies[2].value, "free text"); assert.equal(replies[3].cancelled, true);
    await f.adapter.interrupt(id);
    await f.adapter.send(id, "timeout-dialog");
    await until(() => f.events.some((e) => e.type === "approvalResolved" && e.id.endsWith(":timed")));
    await f.adapter.interrupt(id);
    await f.adapter.send(id, "dialogs");
    await until(() => f.events.filter((e) => e.type === "approval").length === 9);
    await f.adapter.stop();
    for (const event of f.events) if (event.type === "approval") assert.equal(f.hub.getApproval(event.approval.id), undefined);
  } finally { await f.close(); }
});

test("spawn errors, protocol errors, unexpected exits, request deadlines leave no owned child", async () => {
  const missing = new PiNativeAdapter(new Hub(), "/missing/pi-native-command");
  await missing.start(); assert.equal(missing.availability().ok, false); await missing.stop();
  for (const prompt of ["exit", "bad-json"]) {
    const f = fixture();
    try { await assert.rejects(f.adapter.create(f.dir, prompt)); }
    finally { await f.close(); }
  }
  const f = fixture();
  try {
    const id = await f.adapter.create(f.dir, "dialogs");
    await until(() => f.events.filter((e) => e.type === "approval").length === 4);
    const live = (f.adapter as any).live.get(id);
    await assert.rejects(live.rpc.request("extension_ui_response", {}, 20), /超时/);
    await until(() => !(f.adapter as any).live.has(id));
    assert.equal(f.hub.liveStatus(`pi-native:${id}`), "idle");
    for (const e of f.events) if (e.type === "approval") assert.equal(f.hub.getApproval(e.approval.id), undefined);
  } finally { await f.close(); }
});

test("installed Pi 1.2 RPC probe in isolated agentDir sends no model prompt", { skip: !existsSync("/opt/homebrew/bin/pi"), timeout: 30_000 }, async () => {
  const dir = mkdtempSync(join(process.env.PI_SCRATCH_DIR ?? tmpdir(), "pi-native-real-"));
  const adapter = new PiNativeAdapter(new Hub(), "/opt/homebrew/bin/pi", dir);
  try {
    await adapter.start(); assert.equal(adapter.availability().ok, true, adapter.availability().reason ?? "Pi probe failed");
    assert.deepEqual(await adapter.listSessions(), []);
    const config = await adapter.configuration(null);
    assert.equal(config.permissionMode, null); assert.deepEqual(config.permissionModes, []);
    assert.ok(Array.isArray(config.models));
    assert.equal(existsSync(join(dir, "sessions")), false);
    const storage = join(dir, "sessions", "--isolated--"); mkdirSync(storage, { recursive: true });
    const sessionId = "a91be63a-fbd2-4c66-b3ea-63f93423f36e";
    const sessionPath = join(storage, `${sessionId}.jsonl`);
    writeFileSync(sessionPath, [
      { type: "session", version: 3, id: sessionId, timestamp: new Date().toISOString(), cwd: dir },
      { type: "message", id: "user1234", parentId: null, timestamp: new Date().toISOString(), message: { role: "user", timestamp: 42, content: "offline fixture, never sent" } },
    ].map((row) => JSON.stringify(row)).join("\n") + "\n");
    const ids = (await adapter.history(sessionId, null)).items.map((item) => item.id);
    await adapter.configuration(sessionId); // Same-file resume, still no prompt.
    assert.equal((adapter as any).live.get(sessionId).path, sessionPath);
    assert.deepEqual((await adapter.history(sessionId, null)).items.map((item) => item.id), ids);
    const rpc = (adapter as any).launch(dir, ["--session-dir", storage]);
    const fresh = await rpc.request("get_state");
    assert.notEqual(fresh.sessionId, sessionId); assert.equal(typeof fresh.sessionFile, "string");
    await rpc.close();
  } finally { await adapter.stop(); rmSync(dir, { recursive: true, force: true }); }
});
