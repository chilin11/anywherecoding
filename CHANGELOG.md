# Changelog

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
