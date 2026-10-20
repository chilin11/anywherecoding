# Changelog

## Unreleased

- macOS app: `AnywhereCoding-macOS.dmg` (`pnpm dmg`) contains `AnywhereCoding.app`, a universal menu bar app with a bundled Node runtime that runs the server itself — no terminal, Homebrew or Node install. First run picks a free port (8787–8799), shows the local/LAN address, copies the token, and adds a login item. Menu adds LAN address, login toggle, logs, restart and quit-stops-server; crashes auto-restart. An already running AnywhereCoding server (e.g. the source LaunchAgent) is detected and only monitored. Release tags attach the DMG.
- Server responses carry `X-AnywhereCoding: <version>`.
- LaunchAgent now uses a stable node path (e.g. `/opt/homebrew/bin/node`) so `brew upgrade node` no longer breaks the service; reinstalling waits for launchd instead of failing with `Bootstrap failed: 5`.
- Menu bar default port matches the server (8787) when config omits it.

- Rename and delete sessions from a `⋯` menu in the session list and chat header: Codex archives, PI-Desktop deletes, Claude Code and Pi CLI files move to `~/.anywherecoding/trash`. Running sessions are refused.
- Pin sessions (per browser), copy replies and code blocks, `⌘K` search, remembered project folding.
- Browser notifications when a background task finishes; clicking a notification opens its session.
- Warn when PI-Desktop does not expose `agent/pendingInteractive`, so missing web approvals are no longer silent.

- Add a native macOS menu bar companion (`scripts/menubar.mjs install`) showing running/approval counts and active sessions.
- Add authenticated `GET /api/status` activity snapshot.
- Make the desktop sidebar resizable and collapsible, with a persisted width and keyboard support.
- Keep live updates working after background tabs resume; compact mobile chat and composer layout; wrap filter chips.

## v0.1.0

Initial release of AnywhereCoding, a mobile-friendly web interface for local AI coding sessions.

- Add and detect local Codex, Claude Code, PI-Desktop and native Pi CLI connections; start with an empty connection list.
- Browse native conversations by project and continue the same session through native client protocols.
- Create sessions directly within projects, browse directories and create project folders.
- Stream replies and reasoning, interrupt runs, answer tool approvals and supported interactive questions.
- Select native models, thinking levels and supported permission modes.
- Display tool completion, command exit codes, file additions/deletions and image results.
- Preserve native error details, show retry and process-exit messages, and retain drafts after failed sends.
- Provide token authentication, signed cookies, Origin checks and authenticated local image serving.
- Include macOS LaunchAgent management and Linux/macOS CI checks.

Known limits: native GUI tabs may need reopening to refresh; avoid concurrent writers. PI-Desktop requires its MCP control interface. Native Pi terminal-only extension UI is not rendered. Attachment upload is not included. macOS background directory access may require system permission.
