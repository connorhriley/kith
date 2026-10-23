# Kith coordination protocol 1.4

Kith is a local ledger for cooperating coding agents. Clients share one repository's coordination state, including across linked Git worktrees. The transport is MCP over stdio (`kith mcp --repo /absolute/checkout`). No hosted service or Kith API key is required. The server process has the user's filesystem and command permissions.

## Versioning and schemas

Protocol 1.1 ships with package 0.1.2. Earlier `kith-coord@0.1.1` reports protocol 1.0 and includes full contracts in MCP status; the compact default and `includeContracts` input below require 0.1.2.

`KITH_PROTOCOL_VERSION` and status responses advertise `1.4.0` starting with package 0.1.6. Package releases (`kith-coord`, beginning at 0.1.0) and the SQLite storage schema (3) have independent versions. The [tool snapshot](protocol/tools.v1.json) contains all 14 tool names, descriptions and JSON input schemas, exported from an actual MCP `tools/list` response. `pnpm protocol:check` rejects snapshot drift in CI. Update deliberately using `pnpm protocol:export`.

For protocol 1.x, existing tool names, required input fields and the ownership/claim semantics below remain compatible. New optional fields/tools and additive result fields use a minor version; compatible repairs use a patch version. Removing tools, adding required inputs or changing ownership semantics requires a major version. Clients should ignore unknown result fields. The snapshot describes inputs; it is not a machine-validated schema for every result or a guarantee of source-level library compatibility.

Successful tool replies place the same JSON object in `structuredContent` and the first text block. Additional text may contain an advisory event delta. Inspect `isError` and the operation's fields: a computed preview with `clean:false` is a successful observation of a conflict, not permission to integrate. Operational failures also return `failure` as described below. Malformed arguments, unknown tools and transport/protocol errors still use the MCP SDK error format; do not retry those blindly. Never infer successful work from the client process exit code alone.

Protocol 1.2 adds optional `repository` to every tool. A global `kith mcp` connection can route calls independently to absolute Git checkout paths; it creates no project database until a project is selected. A Git checkout in the process/project context supplies a default. Without one, calls must include `repository` and otherwise return a tool error while the connection remains available. Never substitute HOME or a filesystem root. Always keep the original checkout path for a task, even when editing its isolated worktree. Capabilities and commands remain attached to their repository context, and disconnect cleanup covers every opened context. An explicit `mcp --repo` connection retains its pinned checkout and refuses a different repository argument.

## Sessions and claims

- `kith_start_session` or `kith_begin_work` grants a random session capability for a unique `agentId`. The owning MCP connection retains it. Another connection needs the capability to resume that generation; an ID is not authorization. Omit `sessionToken` on subsequent calls on the owning connection. Tokens are returned at grant/resume, so client transcripts can contain capabilities and must stay private. Public status omits capabilities and their hashes.
- `kith_heartbeat` renews an owned active generation before expiry (five minutes by default). It cannot revive an expired or completed generation. Engine startup may reap expired/dead owners and requeue unfinished tasks. Active supervised command guards remain until shutdown is confirmed.
- `kith_begin_work` declares an intent and atomically acquires its supported scope claims. An overlapping exclusive claim returns a conflict. Use `isolateWorktree:true`, and edit only the returned `worktree.worktreePath`. Worktrees separate files while claims describe cooperative ownership across checkouts.
- `kith_check_and_lock_files` acquires file/glob/symbol claims using fencing generations. See [scope rules](path-and-scope-rules.md); unsupported patterns are rejected. Direct filesystem writes and bypassed hooks are outside this protocol's enforcement boundary.
- `kith_add_task` adds tasks with priority, scope and optional `dependsOn`. `kith_claim_next_task` atomically claims the next unblocked task and its scope. `kith_get_status` lists tasks. These are the canonical names; there are no redundant task aliases or capability-matching scheduler.
- `kith_record_file_edit` reports actual worktree changes. `kith_publish_contract` publishes an explicit interface record. Contract analysis and exact-name reuse hints are advisory, not proof of semantic compatibility.
- `kith_acquire_port` reserves a port among Kith clients. The OS probe socket is released; unrelated processes can still bind it. `kith_run_with_mutex` executes literal argv under a renewable named FIFO mutex and persistent process-group guard. Cancellation/disconnect stops the guarded command before release. Do not detach protected work from its supervised group.

