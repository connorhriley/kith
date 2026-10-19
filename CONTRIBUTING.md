# Contributing to Kith

Kith coordinates other people's uncommitted work. Preserving that work comes before convenience, automatic recovery, or speed claims.

## Development

Use Node.js 22.13+ (22.x) or 24+, Git 2.38+, and the pnpm version pinned in package.json.

```sh
corepack enable
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
pnpm test:package
```

`pnpm test` builds first because subprocess tests exercise the distributed JavaScript. Run `pnpm test -- tests/reliability.test.ts` for focused work. Test files run sequentially to avoid multiplying lifecycle timing workloads on constrained CI hosts; concurrency is exercised explicitly inside the tests. The 50-process test deliberately uses OS processes and a start barrier; do not replace it with synchronous callbacks wrapped in Promise.all.

Run `pnpm demo` for a disposable two-MCP-client/worktree workflow. Ownership and supervision tests use real process identities, signals, expiry and client disconnects; keep those paths covered when changing lifecycle behavior.

## Where to start

| Area | Start here | Useful contribution |
| --- | --- | --- |
| Client integration | `src/cli/init.ts`, `src/cli/hook-handler.ts`, `src/mcp/server.ts` | A minimal fixture for an actual client payload or setup failure |
| Ownership and lifecycle | `src/core/fencing.ts`, `src/core/broker.ts` | A reproducible stale-owner, cancellation, or disconnect edge case |
| Git isolation | `src/core/worktree-cow.ts`, `src/core/merge-train.ts` | A fixture showing preserved work after a failed operation |
| Source analysis | `src/core/ast-analyzer.ts`, `src/core/dep-graph.ts`, `src/core/dedup.ts` | A small syntax example that produces a false positive or missed hint |
| First-run experience | `README.md`, `docs/integrations.md`, `examples/two-agents.mjs` | Reproduce the setup from a clean checkout and clarify a concrete stumbling block |

For a first contribution, prefer a small reproduction or documentation correction over changes to locking or recovery semantics. Discuss a larger change in an issue before implementation. The [roadmap](docs/roadmap.md) lists the acceptance gates for broader work.

## Proposing changes

Open a focused issue or pull request describing the concrete problem, current behavior, desired behavior, and a reproducible example. For bugs, include OS, Node/Git versions, relevant commands, and redacted diagnostics. Never attach secrets or an entire `.coord` directory.

Keep pull requests small enough to review. Add regression coverage for data loss, races, lifecycle changes, public API changes, and failure paths. Tests should assert outcomes, such as unchanged bytes or unique owners, rather than mirror implementation details. Include an upgrade note when changing generated client configuration or library behavior.

Use `git diff --check` and `pnpm check` before submission. A reviewer should be able to understand the change without the authoring chat. Do not claim a latency, security property, or compatibility guarantee without reproducible evidence.

## Extension points

The public entrypoint is `src/index.ts`. `KithEngine` assembles storage, agent lifecycle, locks, tasks, source analysis, Git operations, and the resource broker. Client adapters should call those components rather than write SQLite rows directly. Keep client-specific behavior in the CLI/MCP layers. See [architecture](docs/architecture.md) and [roadmap](docs/roadmap.md).

`pnpm test:package` builds and packs the distribution, installs it in an empty consumer project, and checks the CLI, packaged supervised worker, and library API. It needs registry access for runtime dependencies.

Native client checks are opt-in: see [client validation](docs/client-validation.md). They require installed authenticated clients and consume model usage. CI uses no model credentials. Establish monitored security contacts before public launch or configuring a release workflow.
