# Changelog

## Unreleased — native clients and hosted checks

- Add non-destructive Codex project MCP configuration with capability environment forwarding. Preserve custom Kith transports and malformed-config fail-before-write behavior.
- Make generated Claude pre-hooks fail closed on launch failures on supporting client versions; rerun init to upgrade existing Kith hooks.
- Add an opt-in native Codex/Claude runner checking real editor/MCP workflows and resulting repository state, with redacted reports and bounded runs.
- Add manually dispatched CI, retained JUnit evidence and installed-package/two-client demo validation across Linux/macOS and Node 22.13/22/24.

## Unreleased

### Session ownership, supervision, and client validation

- Add random session capabilities, hashed storage, fixed process anchors, generation checks, and exact fencing-token checks. ID-only renewal, completion, lock release, and mutation are rejected across engines/connections.
- Remove simulated liveness sentinels from production. Recheck reaper decisions after acquiring the writer lock.
- Add `session start [--shell] [--new]` and `session end`; CLI/hook sharing uses KITH_AGENT_ID and KITH_SESSION_TOKEN. MCP connections retain their capabilities and support explicit resume/heartbeat.
- Make `executeWithMutex` asynchronous with renewable leases, persistent FIFO tickets, process-group guards, cancellation, execution timeouts, streaming callbacks, output bounds, and signal/child exit-status handling. Await commands before closing an engine.
- Contain signal-permission errors, bound shutdown waits, check recorded process identity before signalling, and avoid recursive package-install shim acquisition.
- Preserve live command guards across session/resource expiry; private IPC records the worker group before the protected command can start.
- Return MCP structured content and separate JSON/delta text blocks; validate actual stdio and generated-hook workflows with independent clients.
- Read worktree edit reports from actual worktree bytes and pass owning credentials to Git hooks during integration.
- Add `pnpm demo` for two real MCP clients integrating independent worktrees, plus packaged-worker smoke coverage.
- Upgrade the coordination schema to 2. Stop old clients/commands before upgrading: legacy sessions are invalidated, ownership leases cleared, and unfinished work requeued. Files/worktrees/quarantine are preserved.

### Reliability and safe defaults

- Preserve existing client settings, unrelated hooks, and MCP servers during setup. Add `init --dry-run` and `--only` integration selection. Invalid JSON stops configuration writes.
- Put Claude project MCP configuration in `.mcp.json`. Generated hooks and MCP entries now invoke the locally installed `kith` executable instead of downloading a package with npx.
- Refuse existing worktree paths/branches and refuse removal of changed, untracked, or ignored work. Keep worktrees after successful CLI/MCP completion for explicit inspection and removal.
- Use independent copies when filesystem cloning is unavailable. `hydrationMethod` now reports `copy` instead of the previous shared `symlink` fallback.
- Serialize Kith merge integrations, use unique staging trees, and reject dirty or changed integration targets.
- Preserve complete appended source blocks; refuse non-additive JSON changes and duplicate newly-added export names.
- Recheck port reservations transactionally and return errors on exhaustion.
- Preserve command argument boundaries and child exit status for CLI mutex commands.
- Block pre-tool hook processing errors and missed lock-acquisition races; preserve all event pages and shadow-tree file deletions.
- Save Bash recovery copies without restoring shared workspace bytes by default. Library users controlling all writers can explicitly request `restoreLockedFiles: true`; `.before` recovery copies preserve pre-command bytes when available.
- Add `kith heartbeat --agent <id>`; completed or expired sessions cannot be revived by heartbeat alone.

### Project foundation

- Set the Node requirement to 22.13+ on 22.x, or 24+; pin the development package manager.
- Add real 50-process contention, CLI, regression, and clean packed-package consumer checks.
- Add macOS/Linux CI, contributor and security guidance, MIT license text, architecture, integration details, reliability boundaries, and an ordered roadmap.

### Upgrade notes from the prototype

Review generated integrations before rerunning init. Existing Git hooks and legacy Kith hook entries are preserved and may need manual migration. Ensure the client process can resolve `kith` on PATH and use a stable `KITH_AGENT_ID` across CLI and hook calls. Automatic shared-file restoration, forced worktree replacement, and automatic worktree deletion are no longer defaults. Plan explicit worktree cleanup and preserve ignored files such as `.env`.
