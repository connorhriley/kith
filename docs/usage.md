# MCP, CLI and library workflows

## Recommended: MCP and isolated worktrees

Connect through the [MCP-only client setup](integrations.md). Each parallel agent uses its own MCP connection and worktree. No shell exports are needed when using only MCP. Omit `sessionToken` on subsequent calls on the same connection; the initial grant reply still contains it, so keep client transcripts private. The connection retains its granted capability; another connection needs that capability to resume the same ID.

For a new task, begin directly on one connection; `kith_begin_work` creates the session and claims its scope. A separate session-start, status poll, lock acquisition or manual contract publication is not needed for the same work:

```text
kith_begin_work      {"agentId":"auth-worker","title":"Refresh authentication","scopeGlobs":["src/auth/**"],"isolateWorktree":true}
# Edit files under the returned worktree.worktreePath.
kith_record_file_edit {"agentId":"auth-worker","filePath":"src/auth/middleware.ts"}
kith_complete_work   {"agentId":"auth-worker","verificationCmd":"pnpm typecheck"}
```

Use a different ID and nonoverlapping scope for another agent. An overlapping exclusive scope returns a tool error. Commands run with the MCP server permissions and require client approval; their working directory defaults to the registered worktree. Keep the connection open. Owned calls already renew the lease; in the next release their replies include `session.leaseExpiresAt` (Unix milliseconds), with `agent.lease_expires_at` on session grants. Heartbeat only during idle periods before that deadline; an expired claim cannot be used or revived. A replayed operation contains the original historical deadline and does not renew ownership. Use status for a blocker, changed coordination or recovery rather than polling between edits.

Use `kith_run_with_mutex` with literal argv when commands share mutable resources, such as a package installation or shared test database. Ordinary worktree reads need no mutex. `kith_complete_work` runs the integration verification command: avoid immediately running it twice unless diagnosis or project policy requires it. Keep all required project checks and review/merge gates. File-edit reports already publish extracted signatures; `kith_publish_contract` remains available for explicit/planned contracts. See the runnable [two-client example](../examples/two-agents.mjs).

## Launch a dev server on its allocated port

These additions are available in source builds on `main`; the published `kith-coord@0.1.3` does not include them yet. Build/link the checkout before using the CLI examples.

Run from the target repository (or pass `--repo /absolute/checkout`). Use a unique agent ID for each session. A standalone invocation creates and ends its own temporary session; an existing session must provide its capability as usual.

```sh
# A server that reads PORT needs no extra arguments.
kith dev --agent web-a --service web -- npm run dev

# For a tool requiring an explicit flag, substitute the allocated port.
kith dev --agent web-b --service web -- npm run dev -- --port '{port}'

# Vite: refuse a fallback port so the server cannot silently switch away.
kith dev --agent web-c --service web --base 3000 -- pnpm exec vite --port '{port}' --strictPort
```

Kith starts scanning at 3000 by default, checks TCP availability and live reservations, and prints the allocation to stderr. It launches the literal argv with `PORT` and `KITH_PORT` set to the allocated number. Every `{port}` occurrence in an argument is substituted; shell metacharacters remain literal. It does not inject framework flags or rewrite configuration. Tools that ignore `PORT` must receive their own port flag via `{port}`. Use `--cwd apps/web` to select a subdirectory; the default is the registered worktree or selected checkout.

The lease renews while the supervised process group runs. Ctrl-C/SIGTERM stops that group before releasing the reservation, and the command's exit status is preserved. For a temporary CLI session, completion also ends that session. A named service serializes launches from the same agent; different agents/services can run concurrently on separate ports.

This does not hold a listening socket for the application or prove readiness. An unrelated process can win the bind race; the command's bind error is surfaced, with no automatic restart that might repeat side effects. The allocation is not a readiness URL or proof that a framework honored its port. Detached daemons escaping the group are outside the supervision boundary. Native Windows supervised launch is refused; use macOS/Linux or WSL.

MCP clients with an active session can call:

```text
kith_run_dev_server {"agentId":"web-a","serviceName":"web","command":["pnpm","exec","vite","--port","{port}","--strictPort"],"commandTimeoutMs":600000}
```

