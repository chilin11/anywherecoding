import test from "node:test";
import assert from "node:assert/strict";
import { createServer, type ServerResponse } from "node:http";
import { once } from "node:events";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hub, splitKey } from "../hub.ts";
import { Connections } from "../connections.ts";
import { parseConfigPatch, validateConfigPatch } from "../session-config.ts";
import { BotsTeamAdapter, botsTeamRef } from "./botsteam.ts";
import { BotsTeamApi, StreamLimitError, botsTeamOrigin, readBotsTeamSse } from "./botsteam-api.ts";
import { BotsTeamProjection, type Row } from "./botsteam-projection.ts";

const stamp = "2026-11-01T12:00:00Z";
function task(id: string, conversation = "c1", project = "p1", employee = "leader", parent?: string): Row {
  return { id, project_id: project, conversation_id: conversation, channel: "project", mode: "leader", assigned_employee_id: employee, parent_id: parent, title: id, description: `request ${id}`, status: "running", run_id: `run_${id}`, created_at: stamp, updated_at: stamp };
}
const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
const ref = (conversation = "c1", project = "p1") => encode({ kind: "conversation", project, conversation });
function stream(value: string, size = 23): ReadableStream<Uint8Array> {
  const buffer = Buffer.from(value); let offset = 0;
  return new ReadableStream({ pull(controller) { if (offset === buffer.length) return controller.close(); controller.enqueue(buffer.subarray(offset, offset += Math.min(size, buffer.length - offset))); } });
}

test("BotsTeam transport boundaries, bounded UTF-8 framing and generic target validation", async () => {
  assert.deepEqual(botsTeamOrigin(), { origin: "http://127.0.0.1:8099", remote: false });
  assert.equal(botsTeamOrigin("https://host.example:443/").origin, "https://host.example");
  for (const url of ["http://host.example", "https://host.example/path", "https://user:secret@host.example", "https://host.example/?token=x", "https://host.example/#x"]) assert.throws(() => botsTeamOrigin(url));
  assert.throws(() => new BotsTeamApi({ url: "https://host.example" }), /Token/);
  assert.equal(splitKey("botsteam:opaque")?.agent, "botsteam");
  assert.throws(() => botsTeamRef(encode({ kind: "bot", bot: "x", extra: true })));
  const frames: unknown[] = [];
  await readBotsTeamSse(stream("\uFEFF: ping\r\n\r\nid: 9\r\ndata: 你好\r\ndata: 第二行\r\n\r\nevent: stream_ready\ndata: {}\n\n", 1), (id, type, data) => frames.push({ id, type, data }));
  assert.deepEqual(frames, [{ id: 9, type: "message", data: "你好\n第二行" }, { id: 9, type: "stream_ready", data: "{}" }]);
  await assert.rejects(readBotsTeamSse(stream("data: " + "x".repeat(12 * 1024 * 1024), 65536), () => {}), StreamLimitError);
  const config = { model: null, thinking: null, permissionMode: null, models: [], permissionModes: [] };
  assert.throws(() => validateConfigPatch({ targetId: "bot:x" }, config), /目标/);
  assert.deepEqual(parseConfigPatch({ targetId: "team" }), { targetId: "team" });
});

