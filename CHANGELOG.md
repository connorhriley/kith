# Changelog

## Unreleased

Worktree adoption for 0.2.0. The package version stays 0.1.9 and is not published. The protocol advertised by this tree stays 1.6.0. The storage schema stays 3.

- Kith can register a linked worktree an agent is already using, instead of creating one under `.coord/worktrees`. Claude Code `--worktree`, `EnterWorktree`, and subagent `isolation: worktree` checkouts live at `.claude/worktrees/<name>` (branch `worktree-<name>` by default); a hook adopts that checkout when its `cwd` is unambiguously that worktree. `kith adopt [path]`, `kith worktree adopt [path]`, `kith begin --adopt [path]`, MCP `kith_adopt_worktree`, and `adoptWorktree` / `worktreePath` on begin and claim do the same for any `git worktree list` entry.
- Provenance is stored in an optional `worktree_registrations` table (`created` / `adopted`, source `kith`, `claude-code`, or `external`). Older binaries ignore the table. `kith gc` and `kith worktree remove` do not delete or prune a worktree Kith did not create. `kith worktree forget` drops the registration. `kith worktree remove --delete-adopted` is the explicit removal, and it still refuses a dirty tree.
- A dirty tree is adopted as it is. A detached HEAD can take `kith commit` and is refused at integration until a branch is checked out. A branch checked out in another worktree is refused for both `kith commit` and integration. An adopted branch that is unique still integrates only through the existing merge train and verification command. In main-checkout mode the adopted worktree is the workspace for claims and `kith commit`, and completion does not integrate it.
- `kith status` and `kith doctor` name adopted worktrees, including a detached HEAD and a branch checked out elsewhere. The full MCP list adds `kith_adopt_worktree` (18 tools). Compact `kith_work` accepts `action: "adopt"`.

## 0.1.9 — 2026-11-16

- Hook messages sent back to the model are capped at 2,000 characters. That includes notices, warnings, shared-checkout refusals, and revert warnings, both before and after a tool call. The text is cut on a line boundary. The ready-to-run `kith commit` line in a refusal or revert is kept whole; other text is dropped first so the total stays within 2,000 whenever that line fits. A command longer than the budget is returned intact rather than cut into a command that would not run. The shorter conflict footer from 0.1.8 stays separately bounded and counts toward that total.
- False conflicts from temporary-index commits are pruned. A stored conflict is dropped when one side is already the current commit, when both sides are the same content, or when the recorded changes merge cleanly. Cleanup runs when HEAD changes, including after `kith commit`, and is cached so a later status read does not re-check every conflict. Probe files are created outside the repository and removed immediately. A real overlap stays reported, including between Claude Code subagents that share a process. A missing process id is not treated as the same agent.
- Temporary-index commits are allowed in a shared checkout and in your own worktree while other agents are active, under the new firewall rules. In a shared checkout, `git update-ref` of `HEAD` or the branch checked out there is allowed only as a compare-and-swap of exactly one commit, and only when every changed file is one you have claimed, locked, or recorded the way `kith commit` records files. Literal commit ids are checked before the command runs. When that same command uses shell variables or a command substitution, Kith does not run them ahead of time: after the commit lands it checks the result and moves the ref back if a path belongs to another agent, the commit is a merge, or it jumps more than one commit. In your own worktree, the same commit is allowed on `HEAD` or your own branch while a peer is active elsewhere. Updates to the integration branch, another agent's branch, or a `HEAD` move in a shared checkout that does not meet those rules stay blocked, as do deleting a ref you do not own, `--stdin` batches, and ref commands Kith cannot classify. `symbolic-ref` stays blocked except for a read or for pointing your own `HEAD` at your own branch. A refusal names the reason and includes `kith commit -m "<message>" <recorded files>` when you have recorded files.
- `kith doctor` detects hooks and client entries pinned to a stale runtime. It fails when a Claude hook config, Cursor `hooks.json`, Codex config, Claude Desktop config, or another client MCP entry points at a different Kith than the CLI you just ran, and the failure tells you to run `kith install`. A hook whose retained runtime is older than the `kith` binary on `PATH` says so once per process.
- `kith install` prunes old runtimes. It deletes retained copies under `~/.local/share/kith/runtimes/` that no live hook, MCP entry, or login agent still names, and keeps a runtime any of those configs still point at. A damaged selected runtime is still refused rather than overwritten.
- After upgrading, run `kith install` so hooks and client entries use this runtime. Protocol stays 1.6.0. The storage schema stays 3. There is no database migration. Stop existing Kith connections first, and upgrade every coordinator that shares a repository together.