This is a foreground tool call, returning the port, captured output and exit code when it ends. MCP defaults to a 60-second execution deadline and 64 KiB combined output limit; explicit limits allow up to 10 minutes and 1 MiB. Cancel the request or disconnect to stop the group. For a server needed throughout a longer interactive session, use the streaming CLI. Client approval applies: the process runs with the coordinator's permissions, not the client's shell sandbox. CLI output streams and has the existing supervisor's 16 MiB default combined output limit.

## Wait for a shared file claim

By default, overlapping exclusive claims still fail immediately. Opt in to bounded retry for occasional shared files:

```sh
# Within an existing capability-owned CLI session:
kith begin --agent worker-1 --title "Update shared config" --scope 'package.json' --wait --wait-ms 30000

# Or acquire a file scope without creating a new task:
kith lock acquire --agent worker-1 --scope 'package.json' --wait --wait-ms 30000
```

`--wait` alone waits up to 60 seconds. `--wait-ms` also enables waiting without `--wait`, accepts 0–600000 milliseconds, and returns a conflict with nonzero exit status on timeout. Ctrl-C cancels the wait. Waiting renews the owning session, but cannot revive an expired or replaced session.

The whole scope is checked atomically on each retry. No partial requested claim, task, or new worktree is created while blocked. On success, the usual exclusive ownership rules apply. Explicit requests report `waitedMs` and `waitTimedOut` alongside the normal result. Unsupported paths and invalid scopes fail immediately rather than being retried.

On MCP, add `waitTimeoutMs` to `kith_begin_work` or `kith_check_and_lock_files`:

```text
kith_check_and_lock_files {"agentId":"worker-1","patterns":["file:package.json"],"waitTimeoutMs":30000}
```

The request remains open while waiting and responds to request cancellation and connection loss. Another request on the same connection can still heartbeat or release unrelated claims.

This is cooperative retry, **not a FIFO file queue**. Use task dependencies when order matters. Do not claim multiple shared files in different orders across agents: retain no unnecessary claims while waiting, and always choose a finite deadline. Waiting for a worktree task grants ownership; it does not automatically rebase an existing worktree onto a peer's edits. Review the current file before changing it.

Library callers can await `engine.beginWorkWhenAvailable(...)`, `engine.acquireLocksWhenAvailable(...)`, or `engine.broker.executeWithPort(...)`, passing an `AbortSignal` for cancellation. Await/cancel those operations before closing the engine.

## Keep existing PR branches and checks

For independent PRs, create each task's Git worktree from the intended PR base first, connect Kith to that worktree and use a fresh agent ID with `isolateWorktree:false`. Keep the existing PR/review/merge process. Kith-created worktrees branch from the selected integration checkout's current HEAD; they inherit its setup and earlier integrated commits.

Successful completion ends the session and retains its worktree. Run owned commands before completing, or start a fresh session for later maintenance. A refused claim can leave an active session without locks; it can retry on the same connection or expire normally. Status `conflicts` describes current detected file conflicts, not a history of refused scope claims.

Integration refuses a target with uncommitted or untracked work to preserve it. Commit or preserve those files explicitly, use a clean integration checkout, or keep the existing PR workflow above. Do not blanket-ignore unknown files to silence the guard. The supervised command runner uses the server's permissions, including network access; it is not a sandbox. `verificationCmd` is an explicit shell string; mutex commands use literal argv.

## CLI fallback: keep the owning shell alive

CLI commands and Claude edit hooks need the same capability environment. Start from one persistent shell, then launch hook clients from it. Separate stateless shell calls do not preserve these exports or the owning shell process.

Run from the repository root, or pass `--repo /absolute/path`:

```sh
eval "$(kith session start --agent auth-worker --owner-pid "$$" --shell)"
kith begin --agent auth-worker --title "Refresh authentication" --scope "src/auth/**" --worktree
# Edit in the worktreePath returned in the JSON result.
kith status
kith heartbeat --agent auth-worker
kith complete --agent auth-worker --verify "pnpm typecheck"
# Open a maintenance generation to remove the retained worktree explicitly.
eval "$(kith session start --agent auth-worker --new --owner-pid "$$" --shell)"
kith worktree remove --agent auth-worker
kith session end
unset KITH_AGENT_ID KITH_SESSION_TOKEN
```

