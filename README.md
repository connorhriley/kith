<p align="center">
  <img src="assets/brand/readme-header.png" alt="Kith — Parallel agents. Shared direction. Local coordination for coding agents." width="100%">
</p>

Kith helps coding agents coordinate work in the same local repository. Give each agent a scope, detect overlapping work, and inspect shared state through the CLI, terminal dashboard, or MCP.

- **Claim a scope.** Register a task and check for overlapping exclusive scopes.
- **See shared work.** Inspect sessions, tasks, and coordination state.
- **Work in isolation.** Create agent worktrees and integrate completed work, with an optional project verification command.

<p align="center">
  <a href="#try-it-from-source">Quick start</a> · <a href="docs/integrations.md">Integrations</a> · <a href="docs/reliability.md">Reliability</a> · <a href="CONTRIBUTING.md">Contributing</a>
</p>

**Status: experimental.** Kith has useful coordination primitives and regression tests, but needs field testing before use on irreplaceable work. It is designed for cooperating agents on one machine. Hooks and fencing checks are not an OS security boundary.

## Try it from source

Requirements: Git 2.38+ and Node.js 22.13+ on the 22.x line, or Node.js 24+. Development targets macOS and Linux; Windows support is not yet validated. Node's SQLite module may emit an experimental warning.

```sh
git clone https://github.com/connorhriley/kith.git
cd kith
corepack enable
pnpm install --frozen-lockfile
pnpm check
pnpm link --global
kith help
```

Use the source checkout for now. Package-name ownership and registry publication have not been verified.

In a disposable Git repository, preview setup before applying it:

```sh
kith init --dry-run
kith init --only claude,agents
```

`--only` accepts `claude,codex,cursor,agents,git,shims`. Without it, all are selected. Setup preserves unrelated settings, existing hooks, and MCP servers; invalid JSON/TOML stops setup before configuration writes. Review the returned file list and warnings. Claude MCP configuration lives in `.mcp.json`; hooks live in `.claude/settings.json`. Existing Git pre-commit hooks are left for you to integrate with your hook manager.

Hook and MCP configurations execute `kith`, so make sure it is installed on the client process's `PATH`. Restart the client after changing configuration. See [integration details](docs/integrations.md).

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

A second agent requesting an overlapping exclusive scope receives a conflict and a nonzero exit status. Quote globs so the shell does not expand them. Scopes are comma-separated. Leases default to five minutes; heartbeat during longer sessions. Dead or expired sessions release coordination resources when another operation runs the reaper. Active supervised command guards survive expiry until the command group stops. See [sessions and mutexes](docs/sessions-and-mutexes.md) for ownership, cancellation, and upgrade details.

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

Completion checkpoints uncommitted worktree changes and integrates into the branch currently checked out in the main repository. The target must be clean. A verification failure leaves the target unchanged and the worktree available for repair. Successful completion also keeps the worktree for inspection; removal is explicit and refuses dirty, untracked, or ignored work. Existing branches are never reset to create a worktree. Hydration tries filesystem clones and falls back to an independent copy; cost depends on the filesystem and dependency size.

A verification command is optional. Without one, integration checks Git mergeability only. Choose a command that actually checks your project.

## Runnable client example

Run `pnpm demo` from the checkout. It starts two real MCP stdio clients, edits separate Git worktrees in a disposable repository, reports the files, and verifies/integrates both branches. No model API calls are involved. For opt-in runs against installed Codex and Claude Code, including native edits, denied edits, supervised commands and integration, see [native client validation](docs/client-validation.md).

## Other workflows

```sh
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

## Capabilities and limits

| Capability | Practical boundary |
| --- | --- |
| Scoped file, glob, and symbol locks | Cooperative checks; glob intersections use heuristics and need more adversarial coverage |
| Task claims and fencing tokens | SQLite writer transactions; callers must check results and present tokens where supported |
| Contract and dependency hints | Lightweight source parsing, not a compiler or a complete type-system analysis |
| Duplicate-symbol hints | FTS and structural heuristics; false positives and misses are possible |
| Dirty-tree conflict probes | Git shadow indexes; Git failures surface as errors; automatic additive merges still need project verification |
| Bash mutation quarantine | Recovery copies with exclusions and size limits; automatic restoration is disabled by default |
| Port leases | Unique among live Kith reservations; no socket is held for the eventual service |
| Command mutexes | Renewed leases, persistent FIFO tickets, and guarded process groups; protected work must stay in the supervised group |
| Merge integration | Serialized Kith integrations and isolated staging; external Git writers must still coordinate |

See the [reliability contract](docs/reliability.md), [architecture](docs/architecture.md), and [roadmap](docs/roadmap.md) before extending or deploying Kith.

## Contribute

Review [unreleased changes and migration notes](CHANGELOG.md). Start with [CONTRIBUTING.md](CONTRIBUTING.md). Run `pnpm check`; it typechecks, builds the distributable, and runs unit, Git integration, CLI/MCP end-to-end, supervision failure, and 50-process contention tests. CI is configured for macOS/Linux and supported Node versions; a local run does not establish that the CI matrix has passed.

Licensed under [MIT](LICENSE). See [SECURITY.md](SECURITY.md) for reporting guidance and [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md) for participation expectations.
