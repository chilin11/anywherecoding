import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { Hub } from "../hub.ts";
import { BotsTeamAdapter, botsTeamRef } from "./botsteam.ts";
import type { Row } from "./botsteam-projection.ts";

const stamp = "2026-11-03T12:00:00Z", sharedRoot = "/workspace/shared root";
// Observed via read-only upstream /api/projects: SSH root_path is empty, workspace
// is an object with these fields, and conversations use the same project_id API.
// All identities and paths in this fixture are synthetic, not production records.
const sshWorkspace = (authority: string) => ({ kind: "ssh", authority_id: authority, canonical_root: sharedRoot, root_identity: `root_${authority}`, os: "linux", arch: "amd64", path_flavor: "posix" });

async function fixture() {
  const projects: Row[] = [
    { id: "ssh_a", name: "SSH A", root_path: "", mode: "leader", leader_employee_id: "remote_leader", workspace: sshWorkspace("authority_a") },
    { id: "ssh_b", name: "SSH B", root_path: "", mode: "direct", default_employee_id: "remote_bot", workspace: sshWorkspace("authority_b") },
    { id: "local", name: "Local", root_path: sharedRoot, mode: "leader", leader_employee_id: "local_leader" },
    { id: "directoryless", root_path: "", mode: "direct", default_employee_id: "remote_bot" },
    { id: "unknown", root_path: "", workspace: { ...sshWorkspace("unknown"), kind: "future" } },
    { id: "serialized", root_path: "", workspace: JSON.stringify(sshWorkspace("serialized")) },
    { id: "incomplete", root_path: "", workspace: { kind: "ssh", canonical_root: sharedRoot } },
    { id: "no_root", root_path: "", workspace: { kind: "ssh", authority_id: "authority_a" } },
    { id: "bad_root", root_path: "", workspace: { ...sshWorkspace("authority_a"), canonical_root: 123 } },
    { id: "array", root_path: "", workspace: [sshWorkspace("authority_a")] },
    { id: "", root_path: "", workspace: sshWorkspace("authority_a") },
  ];
  const employees = [{ id: "remote_leader", name: "Remote Leader" }, { id: "remote_bot", name: "Remote Bot" }, { id: "local_leader", name: "Local Leader" }];
  const conversations: Row[] = ["ssh_a", "ssh_b", "local"].map((project) => ({ id: `conversation_${project}`, project_id: project, title: `${project} conversation`, title_source: "manual", archived: false, turn_count: 1, active_count: project === "ssh_a" ? 1 : 0, created_at: stamp, updated_at: stamp }));
  conversations.push({ ...conversations[0], id: "archived", archived: true });
  const tasks: Row[] = [], requests: { method: string; path: string; project: string | null; body: Row }[] = [];
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url!, "http://fixture"), path = url.pathname, project = url.searchParams.get("project_id");
      let raw = ""; for await (const chunk of request) raw += chunk;
      const body = raw ? JSON.parse(raw) : {};
      requests.push({ method: request.method!, path, project, body });
      response.setHeader("Content-Type", "application/json");
      if (path === "/api/session") {
        response.setHeader("Set-Cookie", "botsteam_session=ssh-fixture; Path=/; HttpOnly; SameSite=Strict");
        response.end(JSON.stringify({ csrf: "ssh-fixture-csrf" })); return;
      }
      assert.equal(request.headers.cookie, "botsteam_session=ssh-fixture");
      if (request.method !== "GET") assert.equal(request.headers["x-botsteam-csrf"], "ssh-fixture-csrf");
      let result: unknown = {};
      if (path === "/api/projects") {
        if (request.method === "POST") { const created = { id: "new_local", name: "New local", ...body }; projects.push(created); result = created; }
        else result = projects;
      } else if (path === "/api/employees") result = employees;
      else if (path === "/api/conversations") {
        if (request.method === "POST") {
          const created = { id: `created_${conversations.length}`, title: "New", updated_at: stamp, ...body };
          conversations.push(created); result = created;
        } else result = conversations.filter((row) => row.project_id === project);
      } else if (path === "/api/tasks") {
        if (request.method === "POST") {
          const created = { id: `task_${tasks.length}`, run_id: `run_${tasks.length}`, status: "running", created_at: stamp, updated_at: stamp, ...body };
          tasks.push(created); result = created;
        } else result = tasks.filter((row) => row.project_id === project);
      } else if (path === "/api/permissions" || path === "/api/questions") result = [];
      else if (path === "/api/events") {
        response.setHeader("Content-Type", "text/event-stream");
        response.end('event: stream_ready\ndata: {"after_id":0}\n\n'); return;
      } else if (path === "/api/team/stop") {
        for (const task of tasks) if (task.project_id === body.project_id && task.conversation_id === body.conversation_id) task.status = "cancelled";
      } else if (path.startsWith("/api/conversations/")) result = body;
      else { response.statusCode = 404; result = { error: "Unexpected fixture endpoint" }; }
      response.end(JSON.stringify(result));
    } catch (error) { response.statusCode = 500; response.end(JSON.stringify({ error: String(error) })); }
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const address = server.address(); assert.ok(address && typeof address !== "string");
  return { requests, url: `http://127.0.0.1:${address.port}`, close: async () => { server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); } };
}