test("remote Cookie and CSRF remain server-side; writes never replay after 401", async () => {
  const original = globalThis.fetch; const requests: { url: string; options: RequestInit }[] = [];
  let rejectWrite = false, badCookie = false;
  globalThis.fetch = async (input, options = {}) => {
    const url = String(input); requests.push({ url, options }); const headers = new Headers(options.headers);
    assert.equal(options.redirect, "error"); assert.equal(headers.get("Authorization"), null);
    if (url.endsWith("/api/remote-access/login")) {
      assert.deepEqual(JSON.parse(String(options.body)), { token: "private-fixture-token" });
      return new Response(JSON.stringify({ csrf: "private-csrf", remote: true }), { headers: { "Content-Type": "application/json", "Set-Cookie": `botsteam_remote_session=private-cookie; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=60${badCookie ? "; Domain=host.example" : ""}` } });
    }
    assert.equal(headers.get("Cookie"), "botsteam_remote_session=private-cookie");
    if (options.method === "POST") { assert.equal(headers.get("X-Botsteam-CSRF"), "private-csrf"); if (rejectWrite) return new Response("secret upstream text", { status: 401 }); }
    return new Response("[]", { headers: { "Content-Type": "application/json" } });
  };
  try {
    const client = new BotsTeamApi({ url: "https://host.example", token: "private-fixture-token" });
    await client.array("/api/projects"); rejectWrite = true;
    await assert.rejects(client.request("/api/tasks", { description: "once" }), (error: Error) => !error.message.includes("secret upstream"));
    assert.equal(requests.filter((r) => r.url.endsWith("/api/tasks")).length, 1);
    assert.equal(requests.filter((r) => r.url.endsWith("/api/remote-access/login")).length, 1); client.close();
    badCookie = true;
    await assert.rejects(new BotsTeamApi({ url: "https://host.example", token: "private-fixture-token" }).authenticate(), /安全的会话 Cookie/);
  } finally { globalThis.fetch = original; }
});

test("projection keeps task/run/Bot identity, full replies, child ownership and replay isolation", () => {
  const projection = new BotsTeamProjection(), owner = task("root"), child = task("child", "c1", "p1", "frontend", "root"), other = task("other", "c2");
  projection.setTasks([owner, child, other]);
  const event = (id: number, task: string, run: string, type: string, payload: string) => projection.event({ id, task_id: task, run_id: run, type, payload });
  event(1, "root", "r1", "text_delta", "partial"); event(1, "root", "r1", "text_delta", "duplicate");
  const reply = "long ".repeat(3000) + "FULL_REPLY_END";
  event(2, "root", "r1", "task_completed", JSON.stringify({ status: "completed", reply, summary: "short" }));
  event(3, "child", "r2", "text_delta", "child delivery"); event(4, "root", "r3", "text_delta", "leader continuation");
  event(5, "child", "r2", "tool_execution_start", JSON.stringify({ toolCallId: "read", toolName: "read", args: { path: "src/main.ts" } }));
  event(6, "child", "r2", "tool_execution_end", JSON.stringify({ toolCallId: "read", toolName: "read", args: {}, summary: "done" }));
  const items = projection.items({ project: "p1", conversation: "c1" }, new Map([["frontend", { name: "Frontend" }]]));
  assert.equal(items.filter((i) => i.kind === "user").length, 1);
  assert.equal(items.find((i) => i.runId === "r1")?.text, reply);
  assert.equal(items.find((i) => i.runId === "r2")?.speaker?.name, "Frontend");
  assert.equal(items.find((i) => i.tool?.name === "read")?.tool?.input, "src/main.ts");
  assert.equal(items.find((i) => i.runId === "r3")?.text, "leader continuation");
  assert.ok(!items.some((i) => i.taskId === "other"));
  assert.ok(projection.active({ project: "p1", conversation: "c1" }).every((t) => t.id !== "other"));
});