Quote globs so the shell does not expand them. CLI scopes are comma-separated. Use `file:src/routes/[id]/page.tsx` for a literal filename containing glob syntax; see [scope grammar and discovery](path-and-scope-rules.md). An ID alone cannot resume another session. Dead or expired sessions release coordination resources when a mutating operation reaps them. Active supervised command guards survive expiry until shutdown is confirmed.

Completion checkpoints uncommitted worktree changes and integrates into the branch currently checked out in the selected repository checkout (`--repo` when supplied). The target must be clean. A verification failure leaves the target unchanged and the worktree available for repair. Successful completion also keeps the worktree for inspection; removal is explicit and refuses dirty, untracked, or ignored work. Existing branches are never reset to create a worktree. Hydration tries filesystem clones and falls back to an independent copy; cost depends on the filesystem and dependency size.

A verification command is optional. Without one, integration checks Git mergeability only. Choose a command that actually checks your project.

## Other CLI workflows

These agent-scoped commands assume an active session. Start one before claiming work or reserving resources:

```sh
eval "$(kith session start --agent worker-1 --owner-pid "$$" --shell)"

# Task dependencies
kith task add --id schema --title "Billing schema" --scope "src/db/**"
kith task add --id api --title "Billing endpoints" --depends-on schema --scope "src/api/**"
kith task claim --agent worker-1

# Inspect worktrees, overlaps, relative commits, FIFO tickets and command guards
kith status
# Offline observations do not reap or migrate
kith status --offline
kith recover
kith doctor
# Preview committed source/target trees; dirty inputs are refused
kith worktree preview --agent worker-1

# Allocate a cooperating client's port; start your service promptly
kith port --agent worker-1 --service web

# Serialize commands; argument boundaries are preserved after --
kith mutex --agent worker-1 --name package-install -- pnpm install

# Start the MCP stdio server
kith mcp
```

The `coord` executable is an alias for `kith`. The library exports `KithEngine` and its component classes for custom integrations:

```js
import { KithEngine } from 'kith-coord';
const kith = new KithEngine('/absolute/path/to/repository');
try {
  kith.fencing.registerAgent({ id: 'custom-worker' });
  const result = kith.locks.acquireLocks({
    agentId: 'custom-worker', patterns: ['src/auth/**'],
  });
  console.log(result);
} finally {
  kith.close();
}
```

## End a session

When abandoning a task, use `kith session end` from the shell that owns the session. After completion or ending, remove the exported credentials:

```sh
unset KITH_AGENT_ID KITH_SESSION_TOKEN
```

Never include session tokens in issues, terminal recordings, or shared logs. See [session lifecycle](sessions-and-mutexes.md) for expiry and recovery.


## Optional read-only worktree observations

`kith watch /absolute/checkout --once --json` reports uncommitted path overlaps across linked worktrees sharing a Git common directory. A parent directory can contain several independent repositories; equal filenames in unrelated repositories do not establish a collision. The watcher does not identify agents, enforce ownership, or establish contract/semantic compatibility. Clean output means only that the completed scan observed no differing or unverified shared dirty paths. Failed discovery or Git reads produce `complete:false`, error details and a nonzero one-shot exit; inspect the failure before relying on the observation.

The read-only watcher excludes byte-identical dirty copies (including matching executable modes) across linked worktrees. Remaining shared dirty paths are advisories, not proven merge conflicts. Files over 8 MiB and non-file objects remain unverified rather than being treated as identical. The menu shows at most eight overlap rows; `kith watch --once` provides the full observations.

Omit `--once` for continuous observation. `--notify=false` suppresses optional macOS notifications. From the next release, macOS setup opens Radar automatically unless `--no-radar` is passed. Dry runs never launch it. An existing view keeps its selected workspace; choose **Switch Workspace** in its menu to change it. Setup adds no login item. Radar polls local state without model calls or MCP conversation traffic. On macOS 12 or newer, `kith menubar /absolute/checkout` opens the same limited read-only view. The package includes an Intel/Apple Silicon executable, launched with this installation's Node and CLI paths; unavailable/failed scans remain visibly unavailable. Other platforms use `kith watch`. Source contributors can rebuild with `pnpm build:menubar` using Apple's command-line tools, and run the pipe/timeout regressions with `pnpm test:menubar`.