test("discovers observed SSH workspaces without treating directoryless or unknown projects as SSH", async () => {
  const source = await fixture(), adapter = new BotsTeamAdapter(new Hub(), { url: source.url });
  try {
    await adapter.start();
    const sessions = await adapter.listSessions(), projectSessions = sessions.filter((session) => botsTeamRef(session.nativeId).kind === "conversation");
    assert.equal(projectSessions.length, 3, "both SSH authorities and the existing local project must be listed");
    assert.equal(new Set(projectSessions.map((session) => session.nativeId)).size, 3, "equal directory paths must not collapse distinct project IDs");
    for (const session of projectSessions) {
      const ref = botsTeamRef(session.nativeId); assert.equal(ref.kind, "conversation");
      if (ref.kind !== "conversation") continue;
      assert.equal(ref.conversation, `conversation_${ref.project}`);
      assert.equal(session.cwd, sharedRoot);
      if (ref.project !== "local") {
        assert.equal(session.projectKey, `botsteam:ssh:${ref.project}`);
        assert.equal(session.createInProject, false);
        assert.match(session.projectLabel!, /^SSH · /);
      } else {
        assert.equal(session.createInProject, undefined);
      }
      assert.equal(session.title, `${ref.project} conversation`);
      assert.equal(session.updatedAt, Date.parse(stamp));
      assert.equal(session.status, ref.project === "ssh_a" ? "running" : "idle");
      assert.equal(session.target?.id, ref.project === "ssh_b" ? "bot:remote_bot" : "team");
      assert.deepEqual(session.actions, { rename: true, remove: true });
    }
    assert.equal(sessions.filter((session) => botsTeamRef(session.nativeId).kind === "bot").length, 3);
    assert.deepEqual(source.requests.filter((request) => request.path === "/api/conversations").map((request) => request.project).sort(), ["local", "ssh_a", "ssh_b"]);
    const config = await adapter.configuration(null);
    assert.deepEqual(config.directory, { source: "backend", projects: [{ path: sharedRoot, label: "Local" }] }, "SSH roots must not become ambiguous path-only creation options");
    assert.deepEqual(adapter.capabilities, { externalExecution: true, directorySource: "backend" });
    assert.ok(source.requests.every((request) => request.method === "GET"), "discovery must not resolve /api/direct, create scopes or send prompts");
  } finally { await adapter.stop(); await source.close(); }
});

test("SSH history and controls retain project/conversation identity and Team/Bot payloads", async () => {
  const source = await fixture(), adapter = new BotsTeamAdapter(new Hub(), { url: source.url });
  try {
    await adapter.start();
    const session = (await adapter.listSessions()).find((session) => session.title === "ssh_a conversation")!;
    assert.ok(session);
    assert.deepEqual((await adapter.history(session.nativeId, null)).items, []);
    assert.ok(source.requests.some((request) => request.path === "/api/events" && request.project === "ssh_a"));
    assert.ok(source.requests.some((request) => request.path === "/api/tasks" && request.project === "ssh_a"));
    await adapter.send(session.nativeId, "Team request");
    let sent = source.requests.filter((request) => request.method === "POST" && request.path === "/api/tasks").at(-1)!.body;
    assert.deepEqual(sent, { project_id: "ssh_a", conversation_id: "conversation_ssh_a", channel: "project", mode: "leader", assigned_employee_id: "remote_leader", title: "Team request", description: "Team request" });
    await adapter.configure(session.nativeId, { targetId: "bot:remote_bot" });
    await adapter.send(session.nativeId, "Bot request");
    sent = source.requests.filter((request) => request.method === "POST" && request.path === "/api/tasks").at(-1)!.body;
    assert.deepEqual(sent, { project_id: "ssh_a", conversation_id: "conversation_ssh_a", channel: "project", mode: "direct", assigned_employee_id: "remote_bot", title: "Bot request", description: "Bot request" });
    await adapter.interrupt(session.nativeId);
    assert.deepEqual(source.requests.find((request) => request.path === "/api/team/stop")!.body, { project_id: "ssh_a", conversation_id: "conversation_ssh_a" });
    await adapter.rename(session.nativeId, "Renamed SSH conversation"); await adapter.remove(session.nativeId);
    assert.deepEqual(source.requests.filter((request) => request.path === "/api/conversations/conversation_ssh_a").map((request) => request.body), [{ project_id: "ssh_a", title: "Renamed SSH conversation" }, { project_id: "ssh_a", archived: true }]);
    assert.ok(!source.requests.some((request) => request.path === "/api/direct" || request.path === "/api/projects" && request.method !== "GET"));
    const writes = source.requests.filter((request) => request.method !== "GET").length;
    await adapter.stop();
    assert.equal(source.requests.filter((request) => request.method !== "GET").length, writes, "disconnect must not stop remote tasks");
  } finally { await adapter.stop(); await source.close(); }
});

test("SSH discovery leaves path-based local creation and its Leader selection unchanged", async () => {
  const source = await fixture(), adapter = new BotsTeamAdapter(new Hub(), { url: source.url });
  try {
    await adapter.start();
    const existing = botsTeamRef(await adapter.create(sharedRoot, "Local request"));
    assert.equal(existing.kind, "conversation");
    if (existing.kind === "conversation") assert.equal(existing.project, "local", "the SSH root with the same path must not be used for local creation");
    assert.ok(!source.requests.some((request) => request.path === "/api/projects" && request.method === "POST"));
    const created = botsTeamRef(await adapter.create("/new/backend/local", "New local request"));
    assert.equal(created.kind, "conversation");
    if (created.kind === "conversation") assert.equal(created.project, "new_local");
    assert.deepEqual(source.requests.find((request) => request.path === "/api/projects" && request.method === "POST")!.body, { root_path: "/new/backend/local", mode: "leader", leader_employee_id: "local_leader", default_employee_id: "local_leader" });
    assert.ok(source.requests.filter((request) => request.path === "/api/tasks" && request.method === "POST").every((request) => request.body.assigned_employee_id === "local_leader"));
  } finally { await adapter.stop(); await source.close(); }
});