## Workspace observation and integration

`kith_get_status` preserves agents, tasks, locks, conflicts, resources, merge queue and quarantine. In protocol 1.1, frequent MCP polls return `contracts:[]`, `contractCount` and `contractsIncluded:false` by default; pass `includeContracts:true` to inspect the full registry. CLI `kith status` and `kith contract list` still include full contract records. Edit reports publish only new or changed contract metadata, retaining unchanged records without repeating them. It adds `protocolVersion`, `mutexWaiters` (ticket order), `commandGuards`, and `workspaces`. Normal status observes active owners; offline inspection also includes retained recorded worktrees. Each workspace reports its path, recorded and actual branch, HEAD, dirty paths (including rename sources), last commit time/age, last heartbeat, lease expiry, availability, and dirty-file overlaps with active peers. `ahead`/`behind` compare against `comparisonBase`, the selected integration checkout's observed HEAD. Commit age is descriptive; an old commit is not evidence of a dead agent. Missing/unreadable workspaces are marked unavailable, not clean. Git observations are sequential snapshots, not a transaction over all files/checkouts.

`kith_preview_integrate` requires an owned registered worktree on its recorded branch, committed source changes, and a clean integration target. It reports frozen `sourceHead`/`targetHead`, branch names, `clean`, and exact Git conflict paths. Dirty inputs return `ok:false` and are not checkpointed. Git may write unreachable merge-tree objects, but preview never stages files, advances refs or rewrites worktree contents. Authorization can renew the session and deliver an event delta. A clean preview does not run project verification or guarantee a later integration: inputs can change.

`kith_complete_work` checkpoints source changes and integrates through a separate staging worktree into the selected checkout's current branch. Supply `verificationCmd`; without it, only Git mergeability is checked. Dirty/racing targets, Git conflicts and failing or mutating verification refuse integration. Failure retains source work, task and claims for repair/retry. Successful completion releases ownership/resources and retains the source worktree for explicit inspection/removal. External Git writers must coordinate too.

## Offline inspection

Normal CLI/MCP status opens the engine and may migrate or reap. `kith status --offline`, `kith recover`, and `kith doctor` instead inspect a private copy of the database plus matching SQLite sidecars. They never initialize/migrate the original, renew/release claims, clear guards, or remove work. If files change while being copied or validation fails, observation is unavailable; stop writers and preserve the complete set before retrying. `recover` lists retained worktree directories, recorded owners, expired claims, unfinished integrations and lock-file presence. It performs no automatic repair. See [recovery](reliability.md).

Preview refuses repositories with configured custom merge drivers because Git can execute their commands during merge-tree. It does not silently substitute a different merge policy. Actual integration can run trusted project code and still needs an appropriate verification command.

## Protocol 1.3 additions (0.1.4)

`kith_run_dev_server` launches literal argv with an allocated port in `PORT`/`KITH_PORT` and substitutes `{port}` in arguments. It uses the existing process-group supervisor and permission boundary. Cancellation/disconnect drains execution before cleanup. It is foreground, with a default 60-second deadline and bounded output; longer-lived interactive servers should use `kith dev` in the CLI. No readiness or socket handoff is promised.

`kith_begin_work` and `kith_check_and_lock_files` accept optional `waitTimeoutMs` (0–600000). Omitted fields preserve fail-fast behavior. Wait results add `waitedMs` and `waitTimedOut`; timeout keeps the normal conflict payload, with `isError:true`. Cancellation is a request error and never grants a partial claim. No FIFO ordering guarantee is added. The storage schema is unchanged; the published 0.1.3 package still uses protocol 1.2.

## Protocol 1.4: keyed retries and operational failures (0.1.6)

These additions ship in `kith-coord` 0.1.6. Existing callers can omit the new fields and retain the same ownership requirements.

Mutating tools accept an optional client-generated `operationKey` (1–128 characters). Generate a fresh UUID for each logical attempt. After a timeout, resend the **same tool, original checkout, agent ID, key and arguments**. The server stores a reservation before execution and a result afterward in the existing repository database. It never executes the reserved operation a second time. A different tool, checkout or argument set with the same key returns `OPERATION_KEY_REUSED`. Explicit `sessionToken` may be supplied on another connection without changing the request identity.