## 0.1.8 — 2026-11-15

- Handoffs. Coordination state used to lose everything an agent learned when its session ended: claims were released and the task requeued as if untouched. `kith_write_handoff` (and `kith handoff write`) leaves a note with what is done, what remains, what failed and what was learned, plus the files changed from Git and a pointer to the full transcript; `releaseTask` hands the task back to the queue. Kith records an `abandoned` note itself when a session dies or disconnects mid-task (claimed files, last failed integration, quarantined changes) and a completion note when none was written. `kith_begin_work` and `kith_claim_next_task` return relevant notes by task and exact scope overlap, `kith_get_status` lists open ones, `kith_read_handoffs` returns full text, and siblings see new notes in their live delta. Notes are labelled untrusted, stripped of control characters and bounded. A note is superseded only by a later completion that exists. Abandoned notes point at the branch, and its worktree when that still exists.
- `kith brief` and `kith_brief`: a read-only summary of who is active on what, claims that overlap a scope, queued work, open handoff notes and conflicts. It needs no session, reads a private snapshot (creates no state, migrates nothing), never fails its caller, and is silent with `--quiet` when there is nothing to report. `kith init --only brief` adds a Claude Code `SessionStart` hook that runs it. Queued tasks untouched for two weeks, with no open note, are counted rather than listed. Exited auto-sessions leave the brief immediately; entries show activity age.
- Workflow mode. `kith mode main` (or `kith init --mode main`) makes a repository work in the main checkout: no worktrees are created, `isolateWorktree` is ignored with a note, and completing work releases claims. Generated guidance describes the recorded mode. `worktrees` stays the default. `kith_begin_work`, `kith_claim_next_task` and status report `workflowMode`. `kith mode`, `kith status --human` and `kith doctor --human` say whether `worktrees` is the unpinned default or an explicit choice. Interactive `kith init` asks for the mode when `--mode` is omitted.
- Hooks govern only sessions that joined. A process with no Kith identity no longer has its tool calls and `git commit` rejected: `kith hook pre|post|pre-commit` allows immediately, prints nothing, and never opens the coordination database. A named agent without a valid capability is still refused; `--require-session` or `KITH_REQUIRE_SESSION=1` restores fail-closed hooks. Generated guidance is replaced only while its digest still matches what Kith wrote; hand-edited blocks are kept, and `--refresh-guidance` opts in to replacing them. `kith setup` does not refresh guidance. Doctor reports a shell with no session as not participating, and a removed worktree of an ended session as retired history.
- Integration no longer requires a clean target. Preview and integration refuse only when the target has uncommitted or untracked changes to a file the merge itself changes, name those files, and leave unrelated local work untouched.
- Git-ignored paths are no longer locked or reported as conflicts, and conflicts or claims already recorded on them are cleared on the next reap. A hook session whose saved capability was lost, but whose owning process is still the caller, re-registers instead of failing with `Auto-session capability conflict`. Registering through MCP binds that capability to the parent client's auto-session and transfers its file locks. Auto-sessions stay alive across turns and long commands while the operating-system process lives. `kith session clear [<agent-id|session-key>] [--conflicts]` releases a stuck auto-session by hand.
- `kith commit -m "<msg>" [files...]` (and `commitMessage`/`commitFiles` on finish) commits only the caller session's recorded or specified files through a temporary Git index and a compare-and-swap `git update-ref`, then syncs those paths in `.git/index`. A commit made that way is not reported as a conflict against a stale main snapshot: untouched shadow-index files follow HEAD, and a side equal to HEAD is discarded. Quarantine checks skip read-only commands and concurrent edits to files another live agent holds, unless the command targeted that file for write.
- Conflict notices in the hook footer list only conflicts on files the agent edited or locks, plus a count of the rest, and only when that notice changed. The footer stays under about 1,500 characters. Conflicts held by sessions idle for over an hour, or past their lease, are dropped when dead agents are reaped.
- `kith install [workspace]` configures global MCP with the compact tool profile by default, installs silent-solo `--auto` hooks for Claude Code and Cursor, and on macOS registers a login LaunchAgent (`dev.kith.radar`) when the menu-bar helper is present. `--no-radar` and `--no-autostart` skip that login item. `kith setup` remains a compatible alias and also opens read-only Radar on macOS. `kith uninstall` removes the LaunchAgent, global hooks, global MCP entries, retained runtimes and launcher symlinks. `--auto` hooks stay zero-write for an uninitialised or single-writer repository and open coordination only when concurrent activity overlaps. Repeat setup keeps the existing Radar workspace. Linux and Windows do not launch the menu-bar view.
- `kith mcp --compact` exposes the shorter tool profile; `--full` keeps the complete surface. `kith run`, `kith gc`, `kith task done`, `kith task clear` and `kith watch` cover everyday supervision. `kith gc` compacts idle repositories and preserves active sessions, open handoffs, dirty worktrees and unmerged branches. A parent directory of several Git repositories is handled per checkout, with a presence key per repository. The index is resynced after `update-ref`. Recent session files are kept across turns. External IDE presence scanning stays behind `kith watch --include-presence`.
- The editor adds `kith.mcp.profile` (compact by default), a read-only background-hooks line, and **Kith: Install Global Hooks & Autostart** in a trusted workspace. The VSIX does not bundle the macOS menu-bar helper; Radar login autostart still needs `kith install` from the package.
- Reduce repeated MCP discovery instructions while preserving repository, capability and retry boundaries. Owned replies add `session.leaseExpiresAt` (Unix milliseconds) for the existing lease. Guidance uses direct begin/claim, an idle-only heartbeat, automatic edit publication and a single integration verification. Default status omits successful integration logs and reports `completedIntegrationCount`; `includeHistory:true` restores them. Failed and current integration diagnostics stay visible. No background renewal and no event suppression.
- Advance the additive protocol to 1.6. New optional tools are `kith_write_handoff`, `kith_read_handoffs` and `kith_brief`. Additive result fields include handoffs, `workflowMode`, `session.leaseExpiresAt` and `completedIntegrationCount`. The full tool snapshot has 17 tools. The storage schema stays 3. Opening the database creates an optional `handoffs` table; older binaries ignore it and keep working. There is no schema-version migration. `node:sqlite` loads on first use, so pass-through hooks and `kith help` do not print Node's experimental-feature notice.

