# Reliability contract and recovery

Kith coordinates cooperating coding agents through work claims, isolated worktrees, shared local resources and verification before integration. This contract describes tested behavior and recovery boundaries.

Scope intersection is exact within the documented grammar; unsupported scopes are rejected. Contract analysis is advisory. Kith does not provide an OS sandbox, distributed consensus, or proof that two changes are semantically compatible.

## Behavior covered by regression tests

- Conflicting exclusive file locks and task claims have unique owners under simultaneous process contention.
- Port reservations are rechecked atomically after asynchronous OS probes; exhaustion returns an error.
- Setup previews without writes, preserves unrelated JSON settings, and rejects malformed config before writing selected configuration.
- Worktree creation refuses an existing path or branch; removal refuses local, untracked, or ignored changes.
- Integration refuses a dirty target and concurrent Kith integrations; failed or mutating verification preserves the target and source worktree for retry. Checks cannot change the candidate commit, tracked/index contents, or leave new nonignored files behind.
- Unresolved Git conflicts fail integration without custom source/JSON rewriting. Source and target work remain available for explicit repair and retry.
- Shadow-tree deletions reach Git; invalid merge inputs surface errors.
- Bash recovery preserves current workspace bytes by default and saves before/after copies.
- Event pagination does not acknowledge unseen events.
- Commands passed after `--` retain their argument boundaries and child exit status.
- Long commands renew leases; expiry, cancellation, supervisor death, and suspension do not permit overlapping guarded command groups.
- FIFO tickets survive release, and cancelled waiters do not block the queue.
- Separate CLI/MCP clients cannot mutate a live ID without its capability; old tokens cannot clean up a replacement session.
- Generated hook commands, MCP wire initialization/calls, worktree reporting, failed verification followed by repair/retry, completion, and disconnect recovery run end to end against actual subprocesses.
- A killed MCP owner can be recovered from a stopped database/WAL backup: its task is requeued, old capability rejected and worktree preserved for a new owning session.
- Unknown or missing schema versions are refused before writable database setup. Failed legacy migrations roll back ownership/schema changes and preserve workspace and recovery files.

These are test scenarios, not universal guarantees. CI coverage and real usage need to grow together.

## Important limits

**Hooks.** Clients must actually invoke hooks, use the same repository state, and agree on agent IDs. Missing or bypassed hooks do not prevent filesystem writes. Claude hooks need matching `KITH_AGENT_ID` and `KITH_SESSION_TOKEN` when mixed with CLI commands. Malformed pre-tool execution errors exit with status 2, which the client uses to block the tool. Some payload shapes and client versions remain untested.

**Sessions and leases.** Mutations require a capability bound to the active session generation. Process anchors are fixed on resume, real process identities replace test liveness sentinels, and expired/completed sessions cannot be revived by heartbeat. Sessions default to five minutes; use heartbeat before expiry. Supervised command mutexes renew their leases and preserve FIFO tickets across handoff. Active command-group guards survive expiry and are released only after the group stops. A protected daemon that escapes its group is outside this boundary. See [sessions and mutexes](sessions-and-mutexes.md) for lifecycle, cancellation, and upgrade details.

**Bash recovery.** Snapshots skip large files, symlinks, and generated/dependency directories. One snapshot is stored per agent. Overlapping commands can replace snapshots, and a shared-workspace snapshot cannot distinguish a sibling's legitimate concurrent edits from a command's unauthorized edits. The default saves current and pre-command recovery copies without changing workspace bytes. Explicit library callers can opt into `restoreLockedFiles: true` only when they control all writers; restoration is best effort and can restore older bytes. Prefer worktrees. This is not a safe attribution or security mechanism.

**Ports.** A reservation coordinates Kith clients but releases its OS probe socket immediately. Another process can bind the port before your service does. Handle bind failures.

**Git.** Integration targets the currently checked-out branch, not a hardcoded main branch. External Git writers can race with integration. Dependency hydration and speculative verification may run project code with your privileges. Verification uses a shared dependency symlink in the staging tree; choose checks that do not mutate shared dependencies. Worktree hydration can copy `.env` files; treat those worktrees as sensitive.

