<p align="center">
  <img src="assets/brand/readme-header.png" alt="Kith — Parallel agents. Shared direction. Local coordination for coding agents." width="100%">
</p>

<p align="center">
  <a href="https://github.com/connorhriley/kith/actions/workflows/ci.yml"><img src="https://github.com/connorhriley/kith/actions/workflows/ci.yml/badge.svg" alt="CI status"></a>
  <a href="https://github.com/connorhriley/kith/actions/workflows/windows.yml"><img src="https://github.com/connorhriley/kith/actions/workflows/windows.yml/badge.svg" alt="Windows validation"></a>
  <a href="https://www.npmjs.com/package/kith-coord"><img src="https://img.shields.io/npm/v/kith-coord" alt="npm version"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-22C55E" alt="MIT license"></a>
</p>

<p align="center">
  <a href="#quick-start">Quick start</a> · <a href="https://marketplace.visualstudio.com/items?itemName=kith-coord.kith">VS Code</a> · <a href="https://open-vsx.org/extension/kith-coord/kith">Cursor / Open VSX</a> · <a href="#see-it-work">Demo</a> · <a href="docs/integrations.md">Integrations</a> · <a href="docs/usage.md">CLI &amp; API</a> · <a href="CONTRIBUTING.md">Contribute</a>
</p>

**Local coordination for cooperating coding agents.**

Claim work, isolate changes with Git worktrees, share local resources, and verify integration—without a hosted service.

One agent changes an interface while another builds against it. Two agents edit the same file. Separate worktrees still compete for a dev-server port or a package install.

Kith gives cooperating agents shared local state: who owns a task, which files are claimed, and which commands need to wait. Agents use its MCP server; CLI commands support local inspection and maintenance. Coordination lives in SQLite on your machine; Kith itself needs no hosted service or model API key.

## What Kith does

| Need | Kith provides |
| --- | --- |
| Keep tasks from overlapping | Scoped claims with conflict responses |
| Give agents separate working files | Git worktrees with an explicit integration step |
| Check work before integration | Your project's verification command |
| Share local tools | Port reservations and supervised command mutexes |
| See what is happening | Session/task state through CLI/MCP; optional read-only editor and worktree views |

Kith fits workflows where you already launch multiple coding agents and want them to coordinate. It does not choose models, write prompts, or launch a fleet for you. Worktrees separate files; Kith adds shared ownership and resource coordination.

The [reliability contract](docs/reliability.md) defines ownership, verification, recovery and enforcement boundaries. Claims coordinate cooperating clients; hooks do not sandbox filesystem access. Scope matching follows a [documented grammar](docs/path-and-scope-rules.md). Contract-change reports and exact-name reuse hints are advisory.

## Quick start

