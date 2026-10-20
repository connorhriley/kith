# MCP, CLI and library workflows

## Recommended: MCP and isolated worktrees

Connect through the [MCP-only client setup](integrations.md). Each parallel agent uses its own MCP connection and worktree. No shell exports are needed when using only MCP. The connection retains its granted capability; another connection needs that capability to resume the same ID.

Call these tools on the same connection:

```text
kith_begin_work      {"agentId":"auth-worker","title":"Refresh authentication","scopeGlobs":["src/auth/**"],"isolateWorktree":true}
# Edit files under the returned worktree.worktreePath.
kith_record_file_edit {"agentId":"auth-worker","filePath":"src/auth/middleware.ts"}
kith_run_with_mutex  {"agentId":"auth-worker","mutexName":"project-checks","command":["pnpm","typecheck"]}
kith_heartbeat       {"agentId":"auth-worker"}
kith_complete_work   {"agentId":"auth-worker","verificationCmd":"pnpm typecheck"}
```

Use a different ID and nonoverlapping scope for another agent. An overlapping exclusive scope returns a tool error. Commands run with the MCP server permissions and require client approval; their working directory defaults to the registered worktree. Keep the connection open and heartbeat before the default five-minute session expiry. See the runnable [two-client example](../examples/two-agents.mjs).

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
