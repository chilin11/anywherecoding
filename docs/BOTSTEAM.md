# BotsTeam connection and generic conversation targets

AnywhereCoding can control an existing BotsTeam workbench alongside Codex, Claude Code, PI-Desktop and Pi CLI. It uses the workbench's HTTP APIs and SSE, **not its SQLite files or a second Pi engine**. Models, providers, prompts and execution remain owned by BotsTeam.

## Connect

1. Start BotsTeam on the same computer, normally on port 8099.
2. Start this version of AnywhereCoding, open **连接的 IDE → 添加**, detect and add **BotsTeam**. Detection and session listing only read catalogs; they do not send model prompts or create Bot projects.
3. Choose an existing project conversation, a Bot's directoryless conversation, or create a conversation with a **Team / Bot** target.

The default endpoint is `http://127.0.0.1:8099`. The adapter does not launch BotsTeam. Same-machine loopback uses `/api/session` and keeps Cookie/CSRF only in memory; remote access does not need to be enabled for this local hop.

To override the endpoint, merge this server-side field into `~/.anywherecoding/config.json`, preserving its existing login `token`, `cookieSecret` and other settings:

```json
{
  "botsteam": {
    "url": "https://bots.example.com",
    "token": "YOUR_BOTSTEAM_REMOTE_TOKEN"
  }
}
```

A non-loopback origin requires **HTTPS and the BotsTeam remote Token**. Enable remote access in BotsTeam locally first. Origins cannot include credentials, paths, queries or fragments. Redirects are rejected and platform TLS/hostname verification is unchanged. HTTP is limited to origins whose normalized host is `localhost`, `127.0.0.1` or `[::1]`. The relay never forwards browser authentication/proxy headers to the backend; its own login and the BotsTeam session remain separate. The upstream Token stays in private server configuration and is not returned in connection metadata, URLs or browser storage. Configuration changes require a relay restart; do that only after its locally owned CLI tasks finish.

## Team and Bot semantics

- **Team** uses the selected project's configured Leader, `channel=project`, `mode=leader`, and the exact conversation ID. It requires an existing computer-side directory.
- **Bot with a project** uses `channel=project`, `mode=direct` and the chosen employee ID in that project conversation. It does not rewrite the project's default mode, Leader or Bot settings.
- **Bot without a project** uses that Bot's existing directoryless history, `channel=direct`, `mode=direct`. BotsTeam has one directoryless scope per Bot, not a new independent history for every click. Opening or sending in this scope explicitly resolves it through the existing idempotent `/api/direct` API; if no scope exists, BotsTeam may create its metadata at that point. The target is fixed to that Bot.
- Project conversation targets can be changed while idle. Selection is stored separately from model configuration in private `botsteam-targets.json`, keyed by **backend origin + opaque native session ID**. A removed Bot cannot silently fall back to another Bot.
- Backend paths belong to the computer running BotsTeam. The form offers its existing projects and an absolute-path field, not AnywhereCoding's local directory browser. Unknown folders are verified by BotsTeam's existing project API. Remote backend paths are never passed through the relay's local image/file resolver.

## History, controls and safety

History and live output use the same projection of persistent event IDs, task IDs and Run IDs. Bot identity is attached to assistant, tool and thinking items. Duplicate replay is ignored; terminal full `reply` replaces partial deltas, rather than showing only the bounded summary. Legacy records without original reply text are explicitly labelled as summaries. A named `stream_ready` checkpoint fences replay before publishing history. The relay paginates the derived timeline and removes obsolete live placeholders by stable item ID.

The relay watches opened scopes, renews them while visible, and polls task/interactive state as well as reading SSE. Streams reconnect from their in-memory cursor; a new relay replays history. Limits: 32 MiB JSON responses, 12 MiB SSE frame/line, 32 MiB aggregate projected text/tool payloads per project, 20 cached projects and 200 observed session scopes. A limit failure pauses that stream with a warning; it does not skip content or retry the same oversized event forever. This is not durable background execution in the browser.

- **Stop project conversation** always includes `project_id` and `conversation_id`.
- **Stop directoryless Bot** cancels only tasks belonging to that Bot's direct scope, with observed Run fencing.
- Permissions map to allow once / allow project / deny. Directoryless scopes do not query the unsupported project-permissions endpoint.
- Questions preserve observed `task_id` and `run_id`, and send exactly one choice index, custom text, or cancellation. Stale cards are removed. Answering a question does not grant tool permissions.
- **Writes are never automatically replayed**, including a lost response after server acceptance. Drafts/answers remain available in the UI; check backend state before explicitly retrying. Read requests may reauthenticate once. A failed initial connection can be retried after the backend comes online.
- Disconnecting/removing the connection or stopping the relay **only closes its network connections**. It does not cancel BotsTeam tasks. Existing local CLI adapters retain their running-task removal guard.
- Project conversation remove means **archive**, not deletion. Directoryless Bot histories do not expose unsupported rename/archive actions.

## Generic extension points

This is a backend capability, not a BotsTeam-specific model picker:

- `SessionConfig.targets?: SessionTarget[]` declares `{id, kind: "team"|"bot", label, description?, directory: "required"|"optional"}`.
- `SessionConfig.targetId` and `SessionConfigPatch.targetId` select the target, independently of model/thinking/permission fields.
- `SessionConfig.directory.source` and project choices declare the path namespace used by the creation UI.
- `Adapter.capabilities.directorySource="backend"` prevents local root validation and local file/image rewriting for backend paths.
- `Adapter.capabilities.externalExecution=true` declares that disconnecting does not own or stop execution; PI-Desktop uses the same capability.
- Optional `SessionSummary.target/actions` and `Item.speaker/taskId/runId` preserve target identity and supported operations without replacing the common transcript UI.

Adapters that omit the optional fields keep the previous behavior. Target validation rejects unsupported target IDs; Team/Bot selectors and directory behavior do not branch on the backend name.

## Scope and verification

Included: project/Bot history, Team/Bot conversation creation and selection, streaming/full replies, stop, permissions/questions, project conversation rename/archive and connection retry/disconnect.

Not included: the BotsTeam desktop Pipeline, file/Diff workspace, directoryless-history attachment UI, provider/Bot management, `/compact`, or a way to make the BotsTeam Android APK talk to AnywhereCoding. Use the original BotsTeam clients for these features.

Run from the repository root:

```sh
node --test server/adapters/botsteam.test.ts server/adapters/connections.test.ts
pnpm test
pnpm typecheck
pnpm build
```

The tests use temporary configuration and isolated HTTP/SSE fixtures. They cover origin/Cookie/CSRF and size boundaries, target validation, history identity/full replies, Team/Bot dispatch, supported directoryless endpoints, start failure recovery, tool-argument retention, approval identity, fenced stop, preference isolation, placeholder replacement, disconnect semantics and lost-write handling. They do not invoke paid models or modify production data. Browser acceptance uses the real relay routes with the same isolated backend at mobile/desktop widths; it does not establish real Cloudflare/TLS-chain or production-session compatibility.
