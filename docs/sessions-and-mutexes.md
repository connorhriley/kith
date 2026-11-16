# Sessions, ownership, and supervised commands

## Start through MCP

For agents, prefer `kith_begin_work` with a unique ID, explicit scopes and `isolateWorktree: true`. One persistent MCP connection retains its capabilities internally. Edit only the returned worktree, report edits with `kith_record_file_edit`, run serialized commands with `kith_run_with_mutex`, and complete with a project verification command. No environment exports are required for MCP-only setup. Keep the connection alive and heartbeat before expiry. See [client setup](integrations.md) and [examples](usage.md).

## Share a session with CLI and hooks

A session has a unique agent ID, a random 256-bit capability, a generation (epoch), a kernel process identity, and an expiry. An ID alone grants no ownership. The database stores a hash of the capability; public agent records and event/status responses omit it.

For a terminal workflow, initialize the environment before launching an agent client:

```sh
eval "$(kith session start --agent auth-worker --owner-pid "$$" --shell)"
kith begin --title "Refresh authentication" --scope "src/auth/**" --worktree
# Edit in the returned worktreePath.
# Launch the hook-enabled client from this environment.
kith heartbeat
kith complete
unset KITH_AGENT_ID KITH_SESSION_TOKEN
```

`--shell` emits quoted exports for `KITH_AGENT_ID` and `KITH_SESSION_TOKEN`. Treat the token like a password: do not paste it into issues, commits, or logs. Passing `--session-token` explicitly is supported, but an environment variable avoids placing it in the command line.

CLI sessions are anchored to their parent process unless `--owner-pid` is supplied. Shell export mode requires `--owner-pid "$$"`: sh/bash command substitution can create a transient parent, so the outer shell PID must be passed explicitly. Library and MCP sessions default to their own process. Resuming a session does not rebind that anchor. Keep the owner process alive; use heartbeats before the default five-minute expiry. Completed, expired, and replaced capabilities cannot renew or mutate the new owner’s state.

`kith session end` abandons a session and requeues unfinished tasks. `kith complete` explicitly completes work. To reuse a completed/expired ID intentionally, create a new generation:

```sh
eval "$(kith session start --agent auth-worker --new --owner-pid "$$" --shell)"
```

`--new` does not steal a live session. Worktree paths are retained across generations. After successful worktree integration, use a new maintenance session to run `kith worktree remove`; changed, untracked, and ignored files still prevent removal.

## Git-ignored files and clearing a stuck auto-session

Kith does not lock, parse for AST contracts, snapshot/quarantine in Bash guards, or record merge conflicts on a path that `git check-ignore` reports as ignored in the repository the path belongs to (a nested checkout uses its own rules). Dev-server logs, build traces and caches are therefore invisible to coordination. Conflicts, file claims and contract rows that older versions recorded on ignored paths are deleted automatically when any Kith engine opens the repository or reaps dead agents. Tracked files are never treated as ignored.

An auto-joined hook session (`auto-<client>-<hash>`) normally recovers by itself: if the caller is in the same process tree as the registered owner (or the prior owner died or expired) and its saved capability no longer resumes, the hook reclaims the registration automatically. If a separate live process holds that session key (`Auto-session capability conflict for <client>:<session-id>`), passive hooks warn with a recovery command without blocking unrelated shell commands or unlocked files (edits to files locked by another active session remain blocked). Clear it by hand from the repository:

```sh
kith session clear claude:<session-id>      # or the agent id, e.g. auto-claude-1a2b3c4d
kith session clear --conflicts              # only delete recorded conflicts, keep sessions
```

`kith session clear <target>` forgets the session's saved capability and presence, releases its claims, marks the agent dead and deletes conflicts recorded against it. The session registers again on its next tool call. It needs no session token, so run it only for sessions you own.

When a client with `--auto` hooks also registers an MCP session (`kith_begin_work` or `kith_work`), Kith automatically binds the MCP capability to the parent client's `presence.db` session and transfers any locks held by its `auto-*` agent ID so subsequent hook calls and MCP calls share a single session.

## Committing while other sessions are active

The Bash guard refuses Git commands that can replace another session's checkout or refs.

In a shared checkout (`kith mode main`, or any checkout another active session is also using), `git reset`, `git checkout`, and the other recognized checkout-rewriting commands are blocked while a peer is active. A compare-and-swap `git update-ref` of `HEAD` or `refs/heads/<the current branch>` is allowed when the pre-hook can prove it is a fast-forward of exactly one commit and every changed path belongs to the caller. The same shape with shell variables is checked after the command and reverted if that proof fails. Anything else, including an `update-ref` with no old value, stays blocked. To commit only your own files there, run:

```sh
kith commit -m "feat: scoped change" [files...]
```