## 0.1.7 — 2026-10-24

- Retain the bundled setup runtime outside temporary npx caches, verify MCP discovery, and preserve existing client settings, custom launchers and original-byte recovery backups. Clarify actual tasks, claims, resource waits and verification results in the read-only coordination view.
- Serialize MCP text replies as lossless compact JSON, retaining structured data, literal command output, warnings, capabilities and retry/recovery fields. No summarizer, extra calls or dependencies.
- Compact contract metadata without inferring read relevance from write scopes. Preserve all breaking contracts and linked exports, retain per-consumer alert relationships and lock lease records, and expose full history with optional `includeHistory` (protocol 1.5). Ordinary preview omissions are explicit and point to the existing full-registry call.
- Validate repository, branch, ownership, cleanliness and base before reusing a task worktree. Roll back queue/claim mutations when handoff fails; never remove partial or unfinished directories.
- Bound advisory cross-repository inspection, require tracked files in a distinct Git repository, omit source initializers, resolve concrete wildcard imports, and report partial/unavailable observations without failing successful claims. Unsupported inherited configuration and re-exports defer to normal project verification.
- Reject stale workspace scans, generate task prompts for selected Git checkouts, and retain only user-selected recent workspaces. Remove personal workspace defaults and automatic home-directory crawling. No new dependency or storage migration.

## 0.1.6 — 2026-10-23

