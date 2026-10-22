# Client integrations

Install Kith persistently or build and link the checkout first. On macOS/Linux, generated configurations use the `kith` executable already on PATH; they do not download an unverified package at hook execution time.

| Selection | Files and behavior |
| --- | --- |
| `claude` | Merges Kith into `.mcp.json`; adds Claude edit hooks only when selected explicitly with `--only` and without `--mcp-only` |
| `codex` | Appends a Kith MCP table to `.codex/config.toml`, forwarding session environment names; preserves existing TOML and custom Kith servers |
| `cursor` | Merges `.cursor/mcp.json`; adds `.cursor/hooks.json` guards only when selected explicitly without `--mcp-only` |
| `agents` | Updates only the marked Kith block in AGENTS.md and creates a generic `.agent/skills/kith/SKILL.md` |
| `git` | Installs a pre-commit hook only when one does not exist; uses an in-repository Git hooks path and skips external hooks directories |
| `shims` | Creates optional `.coord/bin/npm`, `pnpm`, and `yarn` wrappers |

## Start with MCP

Choose global `kith setup` for an existing desktop/user-wide client connection, or project `kith init` for checkout-scoped configuration and instructions. You do not need to run both for the same client. An existing global connection can use `kith init --only agents` to add just project guidance. Configuration changes do not prove native connection or ownership.

```sh
kith init --dry-run
kith init
```

Default setup configures Claude, Codex, Cursor and agent instructions through MCP. To select clients use `--mcp-only --only claude,codex,agents`. Review and commit setup files, then restart the client. Begin with `kith_begin_work` and `isolateWorktree: true`; edit the returned worktree, report files through `kith_record_file_edit`, run commands with `kith_run_with_mutex`, and complete with a project verification command. The MCP connection retains its capability without shell exports. Keep that connection alive and heartbeat before expiry. See [runnable workflows](usage.md).

Default setup and `--mcp-only` select client configurations and agent instructions; it does not install Claude/Cursor edit hooks, Git hooks or shims. It never removes existing hooks. If tool hooks already exist, init warns to review their session requirements. This option cannot be combined with `--only git` or `shims`. Existing integrations may need manual migration if created by the initial prototype.

## Optional hooks and CLI sharing

Select clients explicitly without `--mcp-only` to add edit hooks, for example `kith init --only claude,cursor,agents`. Add `git` for the optional staged-file guard. Preview with `--dry-run` first.

Before launching a hook client, run `eval "$(kith session start --agent <id> --owner-pid "$$" --shell)"`. The client, its MCP process, and hooks must inherit both `KITH_AGENT_ID` and `KITH_SESSION_TOKEN`. Use that same agent ID in MCP calls. A missing/forged/expired token blocks hook mutations. See [session setup](sessions-and-mutexes.md). Separate stateless shell calls cannot retain this setup. Prefer MCP and isolated worktrees when a persistent launcher environment is unavailable; AGENTS.md guidance alone cannot enforce writes.

Shims are inactive until `.coord/bin` is prepended to PATH. Use an absolute path, for example `export PATH="$PWD/.coord/bin:$PATH"` at the repository root. Wrappers remove that directory from PATH before invoking the real package manager, avoiding recursive self-invocation. They serialize selected install/add/remove commands through the resource broker; leases renew while commands run, and FIFO tickets persist across releases. Protected work must remain in the supervised command group.