If `[files...]` is omitted, `kith commit` collects the caller session's recorded modified files (from active file/narrow-glob locks, `presence.db` touched files, and active task scopes), verifies no target file is locked by another live agent, stages only those paths in a temporary index under `.coord/commit.lock`, advances `HEAD` with compare-and-swap `git update-ref`, and runs `git reset -q HEAD -- <files>` so `.git/index` stays synchronized with `HEAD` without touching peers' dirty files. You can also run `kith commit` inside `kith_run_with_mutex` / `kith_resource` (`action: "mutex"`) or pass `commitMessage` (and optional `commitFiles`) to `kith_finish`.

In an isolated worktree the guard allows `git update-ref` when the ref belongs only to the caller. That means the caller has `worktree_path`, the ref is `HEAD` or `refs/heads/<that worktree's branch>` checked out in the worktree, and no other active agent shares the worktree or the branch. A temporary-index commit in that worktree (`git commit-tree`, then `git update-ref HEAD <new> <old>`) is allowed, including with `-m <msg>`, `--no-deref`, and `--create-reflog`. `git -C <dir>` is resolved from the worktree; a `-C` or `cd` that leaves the worktree does not count as owned. `git update-ref -d` is allowed only for a ref the caller owns.

In a shared checkout the same temporary-index shape is allowed only after the pre-hook checks all of the following, before the command runs:

- the command is `git update-ref` with optional `-m`, `--no-deref`, and `--create-reflog`, and the ref is `HEAD` or `refs/heads/<the branch checked out in that directory>`
- `<old>` is present and resolves to the ref's current value (a compare-and-swap)
- `<new>` resolves to a commit with exactly one parent, and that parent is `<old>` (one fast-forward commit; merges and history rewrites are refused)
- every path in `git diff-tree -r --name-only` from `<old>` to `<new>`, including deletions and both sides of a rename, is a file the caller has claimed, locked, or recorded the way `kith commit` records files (active file and narrow-glob locks, `presence.db` touched files, and active task scopes; a `**` lock does not count). No changed path may be locked or claimed by another active agent

`<new>` and `<old>` may be literal SHAs or other revisions that resolve at check time. Shell variables and command substitutions such as `$(git commit-tree ...)` are not executed during the pre-hook, so the commit they will create cannot be read yet. When the command is still exactly that compare-and-swap shape, the pre-hook records the current ref value and lets the command run. The post-hook then applies the same parent and path checks to the commit that landed. If they fail, it compare-and-swaps the ref back to the recorded value and prints the reason, including a `kith commit -m "<message>" <files>` command built from the caller's recorded files. A short lease keeps other agents from moving the same ref until that post-hook finishes: their ref-moving commands are refused, and `kith commit` waits, so a peer does not build on a commit that is about to be reverted. If the reverting compare-and-swap loses to a later update, the hook reports that and does not force the ref.

A blocked command keeps the existing `kith commit` guidance and adds the specific reason, for example `No compare-and-swap old value` or `path src/x.ts is claimed by agent peer`. When the caller has recorded dirty files, the message includes a ready-to-run `kith commit -m "<message>" <those files>`.

These stay blocked while a peer is active:

- updates to the integration branch from an isolated worktree, or to another agent's branch
- a shared-checkout `update-ref` with no `<old>`, a merge or multi-commit jump, a path the caller does not own, or a path another agent claims
- `HEAD` updates that are not the one-commit fast-forward above, including `--no-deref` on a symbolic `HEAD` (that would retarget the symlink instead of the branch)
- `git update-ref --stdin` batches, `update-ref -d`, and any ref command the parser cannot classify
- `git symbolic-ref`, except a read or pointing the caller's own `HEAD` at `refs/heads/<the caller's branch>`
- `git worktree remove`, `git worktree prune`, and `git branch` `-d`/`-D`/`-m`/`-M`/`-f`/`--delete`/`--move`/`--force`

After `update-ref`, the post-hook resyncs the index of the checkout that command ran in: the caller's worktree, the directory selected with `-C` when that checkout belongs to the same repository, or the checkout named by a compare-and-swap `update-ref` whose values are shell variables.

## MCP ownership

`kith_begin_work`, `kith_claim_next_task`, and `kith_start_session` return a session token when they register or resume a session. A single stdio connection retains its granted capabilities internally. Another connection must explicitly present the capability to resume the same live ID. All agent-scoped mutation tools accept an optional `sessionToken`; a mixed CLI/hook/MCP client can inherit `KITH_AGENT_ID` and `KITH_SESSION_TOKEN` instead.

`kith_heartbeat` renews an active owned session. `kith_get_status` without an ID is a public read; supplying an ID also consumes that session’s event cursor and requires ownership. Responses provide `structuredContent`, a separately parseable JSON text block, and any coordination delta in another text block. Tool conflicts set `isError: true`.

Sessions started by the MCP process are abandoned on connection close; unfinished tasks are requeued. A hard crash is reclaimed by another operation’s process/expiry scan. A CLI command sharing that capability stops when its owning MCP session is lost.

The protocol response format follows the [MCP tool-result specification](https://modelcontextprotocol.io/specification/2025-11-25/server/tools).

## Supervised mutex commands

```sh
kith mutex --name package-install --lease-ms 30000 --wait-ms 60000 --timeout-ms 600000 -- pnpm install
```

The wait timeout defaults to 60 seconds. Execution has no timeout unless `--timeout-ms` is supplied. The mutex lease defaults to five minutes and is renewed at roughly one-third of the lease duration. Output streams to the terminal. Child exit statuses are preserved. SIGINT/SIGTERM cancel queued or running work; the CLI exits with 130/143 after cleanup.

A standalone mutex invocation without a pre-existing capability creates a temporary session anchored to that invocation. Reusing a live agent ID still requires its capability.

The runner records an execution guard before starting a detached process-group leader. The leader cannot launch the command until its group has been recorded and the supervisor sends a private IPC start message. A live group blocks competing acquisitions even if the resource lease or agent session has expired. If renewal fails, cancellation occurs, output exceeds its configured limit, or an execution timeout fires, Kith terminates the group before releasing the guard. It escalates from SIGTERM to SIGKILL when needed, checks the recorded group-leader identity before signalling, and bounds shutdown waits. Signal-permission errors are contained; an unconfirmed shutdown retains its guard. A worker loses permission to run when its supervisor’s IPC connection closes.

FIFO tickets live separately from the current resource lease, so releasing a mutex preserves queue order. Cancelled, dead, expired, and replaced-session waiters are pruned. Concurrent commands from the same session also serialize. Package-manager shims recognize an existing supervised package-install context, so an install wrapped explicitly in that mutex does not deadlock by reacquiring itself. This context marker is cooperative, not a security boundary. A general session heartbeat does not renew mutex leases: manual lease users must call `renewMutex` with the exact acquisition token.

This uses [Node’s POSIX detached-process support](https://nodejs.org/download/release/v22.23.0/docs/api/child_process.html). Commands must keep protected work in the supervised process group. Deliberately detached daemons, remote jobs, privileged processes that cannot be terminated, and malicious same-user code require a different lock/enforcement boundary. If Kith cannot prove that a guarded group stopped, it retains the guard and fails closed rather than granting a second runner.

## Library use

`executeWithMutex` is asynchronous. Await it before closing the engine; `close()` refuses an engine with active supervised commands.

```js
import { KithEngine } from 'kith-coord';
const engine = new KithEngine('/absolute/path/to/repository');
try {
  const session = engine.fencing.registerAgent({ id: 'worker' });
  // Another engine may resume with: fencing.resumeSession('worker', session.sessionToken).
  const result = await engine.broker.executeWithMutex({
    agentId: 'worker', mutexName: 'install', command: ['pnpm', 'install'],
    leaseDurationMs: 30_000, commandTimeoutMs: 600_000,
  });
  console.log(result.exitCode);
} finally { engine.close(); }
```

The API also accepts an AbortSignal, `timeoutMs` for queue waiting, `killGraceMs`, output callbacks, and `maxOutputBytes` (16 MiB by default). Resource renew/release operations require their exact fencing token, including rejection of invented future tokens.

## Upgrade from schema 1

Stop all old Kith clients and running commands before upgrading. The schema-2 migration invalidates legacy sessions that have no capabilities, clears their coordination leases/conflicts, and requeues unfinished tasks. It preserves workspace files, worktrees, snapshots, and quarantine copies. Create fresh sessions after upgrading. Do not run an old binary against the upgraded database.

For a database backup, stop writers and use a SQLite-aware backup or preserve the database together with its WAL/SHM files. Do not copy a live `state.db` alone and assume it is complete. Broader backup/restore and downgrade tooling remains future work.

## Commands from sandboxed MCP clients

On the validated macOS Codex version, the sandboxed native shell cannot inspect process identities, so direct CLI mutex execution fails closed with `Cannot inspect mutex waiter process`. Use `kith_run_with_mutex` on the already-owned MCP connection instead:

```json
{"agentId":"worker","mutexName":"package-install","command":["pnpm","install"],"leaseDurationMs":30000,"commandTimeoutMs":600000}
```

The executable and arguments remain separate. The working directory defaults to the registered worktree (otherwise the repository); a supplied `cwd` must resolve inside that root. The server renews the mutex while the command runs and stops it on request cancellation or connection loss, including borrowed sessions. A disconnected borrowed session retains its original owner after its command stops. Nonzero command exits set `isError: true` and retain the actual `exitCode`. Execution defaults to a 60-second timeout and 64 KiB output limit; bounded overrides are supported. Increase the client's MCP tool timeout as needed for longer commands.

This tool runs with the coordinator process permissions, outside the native client's command sandbox. Review and approve it as command execution. Cwd validation selects the working directory; it does not contain what a program can access. Use isolated worktrees and declared scopes for cooperating writers. Session capabilities never need to appear in the command arguments.
