<p align="center">
  <img src="assets/brand/readme-header.png" alt="Kith — Parallel agents. Shared direction. Local coordination for coding agents." width="100%">
</p>

<p align="center">
  <a href="https://github.com/connorhriley/kith/actions/workflows/ci.yml"><img src="https://github.com/connorhriley/kith/actions/workflows/ci.yml/badge.svg" alt="CI status"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-22C55E" alt="MIT license"></a>
</p>

<p align="center">
  <a href="#quick-start">Quick start</a> · <a href="#see-it-work">Demo</a> · <a href="docs/integrations.md">Integrations</a> · <a href="docs/usage.md">CLI &amp; API</a> · <a href="CONTRIBUTING.md">Contribute</a>
</p>

**Run coding agents in parallel, with explicit ownership of the work.**

One agent changes an interface while another builds against it. Two agents edit the same file. Separate worktrees still compete for a dev-server port or a package install.

Kith gives cooperating agents shared local state: who owns a task, which files are claimed, and which commands need to wait. Use it through a CLI, terminal dashboard, or MCP server. Coordination lives in SQLite on your machine; Kith itself needs no hosted service or model API key.

## What Kith does

| Need | Kith provides |
| --- | --- |
| Keep tasks from overlapping | Scoped claims with conflict responses |
| Give agents separate working files | Git worktrees with an explicit integration step |
| Check work before integration | Your project's verification command |
| Share local tools | Port reservations and supervised command mutexes |
| See what is happening | Session/task state through `kith status`, `kith top`, and MCP |

Kith fits workflows where you already launch multiple coding agents and want them to coordinate. It does not choose models, write prompts, or launch a fleet for you. Worktrees separate files; Kith adds shared ownership and resource coordination.

**Experimental.** Kith relies on cooperating clients. Hooks are not an OS security boundary, and analysis of globs and source code is heuristic. Start in a disposable repository. Read the [reliability contract](docs/reliability.md) before using it on important work.

## Quick start

Requires **Git 2.38+**, **Node.js 22.13+ on 22.x or Node.js 24+**, and the pinned **pnpm 10.20.0**. Development targets macOS and Linux. Windows is unvalidated. Node may print an experimental SQLite warning.

```sh
git clone https://github.com/connorhriley/kith.git
cd kith
corepack enable
pnpm install --frozen-lockfile
pnpm build
```

### See it work

```sh
pnpm demo
```

The demo starts **two real MCP clients**, gives each a separate Git worktree in a temporary repository, refuses an overlapping claim, records their edits, and verifies/integrates both changes. It removes the temporary repository afterward. No model calls or client credentials are needed.

```text
auth: claimed src/auth.mjs in an isolated worktree
billing: overlapping claim on src/auth.mjs refused
billing: claimed src/billing.mjs in an isolated worktree
auth: isolated edit reported, verified, and integrated
billing: isolated edit reported, verified, and integrated
Two real MCP clients completed work in separate worktrees. Disposable example passed.
```

The implementation is in [examples/two-agents.mjs](examples/two-agents.mjs). This demonstrates the coordination protocol; [native-client validation](docs/client-validation.md) separately exercises installed coding clients.

### Connect your client

Link the built CLI, then switch to the repository you want to coordinate:

```sh
# From the Kith checkout
pnpm link --global
kith help

# From your target repository, preview the selected integrations first
kith init --dry-run --only claude,codex,agents
kith init --only claude,codex,agents
```

Choose only the clients you use. Setup preserves unrelated settings and existing hooks; review the returned files and warnings, then restart your client. The `kith` executable must be on that client's `PATH`.

| Client | Setup and validation |
| --- | --- |
| Claude Code | MCP and edit hooks; recorded native CLI runs |
| Codex | Project MCP configuration; recorded native CLI runs with configuration overrides |
| Cursor | Generated MCP configuration; native application behavior unvalidated |
| Other MCP clients | stdio server via `kith mcp`; client-specific validation required |

Native checks are version-specific. GUI discovery and persisted project trust need separate checks. See [integration setup](docs/integrations.md), [recorded validation](docs/client-validation.md), and [session ownership](docs/sessions-and-mutexes.md) before mixing hooks, CLI commands, and MCP clients.

Source installation is the current distribution path. Package-name ownership and registry publication have not been verified.

## How a task moves through Kith

1. **Open a session.** A capability identifies the owning session; an agent name alone is insufficient.
2. **Claim a scope.** Cooperating clients receive a conflict when an exclusive claim overlaps another claim.
3. **Do the work.** Edit a shared checkout or the returned isolated worktree. Keep the session alive and report work through the client integration.
4. **Verify and complete.** For a worktree, Kith checkpoints changes and integrates through a separate staging worktree. The target must be clean. Supply a verification command to check more than Git mergeability.

Failed verification leaves the target unchanged and keeps the worktree for repair. Successful integration also retains the worktree until explicit cleanup. External Git writers must still coordinate.

For runnable commands and library examples, see [CLI and library workflows](docs/usage.md).

## Project status

The suite exercises process contention, session ownership, command cancellation and disconnects, generated hooks, MCP workflows, and worktree integration. Clean-package checks install the built distribution in a separate consumer project. Native-client reports include exact versions and outcomes.

The CI badge links to current hosted results; local tests and recorded native runs do not establish that every platform or client release passes. Known gaps include common-repository discovery, supported glob grammar, conservative source parsing, and recovery tooling.

- [Reliability contract](docs/reliability.md): behavior, boundaries, and recovery
- [Architecture](docs/architecture.md): storage, adapters, and Git integration
- [Roadmap](docs/roadmap.md): priorities and completion gates
- [Changelog](CHANGELOG.md): behavior changes and migration notes

## Contributing

The most useful contributions reproduce a concrete failure or improve a real multi-agent workflow. Include a disposable fixture, expected behavior, and a way to verify the change. Start with [contributor setup and entry points](CONTRIBUTING.md).

For bugs, use the [bug report form](https://github.com/connorhriley/kith/issues/new?template=bug_report.yml). For a proposed workflow, use the [feature request form](https://github.com/connorhriley/kith/issues/new?template=feature_request.yml). Keep tokens, source snapshots, and `.coord` state out of public diagnostics; use the [security reporting guidance](SECURITY.md) for sensitive reports.

[MIT licensed](LICENSE). Participation follows the [community expectations](CODE_OF_CONDUCT.md).