async function fixture() {
  const requests: { path: string; method: string; body: Row }[] = [];
  const projects: Row[] = [{ id: "p1", name: "Backend-only project", root_path: "/backend/project", mode: "leader", leader_employee_id: "leader", default_employee_id: "frontend" }, { id: "p2", name: "Other", root_path: "/backend/other", mode: "leader", leader_employee_id: "leader" }];
  const tasks = [task("root"), task("member", "c1", "p1", "frontend", "root"), task("other", "c2"), task("foreign", "foreign", "p2")];
  const conversations: Row[] = [{ id: "c1", project_id: "p1", title: "Main conversation", updated_at: stamp }, { id: "c2", project_id: "p1", title: "Other conversation", updated_at: stamp }, { id: "foreign", project_id: "p2", title: "Foreign conversation", updated_at: stamp }];
  const events: Row[] = []; const feeds = new Map<ServerResponse, string>(); let seq = 0, failWrite = false, failCatalog = false, permission = true, question = true;
  const add = (project: string, task: string, run: string, type: string, payload: string) => {
    const event = { id: ++seq, project_id: project, task_id: task, run_id: run, type, payload, created_at: stamp }; events.push(event);
    for (const [response, scope] of feeds) if (scope === project) response.write(`id: ${event.id}\ndata: ${JSON.stringify(event)}\n\n`);
  };
  add("p1", "root", "old_run", "text_delta", "initial partial");
  add("p1", "root", "old_run", "task_completed", JSON.stringify({ status: "completed", reply: "COMPLETE root reply", summary: "short" }));
  add("p1", "member", "run_member", "text_delta", "Frontend delivery");
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url!, "http://fixture"), path = url.pathname; let raw = ""; for await (const chunk of request) raw += chunk;
      const body = raw ? JSON.parse(raw) : {}; requests.push({ path, method: request.method!, body });
      response.setHeader("Content-Type", "application/json");
      if (path === "/api/session") { response.setHeader("Set-Cookie", "botsteam_session=fixture-cookie; Path=/; HttpOnly; SameSite=Strict"); response.end(JSON.stringify({ csrf: "fixture-csrf" })); return; }
      assert.equal(request.headers.cookie, "botsteam_session=fixture-cookie");
      if (request.method !== "GET") assert.equal(request.headers["x-botsteam-csrf"], "fixture-csrf");
      let result: unknown = {};
      const project = url.searchParams.get("project_id");
      if (path === "/api/projects" && failCatalog) { failCatalog = false; response.statusCode = 503; response.end("{}"); return; }
      if (path === "/api/permissions" && project?.startsWith("direct_")) { response.statusCode = 400; response.end(JSON.stringify({ error: "directory required" })); return; }
      if (path === "/api/projects") {
        if (request.method === "POST") { const created = { id: `p${projects.length + 1}`, name: "New", ...body }; projects.push(created); result = created; }
        else result = projects;
      } else if (path === "/api/employees") result = [{ id: "leader", name: "Leader", role: "Coordinator" }, { id: "frontend", name: "Frontend", role: "Engineer" }];
      else if (path === "/api/conversations") {
        if (request.method === "POST") { const created = { id: `created_${conversations.length}`, project_id: body.project_id, title: "Created", updated_at: stamp }; conversations.push(created); result = created; }
        else result = conversations.filter((c) => c.project_id === project).map((c) => ({ ...c, active_count: tasks.filter((t) => t.project_id === project && t.conversation_id === c.id && !["completed", "cancelled", "failed", "interrupted"].includes(t.status)).length }));
      }
      else if (path === "/api/direct") result = { id: `direct_${body.employee_id}`, root_path: "", mode: "direct", default_employee_id: body.employee_id };
      else if (path === "/api/tasks") {
        if (request.method === "GET") result = tasks.filter((task) => task.project_id === project);
        else {
          const created = { ...task(`new_${tasks.length}`, body.conversation_id, body.project_id, body.assigned_employee_id), ...body };
          tasks.push(created); add(body.project_id, created.id, created.run_id, "text_delta", "new streaming response");
          if (failWrite) { failWrite = false; request.socket.destroy(); return; } result = created;
        }
      } else if (path === "/api/events") {
        response.setHeader("Content-Type", "text/event-stream");
        for (const event of events.filter((event) => event.project_id === project && event.id > Number(url.searchParams.get("after_id")))) response.write(`id: ${event.id}\ndata: ${JSON.stringify(event)}\n\n`);
        response.write(`event: stream_ready\ndata: {"after_id":${seq}}\n\n`); feeds.set(response, project!); response.on("close", () => feeds.delete(response)); return;
      } else if (path === "/api/permissions") result = project === "p1" && permission ? [{ id: "perm", task_id: "root", run_id: "run_root", employee_id: "leader", project_id: "p1", capability: "files", reason: "Read files", resource: "/backend/project", status: "pending" }] : [];
      else if (path === "/api/questions") result = project === "p1" && question ? [{ id: "question", task_id: "root", run_id: "run_root", project_id: "p1", question: "Choose", options: [{ label: "Existing backend" }, { label: "Other" }], status: "pending" }] : [];
      else if (path === "/api/permissions/perm/resolve") permission = false;
      else if (path === "/api/questions/question/answer") question = false;
      else if (path === "/api/team/stop") { for (const t of tasks) if (t.project_id === body.project_id && t.conversation_id === body.conversation_id) t.status = "cancelled"; }
      else if (/^\/api\/tasks\/[^/]+\/cancel$/.test(path)) { const t = tasks.find((t) => path.includes(`/${t.id}/`))!; assert.equal(body.expected_run_id, t.run_id); t.status = "cancelled"; }
      else if (!path.startsWith("/api/conversations/")) { response.statusCode = 404; result = { error: "not found" }; }
      response.end(JSON.stringify(result));
    } catch (error) { response.statusCode = 500; response.end(JSON.stringify({ error: String(error) })); }
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const address = server.address(); assert.ok(address && typeof address !== "string");
  return { url: `http://127.0.0.1:${address.port}`, requests, tasks, add, loseWrite: () => { failWrite = true; }, failCatalogOnce: () => { failCatalog = true; }, close: async () => { for (const response of feeds.keys()) response.end(); server.closeAllConnections(); server.close(); await once(server, "close"); } };
}