`kith_add_task` accepts optional `agentId` and `sessionToken`; a keyed task addition requires an already owned session. Unkeyed task additions retain their existing behavior. Heartbeats and observations (`kith_get_status`, `kith_preview_integrate`) do not accept operation keys: they must refresh or observe current state on each call.

Keyed replies add `operation: { key, state, replayed }`:

- `completed`: the original success **or failure** was recorded. A replay returns that historical snapshot, with no new task, command, port allocation, contract update or integration. It does not renew a lease, reacquire a claim, deliver another event delta or establish that the old result is still current. After repairing a failure, use a **new** key for the new attempt.
- `running`: no result has been recorded and the coordinator process is still alive. `OPERATION_IN_PROGRESS` permits backoff and another read using the **same** key; it never starts another execution. A suspended process is still an owner.
- `unknown`: the coordinator died before recording a result, or the result could not be saved. `OPERATION_OUTCOME_UNKNOWN` refuses automatic re-execution. Inspect project status, retained worktrees, command output and external side effects. A deliberate new attempt needs a new key after that review.

An operation key is not a capability. Replay requires the original session token, retained internally on the owning connection or supplied explicitly on a different connection. A token from a replacement session cannot retrieve the old generation's result. The old capability may read its historical result after expiry/completion, but cannot resume, heartbeat, mutate or release a replacement generation. Raw session tokens are not saved in operation records; initial grant replays reconstruct the token from the caller's proof. If the initial grant response and connection are both lost before the caller receives a capability, possession of the key cannot recover that secret or seize the session. Inspect/recover the retained work after its owner expires.

Operational tool errors set `isError:true`, preserve existing fields and add `failure: { code, message, retryable, retryAfterMs? }` to both JSON text and `structuredContent`:

| Code | Retryable | Client action |
| --- | --- | --- |
| `CLAIM_CONFLICT`, `CLAIM_WAIT_TIMEOUT`, `MUTEX_WAIT_TIMEOUT` | Yes | Back off; use a new key for another attempt. Existing failure snapshots stay unchanged. |
| `OPERATION_IN_PROGRESS` | Yes | Back off and resend the exact same key/request to recover its result. |
| `OPERATION_OUTCOME_UNKNOWN` | No | Inspect effects and recovery state; never blindly repeat commands or integration. |
| `INTEGRATION_FAILED` | No | Read `mergeResult.diagnostics`, inspect/repair the retained source worktree and normal project checks, then use a new key. |
| `COMMAND_FAILED`, `COMMAND_TIMEOUT`, `COMMAND_OUTPUT_LIMIT`, `CANCELLED` | No | Inspect bounded output and partial effects. Cancellation/deadlines do not undo completed filesystem or external writes. |
| `SESSION_OWNERSHIP`, `STALE_FENCING_TOKEN` | No | Establish valid current ownership; never bypass a lease or guard. |
| `OPERATION_KEY_REUSED`, `INVALID_REQUEST` | No | Correct the request; new work needs a new key. |
| `DATABASE_BUSY`, `STATE_UNAVAILABLE`, `OPERATION_FAILED` | No | Preserve state and diagnose. A generic storage/runtime error may occur after a side effect. |

Command execution deadlines/cancellation retain captured bounded `stdout` and `stderr` where available. A computed preview with `clean:false` remains an observation, not a failed command or permission to integrate. Task-queue polling with `claimed:false` remains a successful observation of no eligible task.

Reservations/results survive process restarts, including a lost response after completion. Records are not automatically expired or pruned: forgetting a key would allow a later retry to execute again. They include private command output/diagnostics; protect and preserve the complete `.coord` recovery set. This is at-most-once execution for a retained key under coordinator process failures, **not exactly-once external effects**, command rollback or a guarantee across power loss, damaged/lost storage or manually discarded history. Stop older clients before upgrading schema 2 to 3. The additive transaction preserves existing sessions, claims and command guards; older binaries reject schema 3 instead of dropping the journal. Offline observation accepts schemas 2 and 3 without migrating the original.
