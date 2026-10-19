# Sessions, ownership, and supervised commands

## Start and share a session

A session has a unique agent ID, a random 256-bit capability, a generation (epoch), a kernel process identity, and an expiry. An ID alone grants no ownership. The database stores a hash of the capability; public agent records and event/status responses omit it.

For a terminal workflow, initialize the environment before launching an agent client:

```sh
eval "$(kith session start --agent auth-worker --owner-pid "$$" --shell)"
kith begin --title "Refresh authentication" --scope "src/auth/**"
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
import { KithEngine } from 'kith';
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
