# Install

Kith needs **Git 2.38+** and **Node.js 22.13+ on 22.x, or Node.js 24+**. Full workflows target macOS and Linux. Native Windows MCP checks cover claims, worktrees, ports, integration and recovery; supervised mutex commands and shell hooks require macOS/Linux or WSL. See the [support evidence](client-validation.md#native-windows).

Git recording and integration require a commit identity configured for the repository (`user.name` and `user.email`). Kith does not change your global Git identity.

## Which to use

| You want | Use |
| --- | --- |
| Claude Code only | The [Claude Code plugin](#claude-code-plugin). No global npm install. |
| Cursor, Codex, Claude Desktop, or the macOS menu bar | `npm i -g kith-coord && kith install` |
| Both | Keep both. The plugin hooks exit when `kith install` or `kith init` has already registered that Claude hook, so the tool call is checked once. `kith doctor` reports this and does not fail. |

`kith install` pins a runtime outside the npx cache. The plugin resolves `kith-coord` through `npx -y` on each hook and MCP start. The first call can be slower while npx fetches the package. Prefer `kith install` when you want that pin, Cursor hooks, or Radar.

## Claude Code plugin

In Claude Code:

```text
/plugin marketplace add connorhriley/kith
/plugin install kith@kith
```

The same steps from a shell:

```sh
claude plugin marketplace add connorhriley/kith
claude plugin install kith@kith
```

The marketplace file is [`.claude-plugin/marketplace.json`](../.claude-plugin/marketplace.json). The plugin is [`plugins/kith`](../plugins/kith): [`.claude-plugin/plugin.json`](../plugins/kith/.claude-plugin/plugin.json), [`hooks/hooks.json`](../plugins/kith/hooks/hooks.json), and [`.mcp.json`](../plugins/kith/.mcp.json). Hooks and the MCP server run the published package:

```text
npx -y kith-coord hook pre --client claude --auto
npx -y kith-coord mcp --compact
```

`hooks/run.mjs` is the hook command Claude Code actually starts. It forwards stdin to that `npx` command. If `~/.claude/settings.json`, or the project `.claude/settings.json` for `CLAUDE_PROJECT_DIR`, already contains the matching `kith hook` command, the script exits 0 and does not start a second check. PreToolUse uses `onFailure: "block"`, matching `kith install`.

The plugin does not write `~/.claude/settings.json`, does not install Cursor hooks, and does not register the menu bar. Uninstall it from Claude Code's `/plugin` list. That does not remove hooks written by `kith install`; `kith uninstall` does.

The version field is omitted from the manifest, so a GitHub marketplace install tracks the commit Claude Code last fetched. The hook script still runs whatever `npx -y kith-coord` resolves, which is the current published package, not the git checkout.

## `kith install`

```sh
npm i -g kith-coord && kith install
```

`kith install` puts `kith` on your `PATH` and keeps that runtime outside the npx cache. It writes a global MCP entry for each detected client, using the compact tool profile (`kith mcp --compact`), and installs silent-solo `--auto` hooks for Claude Code and Cursor. One agent stays at **Watching only** and does not write coordination state. When another writer overlaps, the hooks join Kith and isolate that work into a worktree or a claim. On macOS it also loads a login LaunchAgent (`dev.kith.radar`) unless you pass `--no-autostart` or `--no-radar`. It does not claim any files. An agent claims when it starts a task.

Codex CLI has no native tool hooks, so it uses the MCP tools. Linux and Windows skip the menu bar; use `kith watch`.

Directories that scan a repository for an MCP server read the committed [`.mcp.json`](../.mcp.json): `npx -y kith-coord mcp` over stdio. That entry does not pin a checkout and does not install hooks. `kith install` does not read or edit it.

### Upgrading

Stop existing Kith connections first. Back up stopped coordination state (including SQLite sidecars) and retain worktrees; upgrade all coordinators sharing a repository together. The storage schema stays 3 and the protocol stays 1.6.0. Databases already on schema 3 open without a version migration. The first open on 0.1.8 or later creates an optional `handoffs` table; binaries from 0.1.6 and 0.1.7 ignore that table and keep working, but they do not read or write handoff notes. An upgrade from schema 2 still applies the 0.1.6 migration to schema 3, which older binaries refuse. After upgrading, run `kith install` so hooks and client entries use this runtime. `kith doctor` reports a hook or MCP entry still pinned to an older runtime. Existing custom launchers are preserved; review their pinned version before reconnecting. On macOS, `kith install` and `kith setup` register a login LaunchAgent unless `--no-autostart` or `--no-radar` is passed. See [recovery guidance](reliability.md#recovery).

### VS Code or Cursor

Install **Kith** (`kith-coord.kith`) from the [VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=kith-coord.kith) or [Cursor / Open VSX](https://open-vsx.org/extension/kith-coord/kith). You can also search for `kith-coord.kith` in the editor's Extensions view.

To select release **0.1.9** explicitly with an editor CLI already on your `PATH`:

```sh
code --install-extension kith-coord.kith@0.1.9
cursor --install-extension kith-coord.kith@0.1.9
```

Use the command for your editor. A marketplace lookup can temporarily select an older version; the [extension guide](../extensions/editor/README.md#install) also links the published 0.1.9 VSIX.

Open a trusted local Git checkout and approve Kith's MCP server through the editor. The extension bundles the coordination server, detects Node, and preserves existing MCP entries, hooks and tool permissions. **No global npm install is needed.** It registers the compact tool profile (`kith.mcp.profile`, `compact` by default, or `full`), shows a read-only global hook status note in Output, and adds **Kith: Install Global Hooks & Autostart** (`kith.installGlobal`). The bundled extension does not include the macOS menu-bar helper; run `kith install` from the CLI on macOS for Radar login autostart. Each agent still needs to use Kith's tools; installing the extension alone does not enforce claims on other writers.

Start with a scoped task:

```text
Use Kith to begin an isolated task in this repository with a unique agent ID.
Claim only the files this task needs, edit the returned worktree, and report edits.
Run the project checks and complete through Kith with that verification command.
```

The [extension guide](../extensions/editor/README.md) covers settings and existing configurations; [recorded editor checks](client-validation.md#editor-marketplaces-and-signed-in-chats) distinguish installation, native MCP registration and signed-in task results.

### CLI and other MCP clients

Configure detected clients and add project instructions with:

```sh
npx --yes --package kith-coord@0.1.9 kith setup
```

**`kith install`** is the one-command onboarding path. `kith setup` remains a compatible alias:

- Configures global MCP servers with the concise **`--compact`** tool profile by default (`kith mcp --compact`, or `--full` for the complete surface).
- Installs global silent-solo `--auto` hooks for **Claude Code** (`~/.claude/settings.json`) and **Cursor** (`~/.cursor/hooks.json`). Solo work stays zero-write (`Watching only`); when concurrent activity overlaps, hooks auto-join Kith and isolate writers into worktrees or leases.
- On **macOS**, installs and starts a login `LaunchAgent` (`dev.kith.radar`) for background menu-bar Radar, and opens the read-only view. `--no-autostart` or `--no-radar` skips the login item. Repeat setup keeps the existing workspace.
- **`kith uninstall`** removes the macOS `LaunchAgent`, global Kith hooks, global MCP entries, retained runtimes and launcher symlinks.

Note the platform and client boundaries: **Codex CLI** does not expose native pre/post tool hooks, so it coordinates through `--compact` MCP tools and Radar/watcher observations rather than automatic hook interception. **Linux and Windows** skip macOS menu-bar autostart and use `kith watch` for passive supervision.

Durable setup starts with **0.1.7** (retaining an exact self-contained runtime outside npx's cache, verifying MCP discovery, and backing up modified files). Existing custom Kith launchers, peer servers, hooks and permissions are preserved. Reconnect the client and approve its MCP server through the client's normal controls.

Day to day, run `kith` (a read-only status overview in a terminal), `kith status`, `kith brief`, `kith run`, `kith gc`, `kith doctor [path]`, or `kith help --all`. The view says **Watching only** until a task or concurrent overlap is recorded. `kith install --dry-run` and `kith setup --dry-run` preview without writes.

[`.mcp.json`](../.mcp.json) is the directory discovery entry: `npx -y kith-coord mcp`. It is not a pin to this repository. `kith install` does not read or edit it, and `kith doctor` only reports that the launcher file is present; neither command starts the server or creates `.coord` state. A client that loads project MCP config, such as Claude Code, can start that published package from the file. Because `--repo` is omitted, the process does not pin this checkout or open the database until a tool call names one. `kith init` still replaces the `kith` server in a project `.mcp.json` with a launcher for the machine you are on; do not commit that rewrite over the discovery entry.

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

The implementation is in [examples/two-agents.mjs](../examples/two-agents.mjs). This demonstrates the coordination protocol; [native-client validation](client-validation.md) separately exercises installed coding clients.

### Client support

The editor extension bundles the server and offers it through native MCP registration; no global npm install is needed. Installing an extension or writing MCP configuration alone does not enforce claims on writers that do not call Kith tools unless global `--auto` hooks are installed for that client. Existing custom Kith entries retain precedence.

| Client | Setup and behaviour |
| --- | --- |
| VS Code / Cursor | Marketplace extension with `kith.mcp.profile` set to `compact` by default; **Kith: Install Global Hooks & Autostart** runs `kith install` |
| Claude Code | Plugin (`kith@kith`), or `kith install` / `kith setup` with silent-solo `--auto` hooks. The plugin defers when the install hooks are present |
| Cursor | Detected client configuration through `kith install` or `kith setup`; silent-solo `--auto` hooks join when work overlaps |
| Codex CLI | Detected global MCP configuration (`--compact` by default). Codex CLI has no native tool hooks, so coordination uses MCP tools and Radar or `kith watch` |
| Claude Desktop | Detected MCP configuration via `kith install` / `kith setup` |
| Other MCP clients | stdio server via `kith mcp` (`--compact` or `--full`); client-specific validation required |

Native evidence is version-specific. See [client validation](client-validation.md), [advanced integration setup](integrations.md) and [session ownership](sessions-and-mutexes.md). The npm package is **`kith-coord`** and the command is **`kith`**; the unrelated npm package `kith` is not this project.

## Dev servers and shared config

`kith dev` runs a server with its allocated `PORT` and supports explicit `{port}` arguments. It scans from 3000 unless `--base` is set. `kith port` scans from 3100. File claims also accept an optional bounded wait:

```sh
kith dev --agent web-a -- npm run dev -- --port '{port}'
# Within an existing owned session:
kith lock acquire --agent worker-1 --scope package.json --wait --wait-ms 30000
```

See [dev-server launch and waiting claims](usage.md#launch-a-dev-server-on-its-allocated-port) for framework flags, session setup, cancellation, and MCP usage.

## Read-only Radar

From 0.1.8, macOS `kith install` and `kith setup` load a `LaunchAgent` (`dev.kith.radar`) so menu-bar Radar runs in the background and restarts across logins for the selected checkout or workspace. It uses the retained installation, so clearing the npx cache does not break it. Repeat runs keep an existing Radar workspace selected. Use **Switch Workspace** in its menu to change it.

`kith install --no-autostart` (or `--no-radar`) configures MCP and hooks without loading the macOS login agent (useful on headless machines); `--dry-run` never writes or launches anything. Linux and Windows skip the macOS menu-bar app and `LaunchAgent`, using `kith watch` for passive monitoring instead (external IDE `presence.db` discovery is opt-in via `--include-presence`). Remove the login item anytime with `kith uninstall`, or inspect manually with:

```sh
kith watch /path/to/workspace --once --json
kith menubar /path/to/workspace  # macOS 12+, Intel or Apple Silicon
```

The menu and editor lead with recorded tasks, current file claims, shared-resource waits and integrations that need inspection. A registered session without a task is shown separately. Saved checkouts and path comparisons stay in details; nothing is automatically deleted. The menu's default view omits the file-timestamp feed.

**Watching only** means no active Kith task is recorded. Shared dirty paths are files to review before integration, not a proven merge conflict. **Status unavailable** remains explicit when state cannot be inspected safely. Reads use private snapshots without renewing owners or migrating the original database. See [observation limits](usage.md#optional-read-only-worktree-observations).