- Add optional MCP operation keys with a capability-bound durable result journal in the existing database. Lost replies replay without repeating mutations; concurrent duplicates report in-progress, and interrupted/unrecorded outcomes refuse automatic re-execution. Historical replies never revive expired/completed sessions or authorize a replacement generation.
- Add structured operational failure codes and retryability while preserving existing result fields. Distinguish claim/mutex wait contention from command deadlines, partial effects, ownership rejection and failed integration; preserve bounded command output on cancellation/timeouts.
- Advance protocol to 1.4 and storage schema to 3. Transactional journal migration retains schema-2 ownership and recovery data; interrupted upgrades and missing journal state fail safely. No new runtime dependency, service or editor configuration changes.

## 0.1.5 — 2026-10-22

- Group read-only radar observations by checkout, distinguishing current recorded Kith leases, retained sessions, unregistered checkouts and unavailable ownership. Label counts as paths to review before integration, with full checkout/owner details and preservation guidance. Reuse the same snapshot in the optional editor view without extra status subprocesses. No ownership, recovery or cleanup behavior changes.
- Label checkout counts as shared paths and recent file mtimes as the six shown within a five-minute window; improve read-only menu text contrast.

## 0.1.4 — 2026-10-22

- Include the optional existing VS Code/Cursor adapter, bundling the same Kith core and a read-only view. Preserve existing MCP configuration and native trust/approval controls.

- Stop inventing fresh edit times for deleted files or future mtimes in repeated passive scans. Keep overlap detection independent of timed recent-file visibility.
- Diagnose existing global MCP configurations as well as project entries, recognize the uninitialized first-task state, and identify moved launchers or incorrect repository pins without changing files. Clarify global setup versus project instructions and per-call repository selection.
- Query Windows process creation time through the kernel-backed .NET Process API directly, avoiding Get-Process module auto-loading while retaining bounded fail-closed identity inspection.

- Launch dev servers with `kith dev`: allocate a port, set `PORT`/`KITH_PORT`, substitute literal `{port}` arguments, renew the reservation during supervision, and stop the process group before release. Add foreground `kith_run_dev_server` with the same permission/cancellation boundary as mutex commands. Native Windows supervision remains refused.
- Add optional bounded waiting to `begin`, `lock acquire`, `kith_begin_work`, and `kith_check_and_lock_files`. Defaults remain fail-fast; timeout/cancellation leave no partial claim. Worktree creation follows successful ownership. File retry does not promise FIFO order; task dependencies provide explicit ordering.
- Advance the additive MCP protocol to 1.3 and refresh its schema snapshot. No SQLite migration is required.

## 0.1.3 — 2026-10-22

- Repair automatic client setup: merge existing settings, preserve custom transports, keep private original-byte backups and refuse malformed or redirected configuration before client writes. Register Claude Code in its user MCP configuration and use the installed Node/CLI paths. Global clients select repositories per task; project configurations retain their pinned checkout. Existing hooks, permissions and session ownership stay intact.
- Canonicalize Windows short home paths before containment checks; allow a bounded cold-start window for Windows process inspection and report probe failures while retaining fail-closed ownership. Keep the MCP renewal test running past its initial expiry with allowance for OS inspection overhead.
- Add optional per-call `repository` routing (protocol 1.2) for one global MCP connection across projects. Desktop startup at `/` or HOME connects without creating a project database; missing project context returns a tool error. Keep capabilities and command cleanup scoped to each repository, retain pinned `--repo` connections, and refuse filesystem-root coordination. Global setup from HOME writes private configuration backups without initializing a project database.
- Make the optional read-only watcher compare full paths across linked worktrees of the same Git repository, including common hotspot files. Discover retained/hidden linked worktrees, exclude byte-identical dirty copies, clear resolved alerts, retain unavailable scan health and handle NUL-delimited filenames. Remove speculative cross-repository contract and agent-attribution heuristics.
- Bound menu-bar subprocess polling, drain stdout/stderr concurrently and show unavailable scans without a clean verdict. Include a universal Intel/Apple Silicon macOS helper in the package and exercise the process runner in macOS CI. Cap overlap rows at eight and label them as observations rather than proven collisions. The view observes differing or unverified uncommitted paths; it does not enforce claims or prove compatibility.

## 0.1.2 — 2026-10-21