Automated end-to-end tests launch real MCP SDK clients over stdio and execute generated hook commands, including worktree edits, Git hooks, verification, completion, and disconnect handling. The runnable `pnpm demo` covers two independent clients integrating separate worktrees. These validate the protocol and adapter boundary; native client versions must also pass the opt-in [client validation runner](client-validation.md). GUI behavior and other releases still need separate checks. Follow [Claude's hook reference](https://code.claude.com/docs/en/hooks) and [MCP guide](https://code.claude.com/docs/en/mcp) when adapting the generated configuration.

Codex reads project settings only for trusted projects. Review `.codex/config.toml` and trust the repository through Codex before connecting. Approve Kith tools in your client as needed; unattended Codex rejects tools requiring approval even when its process exits zero. Generated settings preserve the client approval policy. Existing custom Kith TOML tables are preserved with a warning when capability forwarding needs review.

Generated Claude pre-hooks use `onFailure: "block"` so a missing executable, timeout or abnormal hook exit cannot silently permit an edit on clients supporting this field. Run init again to upgrade prior generated hooks. Validate your installed client version before relying on hook failure handling.


## Enforcement modes

```sh
kith init --only claude,cursor,git,agents --enforcement block --dry-run
kith init --only claude,cursor,git,agents --enforcement block
```

`block` is the default for optional hooks: conflicting native file writes are denied; unclaimed files are claimed before writes. Risky recognized Git commands are refused while they could replace a peer's shared checkout or shared refs. `warn` permits policy conflicts and returns warnings; it never steals the peer's claim or attributes their file to the warning agent. `off` skips claim/risky-command enforcement. All modes still require valid session ownership and contained file paths. This switch affects hooks, not MCP/CLI ownership, locks or integration checks. Rerun init with a different mode to update recognized Kith hooks without duplicating them or deleting unrelated hooks.

Cursor's native `preToolUse`/`postToolUse` adapter handles `Shell`, `Write` and `Delete` matcher payloads, returns Cursor permission/context JSON, and sets `failClosed:true` on pre-hooks. The generated Claude pre-hook uses `onFailure:"block"`. These fields depend on client versions; see [Cursor's hook reference](https://cursor.com/docs/hooks), [Claude's hook reference](https://code.claude.com/docs/en/hooks), and the [validation matrix](client-validation.md). A pattern-based shell guard cannot parse every shell program or prevent bypasses. Worktrees remain the recommended default.

## Diagnose and undo setup

`kith doctor /absolute/checkout` checks Node/Git versions, supported platform, project and global MCP launcher files, recorded session environment, guard failure policy and worktree health. It recognizes global setup before the first task creates project state; a missing database is distinct from damaged state. Missing launcher files and connections pinned to a different checkout require setup review. It does not execute configured hooks, establish project trust, authenticate clients or prove that a supplied token is valid. Native Windows is reported limited: MCP coordination is tested, while supervised mutex commands and shell hooks require macOS/Linux or WSL. A missing/broken check exits nonzero and leaves configuration/state untouched.

Before writing selected client files, init persists private original-byte/mode backups in the shared coordination directory's `setup/` subdirectory. Each checkout has its own ledger. An exclusive `setup.lock` serializes cooperative setup/uninstall. A partial write can leave configuration requiring review; original backups remain available. Stop clients and inspect a stale lock before removing it manually. Never delete the ledger as routine cleanup.

```sh
kith uninstall --dry-run
kith uninstall
```

Uninstall restores the exact original bytes/permissions or deletes files created by tracked setup **only while their contents and permissions still match Kith's recorded write**. Edited files are preserved and listed in `needsReview` (nonzero exit); review/remove their Kith entries manually. State, worktrees, recovery copies and the `.coord/` ignore rule are retained. Empty directories can remain. Files installed by versions predating setup tracking are not guessed at or removed: a later init can record only the state it actually observed. Damaged or redirected backup metadata is refused before configuration restoration. This is reversible configuration cleanup, not a project/worktree deletion command.


## Registry installation

The package is `kith-coord`, and its binary remains `kith`. Install it persistently (`npm install --global kith-coord@0.1.4`) before `kith init`, because generated configurations launch `kith` on PATH. Invoking init through npx alone does not create that persistent executable.

An MCP client can instead use a pinned registry launcher without a global install:

```json
{"mcpServers":{"kith":{"command":"npx","args":["--yes","--package","kith-coord@0.1.4","kith","mcp","--repo","/absolute/checkout"]}}}
```

Use a version you have verified; the unrelated npm package named `kith` is not Kith's distribution. Hook commands still need their configured executable to remain available. The clean-package smoke check exercises the installed binary, library, supervised worker and actual MCP discovery/status in a separate consumer.


## Native Windows setup

Version 0.1.1 generates MCP configuration using the current absolute Node executable and built CLI path, avoiding `.cmd` launcher/shell quoting. Use `kith init --mcp-only` and review the generated paths; rerun setup if the Node/Kith installation moves. Native Windows setup refuses shell hooks and shims before configuration writes. Supervised mutex commands are also refused. Use WSL for those full workflows. The `npx` example above is a POSIX launcher; do not assume a native Windows client can spawn `npx.cmd` directly. See [platform proof and limits](client-validation.md#native-windows).


## Configure detected local clients

`kith setup --dry-run` previews configuration for detected existing clients; omit `--dry-run` to apply it. It works from HOME without creating a project database there. Global Claude Desktop, Claude Code, Codex and Antigravity entries use this installation's Node and CLI paths and can select a different Git repository on each MCP call. No disk-wide scan or shared current-project switch is involved. Clients started inside a Git checkout use that checkout by default. Desktop clients started at `/` or HOME connect without opening a coordinator; their agent supplies an absolute `repository` path for the task.

Run `kith setup /absolute/checkout` inside a project to configure its Cursor entry as well. Project entries and explicit `mcp --repo /absolute/checkout` remain pinned to that checkout. Existing hooks and approval settings are untouched. Custom Kith transports or wrappers that cannot be safely recognized are preserved and reported for manual review, with a nonzero exit. Detection/configuration is not proof that a particular GUI client connected; restart or reconnect that client after setup and check its server status. VS Code is not an automatic setup adapter.

Project configuration uses the existing checkout setup ledger. Global client files use a private `~/.coord/setup/` ledger: `kith uninstall --repo "$HOME" --dry-run` previews restoring those unchanged writes. As with project uninstall, edited files and backups are retained. Configuration already overwritten by older untracked setup cannot be reconstructed; recover an earlier copy manually. All selected configuration is parsed and checked before writes, and backups precede each write. A partial setup can still require manual review; rerunning does not discard recovery material.

Generated launchers use absolute paths from the current installation. Rerun setup after moving Node or Kith. MCP connections retain capabilities as usual; setup neither creates a session nor changes ownership rules.
