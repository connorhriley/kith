# Client integrations

Build and link the checkout first. Generated configurations use the `kith` executable already on PATH; they do not download an unverified package at hook execution time.

| Selection | Files and behavior |
| --- | --- |
| `claude` | Merges Kith into `.mcp.json`; adds Claude edit hooks unless `--mcp-only` is supplied |
| `codex` | Appends a Kith MCP table to `.codex/config.toml`, forwarding session environment names; preserves existing TOML and custom Kith servers |
| `cursor` | Merges the Kith MCP server into `.cursor/mcp.json` |
| `agents` | Updates only the marked Kith block in AGENTS.md and creates a generic `.agent/skills/kith/SKILL.md` |
| `git` | Installs a pre-commit hook only when one does not exist; uses an in-repository Git hooks path and skips external hooks directories |
| `shims` | Creates optional `.coord/bin/npm`, `pnpm`, and `yarn` wrappers |

## Start with MCP

```sh
kith init --mcp-only --dry-run --only claude,codex,agents
kith init --mcp-only --only claude,codex,agents
```

Choose only the clients you use. Review and commit setup files, then restart the client. Begin with `kith_begin_work` and `isolateWorktree: true`; edit the returned worktree, report files through `kith_record_file_edit`, run commands with `kith_run_with_mutex`, and complete with a project verification command. The MCP connection retains its capability without shell exports. Keep that connection alive and heartbeat before expiry. See [runnable workflows](usage.md).

`--mcp-only` selects client configurations and agent instructions; it does not install Claude edit hooks, Git hooks or shims. It never removes existing hooks. If Claude tool hooks already exist, init warns to review their session requirements. This option cannot be combined with `--only git` or `shims`. Existing integrations may need manual migration if created by the initial prototype.

## Optional hooks and CLI sharing

Omit `--mcp-only` to add Claude edit hooks, for example `kith init --only claude,agents`. Preview with `--dry-run` first.

Before launching a hook client, run `eval "$(kith session start --agent <id> --owner-pid "$$" --shell)"`. The client, its MCP process, and hooks must inherit both `KITH_AGENT_ID` and `KITH_SESSION_TOKEN`. Use that same agent ID in MCP calls. A missing/forged/expired token blocks hook mutations. See [session setup](sessions-and-mutexes.md). Separate stateless shell calls cannot retain this setup. Prefer MCP and isolated worktrees when a persistent launcher environment is unavailable; AGENTS.md guidance alone cannot enforce writes.

Shims are inactive until `.coord/bin` is prepended to PATH. Use an absolute path, for example `export PATH="$PWD/.coord/bin:$PATH"` at the repository root. Wrappers remove that directory from PATH before invoking the real package manager, avoiding recursive self-invocation. They serialize selected install/add/remove commands through the resource broker; leases renew while commands run, and FIFO tickets persist across releases. Protected work must remain in the supervised command group.

Automated end-to-end tests launch real MCP SDK clients over stdio and execute generated hook commands, including worktree edits, Git hooks, verification, completion, and disconnect handling. The runnable `pnpm demo` covers two independent clients integrating separate worktrees. These validate the protocol and adapter boundary; native client versions must also pass the opt-in [client validation runner](client-validation.md). GUI behavior and other releases still need separate checks. Follow [Claude's hook reference](https://code.claude.com/docs/en/hooks) and [MCP guide](https://code.claude.com/docs/en/mcp) when adapting the generated configuration.

Codex reads project settings only for trusted projects. Review `.codex/config.toml` and trust the repository through Codex before connecting. Approve Kith tools in your client as needed; unattended Codex rejects tools requiring approval even when its process exits zero. Generated settings preserve the client approval policy. Existing custom Kith TOML tables are preserved with a warning when capability forwarding needs review.

Generated Claude pre-hooks use `onFailure: "block"` so a missing executable, timeout or abnormal hook exit cannot silently permit an edit on clients supporting this field. Run init again to upgrade prior generated hooks. Validate your installed client version before relying on hook failure handling.