- Address AgentScrum’s first external Claude Code/OpenCode task trial: compact default MCP status (protocol 1.1; full contracts remain opt-in), omit unchanged contracts from edit reports, and return the current worktree-bearing agent record immediately.
- Clarify same-connection token omission and transcript limits, independent PR worktrees, retained worktrees/session completion, and integration target preservation. Record the maintainer-reported completed workflow and merged PRs without treating it as broad client certification.

- Add the official MCP Registry ownership marker and server manifest, with pinned npm launch and a required repository path.
- Clarify npm-first client onboarding and expose the public package version in the README. No new runtime dependencies or storage schema changes.
- Synchronize the MCP mutex test with command readiness and release, and assert lease renewal directly, avoiding fixed-duration races on busy CI runners. Installation examples pin this release.

## 0.1.1 — 2026-10-20

- Validate the real Cursor CLI model/editor/MCP workflow and missing-guard refusal, with redacted reusable proof.
- Identify native Windows session owners through process creation time; accept native and Git-style concrete paths while preserving link containment.
- Generate Windows MCP launchers with the current Node executable and built CLI, avoiding npm `.cmd` spawning. Refuse unsupported native shell-hook setup before writes.
- Exercise native Windows worktrees, conflict refusal, ports, verification/retry, crash recovery and conservative setup/uninstall on hosted runners against clean installed packages (registry installs on release tags). Supervised mutex commands remain refused on native Windows.
- Flush setup backup files on Windows without unsupported directory fsync; directory-entry durability across power loss is not promised there.

## 0.1.0 — 2026-10-20

- Use the npm identity `kith-coord` with CLI `kith`. Protocol version 1.0.0 and storage schema 2 are independent. Earlier source manifests used 1.0.0 without a registry release.
- Add optional Cursor native hooks and block/warn/off policy modes for native/Git hooks. Ownership and path checks remain mandatory; preserve custom hooks and update recognized generated guards in place.
- Share CLI/MCP status assembly and report observed worktree branches, dirty paths/overlap, relative commits, heartbeat/commit age, FIFO waiters and command guards. Add owned committed-tree integration previews with exact Git conflict paths and dirty-input refusal.
- Add offline status, recovery inspection and doctor without initializing, migrating, reaping or writing the original database/sidecars. Unstable/damaged state is unavailable rather than guessed clean.
- Save private per-checkout setup backups before configuration writes. Uninstall restores only unchanged tracked writes, retaining edited configuration, state, worktrees, recovery copies and ignore protection.
- Export the 13 canonical MCP input schemas from actual stdio discovery and check snapshot drift in CI; document protocol ownership and integration semantics. No database tables or runtime dependencies added.

## Pre-release development history

### Coordination positioning

- Describe Kith consistently as local coordination for work claims, isolated worktrees, shared resources and verified integration across README, CLI, MCP instructions and package metadata.
- Remove maturity labels from the current product description while retaining the documented support matrix, enforcement boundaries and recovery contract.

### Subtraction pass (supersedes earlier unreleased advisory/UI behavior)

- Remove `top`/`ui` and their dashboard modules. Use existing CLI/MCP status; normal engine startup may migrate or reap state, so preserve stopped recovery data first.
- Remove fuzzy intent blocking, synonym/duplicate scoring, full-text search maintenance and their public APIs/result fields (`semanticOverlaps`, `duplicates`, `autoMergeableFiles`). Scope ownership remains authoritative; similar task titles no longer block disjoint scopes. The semantic-overlap `force` option is removed.
- Retain a small non-blocking reuse hint for exact, case-sensitive symbol names of the same kind in other files, queried from canonical contracts and returned through existing edit warnings. No scoring, synonym rules, new API, search index or schema change.
- Refuse unresolved Git conflicts instead of rewriting source/JSON. Remove `checkAdditiveMergeability` and `autoResolvedFiles`; retain worktrees/checkpoints for explicit repair and verification retries. TypeScript is a development dependency only.
- Share CLI/MCP begin/complete orchestration. Default init configures MCP clients/instructions; hooks and shims require explicit selection. Existing guards and state are preserved. No schema changes; legacy derived search tables are left unused. Stop older clients before upgrading; mixed versions/downgrades are not supported by this change.