Requires **Git 2.38+** and **Node.js 22.13+ on 22.x or Node.js 24+**. Full workflows target macOS and Linux. Native Windows MCP checks cover claims, worktrees, ports, integration and recovery; supervised mutex commands and shell hooks require macOS/Linux or WSL. See the [support evidence](docs/client-validation.md#native-windows).

Git recording and integration require a commit identity configured for the repository (`user.name` and `user.email`). Kith does not change your global Git identity.

**Upgrading to 0.1.6:** Stop existing Kith connections first. Back up stopped coordination state (including SQLite sidecars) and retain worktrees; upgrade all coordinators sharing a repository together. This release migrates storage schema 2 to 3, which older binaries refuse. Existing custom launchers are preserved; review their pinned version before reconnecting. See [recovery guidance](docs/reliability.md#recovery).

### VS Code or Cursor

Install **Kith** (`kith-coord.kith`) from the [VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=kith-coord.kith) or [Cursor / Open VSX](https://open-vsx.org/extension/kith-coord/kith). You can also search for `kith-coord.kith` in the editor's Extensions view.

To select release **0.1.6** explicitly with an editor CLI already on your `PATH`:

```sh
code --install-extension kith-coord.kith@0.1.6
cursor --install-extension kith-coord.kith@0.1.6
```

Use the command for your editor. A marketplace lookup can temporarily select an older version; the [extension guide](extensions/editor/README.md#install) also links the published 0.1.6 VSIX.

Open a trusted local Git checkout and approve Kith's MCP server through the editor. The extension bundles the coordination server, detects Node, and preserves existing MCP entries, hooks and tool permissions. **No global npm install is needed.** Each agent still needs to use Kith's tools; installing the extension does not enforce claims on other writers.

Start with a scoped task:

```text
Use Kith to begin an isolated task in this repository with a unique agent ID.
Claim only the files this task needs, edit the returned worktree, and report edits.
Run the project checks and complete through Kith with that verification command.
```

The [extension guide](extensions/editor/README.md) covers settings and existing configurations; [recorded editor checks](docs/client-validation.md#editor-marketplaces-and-signed-in-chats) distinguish installation, native MCP registration and signed-in task results.

### CLI and other MCP clients

Install the release:

```sh
npm install --global kith-coord@0.1.6
```

Choose the setup scope your client needs:

- **Global desktop/CLI connection:** run `kith setup --dry-run`, then `kith setup`. Restart/reconnect the configured client. A desktop agent supplies the absolute Git `repository` on each tool call; no whole-Mac ownership database is created.
- **Project configuration and agent instructions:** run the following inside the checkout. This is the default for project-scoped clients. Existing global connections need not be registered again; use `kith init --only agents` when only project guidance is needed.

```sh
cd /path/to/your/project
kith init --dry-run
kith init
```

Setup preserves peer configurations, hooks and permissions. A written configuration is not a confirmed connection: check Kith's server status in the client, then ask it to begin an isolated task. `kith doctor /absolute/checkout` checks global and project launcher files without starting clients or creating project state. See [client setup](docs/integrations.md#configure-detected-local-clients).

For source installation and the disposable demo, use the pinned **pnpm 10.20.0**:

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

The demo starts **two real MCP clients**, gives each a separate Git worktree in a temporary repository, refuses an overlapping claim, records their edits, runs commands under a mutex, and verifies/integrates both changes. It removes the temporary repository afterward. No model calls or client credentials are needed.

```text
auth: claimed src/auth.mjs in an isolated worktree
billing: overlapping claim on src/auth.mjs refused
billing: claimed src/billing.mjs in an isolated worktree
auth: checked its worktree through the MCP command supervisor
auth: isolated edit reported, verified, and integrated
billing: checked its worktree through the MCP command supervisor
billing: isolated edit reported, verified, and integrated
Two real MCP clients completed work in separate worktrees. Disposable example passed.
```

The implementation is in [examples/two-agents.mjs](examples/two-agents.mjs). This demonstrates the coordination protocol; [native-client validation](docs/client-validation.md) separately exercises installed coding clients.

### Connect your client

After the npm quick start above, restart your coding client in that project and approve its Kith MCP connection. Generated configuration uses the installed `kith` executable; no source checkout or `pnpm link` is needed. Review and commit the generated files before asking agents to integrate work.

Default setup installs MCP configuration for Claude, Codex and Cursor plus agent instructions, without adding hooks or package-manager shims. Review and commit the generated configuration before starting work; integration requires a clean target checkout. Restart your client with `kith` on its `PATH`. To select clients, use `--mcp-only --only claude,codex,agents`. Existing hooks are preserved; review warnings if they require an inherited session. See [hook setup](docs/integrations.md) if you need them.

| Client | Setup and validation |
| --- | --- |
| VS Code | Marketplace extension; signed-in Copilot parallel task completed on VS Code 1.143.0 |
| Cursor | Marketplace extension and native MCP registration checked on 3.24.18; signed-in task's final retry pending after client usage limit; native CLI workflow separately validated |
| Claude Code | MCP; optional edit hooks need shared session setup; recorded native CLI runs |
| Codex | Project MCP configuration; recorded native CLI runs with configuration overrides |
| Other MCP clients | stdio server via `kith mcp`; client-specific validation required |

The [editor extension](extensions/editor/README.md) offers a bundled MCP server and a small read-only status indicator. Existing custom Kith entries take precedence, so review their launcher if a connection fails. The editor retains control of server approval and tool permissions.

Native checks are version-specific; the recorded GUI task used published extension 0.1.4. Later client or extension releases need their own checks. See [integration setup](docs/integrations.md), [recorded validation](docs/client-validation.md), and [session ownership](docs/sessions-and-mutexes.md) before mixing hooks, CLI commands, and MCP clients.

The npm package is **`kith-coord`**, with the command name **`kith`**. For a pinned npx MCP launcher, see [registry setup](docs/integrations.md#registry-installation). The unrelated npm package `kith` is not this project.

## Dev servers and shared config

In version 0.1.4, `kith dev` runs a server with its allocated `PORT` and supports explicit `{port}` arguments. File claims also accept an optional bounded wait:

```sh
kith dev --agent web-a -- npm run dev -- --port '{port}'
# Within an existing owned session:
kith lock acquire --agent worker-1 --scope package.json --wait --wait-ms 30000
```

See [dev-server launch and waiting claims](docs/usage.md#launch-a-dev-server-on-its-allocated-port) for framework flags, session setup, cancellation, and MCP usage.

## Optional read-only monitoring

```sh
kith watch /path/to/workspace --once --json
kith menubar /path/to/workspace  # macOS 12+, Intel or Apple Silicon
```

The watcher compares uncommitted paths across linked worktrees of each repository; a workspace directory can contain several repositories. The editor and macOS menu show paths to review, checkout details and recorded active versus retained sessions. Retained work may still be unfinished: keep it until reviewed.

These are observations, not proof of a merge conflict or the identity of a process writing a file. Unavailable scans stay unavailable. Claims, resource coordination and verified integration remain the MCP/CLI workflow. See [observation limits](docs/usage.md#optional-read-only-worktree-observations).

## How a task moves through Kith

1. **Begin through MCP.** Call `kith_begin_work` with a unique `agentId`, explicit `scopeGlobs`, and `isolateWorktree: true`. The connection retains session ownership; no shell exports are needed for this MCP-only workflow.
2. **Claim a scope.** Cooperating clients receive a conflict when an exclusive claim overlaps another claim.
3. **Do the work.** Edit the returned `worktree.worktreePath`, report edits with `kith_record_file_edit`, and use `kith_run_with_mutex` for serialized commands. Heartbeat before expiry and keep the owning connection open.
4. **Verify and complete.** For a worktree, Kith checkpoints changes and integrates through a separate staging worktree. The target must be clean. Supply a verification command to check more than Git mergeability.

Failed verification leaves the target unchanged and keeps the worktree for repair. Successful integration also retains the worktree until explicit cleanup. External Git writers must still coordinate.

Inspect through `kith_get_status` or `kith status`: worktree paths/branches, dirty-file overlap, ahead/behind, heartbeat/commit age and FIFO waiters are included. Use `kith_preview_integrate` for committed-tree conflict paths before completing. Normal status may reap expired owners. For non-mutating recovery inspection use:

```sh
kith status --offline
kith recover
kith doctor
```

Optional Claude/Cursor hooks support `--enforcement block` (default), `warn` and `off`; see [setup and safe uninstall](docs/integrations.md). The [versioned protocol](docs/protocol.md) records the tool schemas and ownership semantics.

For MCP, CLI and library examples, see [workflows](docs/usage.md).

## Project status

The suite exercises process contention, session ownership, command cancellation and disconnects, generated hooks, MCP workflows, and worktree integration. Clean-package checks install the built distribution in a separate consumer project. Native-client reports include exact versions and outcomes.

The CI badge links to current hosted results; local tests and recorded native runs do not establish that every platform or client release passes. Repository discovery, physical path checks, exact supported glob matching and Git conflict refusal have dedicated regressions. Recovery checks cover interrupted upgrades, stopped database/WAL backups and retained worktree continuation. The [reliability contract](docs/reliability.md) records the boundaries of those scenarios; native-client coverage is listed above.

- [Reliability contract](docs/reliability.md): behavior, boundaries, and recovery
- [Architecture](docs/architecture.md): storage, adapters, and Git integration
- [Roadmap](docs/roadmap.md): priorities and completion gates
- [Changelog](CHANGELOG.md): behavior changes and migration notes

## Contributing

The most useful contributions reproduce a concrete failure or improve a real multi-agent workflow. Include a disposable fixture, expected behavior, and a way to verify the change. Start with [contributor setup and entry points](CONTRIBUTING.md).

For bugs, use the [bug report form](https://github.com/connorhriley/kith/issues/new?template=bug_report.yml). For a proposed workflow, use the [feature request form](https://github.com/connorhriley/kith/issues/new?template=feature_request.yml). Keep tokens, source snapshots, and `.coord` state out of public diagnostics; use the [security reporting guidance](SECURITY.md) for sensitive reports.

[MIT licensed](LICENSE). Participation follows the [community expectations](CODE_OF_CONDUCT.md).