**Configuration.** Preflight protects against malformed JSON, not disk failure halfway through a multi-file write. Setup does not rewrite an existing Git hook or automatically adapt a third-party hook manager. Existing legacy Kith hook entries may require manual migration.

## Recovery

1. Stop all clients, writers and supervised commands. Inspect Git status in every worktree. Preserve state before using Kith commands: normal CLI/MCP status opens the engine and may migrate or reap owners.
2. Preserve worktree contents and quarantine files before removing state. Never delete `.coord` as routine cleanup: it contains worktrees, snapshots, and quarantine backups.
3. If integration reports busy after a crash, inspect `.coord/merge-train.lock`, confirm its process is no longer running, and preserve any `_merge_train_*` worktree before manually removing the stale lock.
4. Repair conflicts or failed checks in the source branch/worktree, then retry integration on the same session with a suitable verification command. Use checks that leave tracked/index contents and HEAD unchanged. Put formatters and fixers in the source worktree first. Ignored build/test outputs and Kith's unchanged dependency hydration are allowed; new nonignored staging files are rejected.
5. To remove a worktree, commit or preserve local files first. After completing its session, start a new maintenance generation with `kith session start --agent <id> --new --owner-pid "$$" --shell`. Kith deliberately does not force removal.
6. Inspect `mutex_runs` before manually removing a stuck command guard. Confirm its worker group and protected descendants cannot still execute. A process that escaped the group may require external recovery. Never clear a live guard to bypass a busy result.

### Stopped database backups and interrupted agents

Preserve `state.db` together with any matching `state.db-wal` and `state.db-shm` files after every client/writer has stopped. Keep worktrees, snapshots and quarantine copies too. A crash can leave committed data only in the WAL; copying `state.db` alone can lose it. Restore the database and its matching sidecars as one stopped set, preserving the current set separately first. Never mix a restored database with sidecars from another snapshot or restore while old clients remain alive. These are tested recovery scenarios, not a corruption-repair tool.

After an MCP owner dies, reconnect and inspect the queued tasks and retained worktree before claiming work. `kith_claim_next_task` with the same agent ID can create a fresh session generation and retain that worktree; verify the returned task ID/scope before continuing because it claims the highest-priority eligible task. The old capability is invalid. Do not request another isolated worktree over the retained path: creation deliberately refuses to replace existing work. Repair/report edits there, then complete with a read-only project check.

Startup also refuses missing/empty databases when worktrees or recovery files remain, orphan SQLite sidecars, missing required tables or ownership columns, invalid/regressed fencing counters and SQLite-detected page damage. It preserves that state for inspection; it does not reconstruct lost ownership. Empty first initialization can be retried only when no recovery files remain. Fencing exhaustion fails without rounding or resetting the counter.

Unsupported or missing schema metadata requires inspection of a preserved copy. Do not edit the version value to force an upgrade. A supported schema-1 upgrade invalidates legacy ownership and requeues unfinished tasks; an error rolls back those database changes. A process killed after migration writes but before commit is covered by a regression that reopens the old state, retries the upgrade and reclaims the queued task without changing unfinished files or recovery copies. Stop older clients before upgrading or retrying.

The SQLite implementation requires Node's unflagged SQLite API: [Node SQLite documentation](https://nodejs.org/download/release/latest-jod/docs/api/sqlite.html). Generated Claude integration follows the [hook reference](https://code.claude.com/docs/en/hooks) and [project MCP configuration](https://code.claude.com/docs/en/mcp).

## Existing databases

No full-text SQLite extension is required. Contracts, tasks, locks and supervised commands use the canonical tables on every supported runtime. Older derived `contracts_fts` tables are left intact but are no longer read or maintained. Stop all clients before upgrading. Do not mix versions or rely on downgrading to an older search index after new contract writes. No schema reset, new tables or automatic repair are involved.

## Paths, scopes and merge boundaries

See [path and scope rules](path-and-scope-rules.md) for repository discovery, literal route filenames, supported glob grammar, symlink handling and conflict refusal. These checks assume cooperating writers: a process replacing filesystem links between a check and a write can race path checks. Hardlink aliases and a hostile filesystem writer are outside the containment boundary. Git merges non-conflicting edits; project verification still determines whether that combined change works.