### Interrupted upgrades and damaged-state refusal

- Refuse missing/empty databases with retained recovery data, orphan sidecars, incomplete ownership schema, invalid/regressed counters and SQLite-detected page damage. Keep state intact for inspection rather than recreating empty ownership tables.
- Fail safely at fencing exhaustion and validate state before init writes client configuration.
- Test a real upgrade process killed before commit, followed by rollback/retry and recovery of unfinished work. Retain interrupted first-start retries when no coordination/recovery data exists.

### Recovery and verification integrity

- Freeze the integration candidate before verification and reject checks that change HEAD, tracked/index contents or leave new nonignored files in staging. Preserve source work and claims so callers can repair and retry.
- Validate existing schema metadata read-only before writable setup; refuse unsupported/malformed/missing versions instead of changing the database first. Recheck within the migration transaction.
- Cover killed MCP ownership, stopped WAL backup restoration, new session generations, failed legacy migration rollback, and repair/retry through real clients. Native validation now checks an expected failed verification followed by successful completion.

### Lean MCP onboarding and read-only observation

- Recommend MCP ownership and one worktree per parallel agent in setup instructions and examples. Add `init --mcp-only` to configure clients without installing hooks or shims; preserve existing guards with a review warning.
- Make `top` read existing state without initialization, migrations, reaping or event acknowledgement. Show retained worktree paths, FIFO tickets without a current lease, command guards and the newest events.
- Replace the incorrect recovery claim that files were reverted with recorded copy locations. No schema changes or Git-status polling.
### Native clients and hosted checks

- Share coordination automatically across Git subdirectories, symlink aliases, linked checkouts and separate Git directories. Preserve selected-checkout Git operations, register linked session roots, inspect the invoking pre-commit index and refuse orphaned legacy checkout-local state.
- Resolve physical paths before containment checks, reject external/dangling/looping symlinks and redirected coordination/configuration writes, skip source symlinks/nested repositories, and support literal framework route filenames.
- Replace sample-based glob overlap with exact intersection of a documented grammar (`*`, `?`, whole-segment `**`, including dotfiles). Reject unsupported requests; retain exclusion for legacy scopes, wildcard aliases and changed symlink layouts.
- Resolve source conflicts with a lazily loaded TypeScript parser and a narrow appended-declaration policy. Keep imports, initialization, top-level execution, binding collisions, invalid syntax and ambiguous Git stages/modes as conflicts. Preserve executable modes and NUL-delimited Git filenames; reject duplicate/lossy JSON values.

- Fix startup on stock Node 22.13.0, which lacks SQLite FTS5. Detect optional full-text support, retain normal contract/name/type hints without it, and rebuild the derived index safely when switching runtimes. Expose runtime capabilities in CLI/MCP status.

- Add `kith_run_with_mutex` for sandboxed MCP clients unable to inspect process identities in their native shell. Preserve ownership, renewable supervision and actual exit codes; cancel commands on request cancellation or connection loss before closing coordination state. Translate stdio EOF into graceful cancellation; the MCP SDK alone does not emit a close callback for stdin EOF. Commands run with server permissions and need client approval.

- Add non-destructive Codex project MCP configuration with capability environment forwarding. Preserve custom Kith transports and malformed-config fail-before-write behavior.
- Make generated Claude pre-hooks fail closed on launch failures on supporting client versions; rerun init to upgrade existing Kith hooks.
- Add an opt-in native Codex/Claude runner checking real editor/MCP workflows and resulting repository state, with redacted reports and bounded runs.
- Add manually dispatched CI, retained JUnit evidence and installed-package/two-client demo validation across Linux/macOS and Node 22.13/22/24.

### Notes later released in 0.1.7

- One-command setup retains a self-contained runtime outside transient npx caches, checks MCP discovery and installs marked project guidance alongside detected client configuration. Repeat/interrupted setup retains recovery material and existing custom launchers; older live project schemas require the stopped-upgrade procedure.
- Read-only menu and editor views show current recorded tasks/claims, resource waits and failed integrations with next steps. Saved work and review paths move into details; the default menu omits file timestamps. Missing/partial state stays explicit. No new coordination database, model calls or automatic cleanup.


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
