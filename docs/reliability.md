# Reliability contract and recovery

Kith is a cooperative local coordinator. It does not provide an OS sandbox, distributed consensus, or proof that two changes are semantically compatible. Source analysis and glob intersections are heuristic. Earlier prototype claims about deterministic prevention, zero disk cost, and fixed millisecond bounds were not supported by benchmarks.

## Behavior covered by regression tests

- Conflicting exclusive file locks and task claims have unique owners under simultaneous process contention.
- Port reservations are rechecked atomically after asynchronous OS probes; exhaustion returns an error.
- Setup previews without writes, preserves unrelated JSON settings, and rejects malformed config before writing selected configuration.
- Worktree creation refuses an existing path or branch; removal refuses local, untracked, or ignored changes.
- Integration refuses a dirty target and concurrent Kith integrations; verification failures preserve the target.
- Additive merges preserve complete appended blocks and reject base JSON deletions/modifications.
- Shadow-tree deletions reach Git; invalid merge inputs surface errors.
- Bash recovery preserves current workspace bytes by default and saves before/after copies.
- Event pagination does not acknowledge unseen events.
- Commands passed after `--` retain their argument boundaries and child exit status.
- Long commands renew leases; expiry, cancellation, supervisor death, and suspension do not permit overlapping guarded command groups.
- FIFO tickets survive release, and cancelled waiters do not block the queue.
- Separate CLI/MCP clients cannot mutate a live ID without its capability; old tokens cannot clean up a replacement session.
- Generated hook commands, MCP wire initialization/calls, worktree reporting, verification, completion, and disconnect recovery run end to end against actual subprocesses.

These are test scenarios, not universal guarantees. CI coverage and real usage need to grow together.

## Important limits

**Hooks.** Clients must actually invoke hooks, use the same repository state, and agree on agent IDs. Missing or bypassed hooks do not prevent filesystem writes. Claude hooks need matching `KITH_AGENT_ID` and `KITH_SESSION_TOKEN` when mixed with CLI commands. Malformed pre-tool execution errors exit with status 2, which the client uses to block the tool. Some payload shapes and client versions remain untested.

**Sessions and leases.** Mutations require a capability bound to the active session generation. Process anchors are fixed on resume, real process identities replace test liveness sentinels, and expired/completed sessions cannot be revived by heartbeat. Sessions default to five minutes; use heartbeat before expiry. Supervised command mutexes renew their leases and preserve FIFO tickets across handoff. Active command-group guards survive expiry and are released only after the group stops. A protected daemon that escapes its group is outside this boundary. See [sessions and mutexes](sessions-and-mutexes.md) for lifecycle, cancellation, and upgrade details.

**Bash recovery.** Snapshots skip large files, symlinks, and generated/dependency directories. One snapshot is stored per agent. Overlapping commands can replace snapshots, and a shared-workspace snapshot cannot distinguish a sibling's legitimate concurrent edits from a command's unauthorized edits. The default saves current and pre-command recovery copies without changing workspace bytes. Explicit library callers can opt into `restoreLockedFiles: true` only when they control all writers; restoration is best effort and can restore older bytes. Prefer worktrees. This is not a safe attribution or security mechanism.

**Ports.** A reservation coordinates Kith clients but releases its OS probe socket immediately. Another process can bind the port before your service does. Handle bind failures.

**Git.** Integration targets the currently checked-out branch, not a hardcoded main branch. External Git writers can race with integration. Dependency hydration and speculative verification may run project code with your privileges. Verification uses a shared dependency symlink in the staging tree; choose checks that do not mutate shared dependencies. Worktree hydration can copy `.env` files; treat those worktrees as sensitive.

**Configuration.** Preflight protects against malformed JSON, not disk failure halfway through a multi-file write. Setup does not rewrite an existing Git hook or automatically adapt a third-party hook manager. Existing legacy Kith hook entries may require manual migration.

## Recovery

1. Stop writers and inspect `kith status` and Git status in every worktree.
2. Preserve worktree contents and quarantine files before removing state. Never delete `.coord` as routine cleanup: it contains worktrees, snapshots, and quarantine backups.
3. If integration reports busy after a crash, inspect `.coord/merge-train.lock`, confirm its process is no longer running, and preserve any `_merge_train_*` worktree before manually removing the stale lock.
4. Repair conflicts in the source branch/worktree, then retry integration with a suitable `--verify` command.
5. To remove a worktree, commit or preserve local files first. After completing its session, start a new maintenance generation with `kith session start --agent <id> --new --owner-pid "$$" --shell`. Kith deliberately does not force removal.
6. Inspect `mutex_runs` before manually removing a stuck command guard. Confirm its worker group and protected descendants cannot still execute. A process that escaped the group may require external recovery. Never clear a live guard to bypass a busy result.

The SQLite implementation requires Node's unflagged SQLite API: [Node SQLite documentation](https://nodejs.org/download/release/latest-jod/docs/api/sqlite.html). Generated Claude integration follows the [hook reference](https://code.claude.com/docs/en/hooks) and [project MCP configuration](https://code.claude.com/docs/en/mcp).