test("adapter maps Team/Bot sessions, full history, approvals, fenced stop, persistence and lost writes", async () => {
  const source = await fixture(), root = mkdtempSync(join(tmpdir(), "aw-botsteam-")), file = join(root, "targets.json");
  const hub = new Hub(), adapter = new BotsTeamAdapter(hub, { url: source.url }, file);
  const live: unknown[] = []; const unsubscribe = hub.subscribe((event) => live.push(event));
  try {
    await adapter.start(); await adapter.configuration(null);
    assert.equal(source.requests.filter((r) => r.method !== "GET").length, 0, "detection must not mutate");
    const sessions = await adapter.listSessions(); assert.ok(sessions.some((s) => s.target?.kind === "team")); assert.equal(sessions.filter((s) => s.target?.kind === "bot").length, 2);
    assert.equal(source.requests.filter((r) => r.method !== "GET").length, 0, "listing must not resolve/create hidden projects");
    const nativeId = ref(), history = await adapter.history(nativeId, null);
    assert.equal(history.items.find((i) => i.runId === "old_run")?.text, "COMPLETE root reply");
    assert.equal(history.items.find((i) => i.taskId === "member")?.speaker?.name, "Frontend"); assert.ok(!history.items.some((i) => i.taskId === "other"));
    source.tasks.push(task("placeholder")); await adapter.history(nativeId, null);
    source.add("p1", "placeholder", "run_placeholder", "text_delta", "late run appears");
    await new Promise((yes) => setTimeout(yes, 120));
    assert.ok(live.some((event: any) => event.type === "itemRemoved" && event.itemId === "summary:placeholder"), "live placeholder must be removed when its Run arrives");
    await adapter.send(nativeId, "team message"); let sent = source.requests.filter((r) => r.path === "/api/tasks" && r.method === "POST").at(-1)!.body;
    assert.equal(sent.mode, "leader"); assert.equal(sent.assigned_employee_id, "leader"); assert.equal(sent.conversation_id, "c1");
    await adapter.configure(nativeId, { targetId: "bot:frontend" }); await adapter.send(nativeId, "individual project message");
    sent = source.requests.filter((r) => r.path === "/api/tasks" && r.method === "POST").at(-1)!.body;
    assert.equal(sent.mode, "direct"); assert.equal(sent.channel, "project"); assert.equal(sent.assigned_employee_id, "frontend");
    assert.equal(JSON.parse(readFileSync(file, "utf8"))[`${source.url}\n${nativeId}`], "bot:frontend");
    assert.ok(hub.pendingApprovals().every((a) => a.sessionId === `botsteam:${nativeId}`));
    await adapter.resolve("botsteam:permission:perm", { choice: "once" });
    assert.deepEqual(source.requests.find((r) => r.path === "/api/permissions/perm/resolve")!.body, { allow: true, scope: "once" });
    await adapter.resolve("botsteam:question:question", { choice: "submit", answers: { question: ["Existing backend"] } });
    assert.deepEqual(source.requests.find((r) => r.path === "/api/questions/question/answer")!.body, { task_id: "root", run_id: "run_root", choice_index: 0 });
    await adapter.interrupt(nativeId); assert.deepEqual(source.requests.find((r) => r.path === "/api/team/stop")!.body, { project_id: "p1", conversation_id: "c1" });
    assert.equal(source.tasks.find((t) => t.id === "other")!.status, "running");
    const direct = await adapter.create("", "directoryless", { targetId: "bot:frontend" }); assert.equal(botsTeamRef(direct).kind, "bot");
    sent = source.requests.filter((r) => r.path === "/api/tasks" && r.method === "POST").at(-1)!.body;
    assert.equal(sent.channel, "direct"); assert.equal(sent.mode, "direct"); assert.ok(!("conversation_id" in sent));
    await adapter.interrupt(direct); const cancel = source.requests.find((r) => r.path.endsWith("/cancel"))!; assert.ok(cancel.body.expected_run_id);
    await assert.rejects(adapter.create("", "bad", { targetId: "team" }), /目录/);
    await assert.rejects(adapter.configure(direct, { targetId: "team" }), /目标/);
    const before = source.requests.filter((r) => r.path === "/api/tasks" && r.method === "POST").length;
    source.loseWrite(); await assert.rejects(adapter.send(nativeId, "response lost"), /未自动重发/);
    await new Promise((yes) => setTimeout(yes, 100));
    assert.equal(source.requests.filter((r) => r.path === "/api/tasks" && r.method === "POST").length, before + 1);
    const controls = source.requests.filter((r) => r.path.includes("/stop") || r.path.endsWith("/cancel")).length;
    await adapter.stop(); await new Promise((yes) => setTimeout(yes, 100));
    assert.equal(source.requests.filter((r) => r.path.includes("/stop") || r.path.endsWith("/cancel")).length, controls, "disconnect must not interrupt tasks");
    const restored = new BotsTeamAdapter(new Hub(), { url: source.url }, file);
    try { await restored.start(); assert.equal((await restored.configuration(nativeId)).targetId, "bot:frontend"); } finally { await restored.stop(); }
  } finally { unsubscribe(); await adapter.stop(); await source.close(); rmSync(root, { recursive: true, force: true }); }
});

test("externally owned execution can disconnect while busy without weakening local-process guards", async () => {
  const source = await fixture(), root = mkdtempSync(join(tmpdir(), "aw-botsteam-connections-")), hub = new Hub();
  const manager = new Connections(join(root, "connections.json"), hub, () => new BotsTeamAdapter(hub, { url: source.url }));
  try {
    writeFileSync(join(root, "connections.json"), JSON.stringify({ enabled: ["botsteam"] }));
    const restored = new Connections(join(root, "connections.json"), hub, () => new BotsTeamAdapter(hub, { url: source.url }));
    source.failCatalogOnce(); await restored.start(); assert.equal(restored.availability()[0]!.ok, false);
    await restored.add("botsteam"); assert.equal(restored.availability()[0]!.ok, true); await restored.remove("botsteam");
    await manager.add("botsteam"); hub.status(`botsteam:${ref()}`, "running"); await manager.remove("botsteam");
    assert.equal(manager.adapters.size, 0); assert.ok(!source.requests.some((r) => r.path.includes("/stop") || r.path.endsWith("/cancel")));
  } finally { for (const adapter of manager.adapters.values()) await adapter.stop(); await source.close(); rmSync(root, { recursive: true, force: true }); }
});
