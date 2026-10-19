# Architecture

Kith runs locally. There is no coordination server: CLI and MCP clients share `.coord/state.db` through SQLite WAL.

## Core components

| Module | Responsibility |
| --- | --- |
| `db.ts` | Schema initialization, synchronous writer transactions, event log, monotonic token counter |
| `fencing.ts` | Capability-owned session generations, heartbeats, real PID/start-time checks, reclamation |
| `locks.ts` | Scoped lock acquisition, conflict detection, write checks |
| `intents.ts` | Work declarations, task dependencies, transactional claims |
| `ast-analyzer.ts`, `dep-graph.ts`, `dedup.ts` | Source-derived contracts, import relationships, duplicate hints |
| `shadow-git.ts` | Per-agent indexes, synthetic commits, dirty-tree merge probes |
| `worktree-cow.ts` | Isolated worktree creation and dependency hydration |
| `merge-train.ts` | Serialized integration through a disposable staging worktree |
| `bash-guard.ts` | Best-effort snapshots and quarantine recovery |
| `broker.ts` | Port reservations, FIFO mutex tickets, renewable command leases and process-group guards |

`src/cli` adapts commands and hook payloads. `src/mcp/server.ts` exposes tools. `src/tui/dashboard.ts` renders shared state. Library consumers use `src/index.ts` exports and close engines explicitly.

## State boundaries

Writer transactions use `BEGIN IMMEDIATE`, so task claims and lock conflict checks share a single SQLite writer boundary. No asynchronous work should occur inside a database transaction. Port probing occurs before the transaction and reservations are rechecked inside it.

Git integration uses an exclusive local lock file and a unique staging directory per attempt. Kith checks the target's cleanliness, branch, and HEAD before advancing it. This does not serialize external Git processes. A crash intentionally leaves the lock for inspection rather than guessing that it is safe to reclaim.

Worktrees have separate files, but generated client configurations do not automatically unify their coordination databases. Pass the main repository root explicitly when sharing coordination state. A dedicated, tested common-Git-directory discovery mechanism is future work.

Session capabilities are held in each engine's memory and hashed in the separate `agent_sessions` table. Agent records/status do not expose them. Mutation boundaries assert ownership inside writer transactions where applicable. `mutex_waiters` preserves handoff order independently of a resource row, and `mutex_runs` preserves execution exclusion even if session/resource rows expire. A private IPC handshake records a worker process group before it can execute a command. See [session and command lifecycle](sessions-and-mutexes.md).

Worktree edit reports read source bytes from the registered worktree and store repository-relative contracts. Git checkpoint/merge subprocesses receive the owning capability in their environment so generated pre-commit guards can authorize them. This does not yet implement general automatic worktree/common-directory discovery.

## Adaptation

Use a new adapter for a new agent client, retaining the same core lock/task APIs. Keep heuristic analysis advisory. Add language-specific parsers behind the analyzer boundary, and preserve unsupported syntax rather than assuming that a text match proves compatibility. Custom verification commands belong to the target project.
