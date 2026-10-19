# CLI and library workflows

## Coordinate two agents

Run commands from the repository root, or pass `--repo /absolute/path`. Create a capability-owned session and share its environment with CLI commands and hooks. An agent ID alone cannot resume another session.

```sh
eval "$(kith session start --agent auth-worker --owner-pid "$$" --shell)"
kith begin --agent auth-worker --title "Refresh auth middleware" --scope "src/auth/**"
kith status
kith heartbeat --agent auth-worker
kith complete --agent auth-worker
unset KITH_AGENT_ID KITH_SESSION_TOKEN
```

A second agent requesting an overlapping exclusive scope receives a conflict and a nonzero exit status. Quote globs so the shell does not expand them. Scopes are comma-separated. Use `file:src/routes/[id]/page.tsx` for a literal filename containing glob syntax; see [scope grammar and discovery](path-and-scope-rules.md). Leases default to five minutes; heartbeat during longer sessions. Dead or expired sessions release coordination resources when another operation runs the reaper. Active supervised command guards survive expiry until the command group stops. See [sessions and mutexes](sessions-and-mutexes.md) for ownership, cancellation, and upgrade details.

For stronger filesystem separation, use a worktree:

```sh
eval "$(kith session start --agent billing-worker --owner-pid "$$" --shell)"
kith begin --agent billing-worker --title "Billing webhooks" --scope "src/billing/**" --worktree
# Edit in the worktreePath returned in the JSON result.
kith complete --agent billing-worker --verify "pnpm typecheck"
# Open a new maintenance generation after the completed session.
eval "$(kith session start --agent billing-worker --new --owner-pid "$$" --shell)"
kith worktree remove --agent billing-worker
kith session end
unset KITH_AGENT_ID KITH_SESSION_TOKEN
```

Completion checkpoints uncommitted worktree changes and integrates into the branch currently checked out in the selected repository checkout (`--repo` when supplied). The target must be clean. A verification failure leaves the target unchanged and the worktree available for repair. Successful completion also keeps the worktree for inspection; removal is explicit and refuses dirty, untracked, or ignored work. Existing branches are never reset to create a worktree. Hydration tries filesystem clones and falls back to an independent copy; cost depends on the filesystem and dependency size.

A verification command is optional. Without one, integration checks Git mergeability only. Choose a command that actually checks your project.

## Other workflows

These agent-scoped commands assume an active session. Start one before claiming work or reserving resources:

```sh
eval "$(kith session start --agent worker-1 --owner-pid "$$" --shell)"

# Task dependencies
kith task add --id schema --title "Billing schema" --scope "src/db/**"
kith task add --id api --title "Billing endpoints" --depends-on schema --scope "src/api/**"
kith task claim --agent worker-1

# Inspect the dashboard once, or omit --once for a live view
kith top --once

# Allocate a cooperating client's port; start your service promptly
kith port --agent worker-1 --service web

# Serialize commands; argument boundaries are preserved after --
kith mutex --agent worker-1 --name package-install -- pnpm install

# Start the MCP stdio server
kith mcp
```

The `coord` executable is an alias for `kith`. The library exports `KithEngine` and its component classes for custom integrations:

```js
import { KithEngine } from 'kith';
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
