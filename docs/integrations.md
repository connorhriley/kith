# Client integrations

Build and link the checkout first. Generated configurations use the `kith` executable already on PATH; they do not download an unverified package at hook execution time.

| Selection | Files and behavior |
| --- | --- |
| `claude` | Merges Kith into `.mcp.json` and appends PreToolUse/PostToolUse command hooks in `.claude/settings.json` |
| `codex` | Appends a Kith MCP table to `.codex/config.toml`, forwarding session environment names; preserves existing TOML and custom Kith servers |
| `cursor` | Merges the Kith MCP server into `.cursor/mcp.json` |
| `agents` | Updates only the marked Kith block in AGENTS.md and creates a generic `.agent/skills/kith/SKILL.md` |
| `git` | Installs a pre-commit hook only when one does not exist; uses an in-repository Git hooks path and skips external hooks directories |
| `shims` | Creates optional `.coord/bin/npm`, `pnpm`, and `yarn` wrappers |

Preview with `kith init --dry-run --only claude,agents`. Review generated files and restart the client. Existing integrations may need manual migration if they were created by the initial prototype.

Before launching a hook client, run `eval "$(kith session start --agent <id> --owner-pid "$$" --shell)"`. The client, its MCP process, and hooks must inherit both `KITH_AGENT_ID` and `KITH_SESSION_TOKEN`. Use that same agent ID in MCP calls. A missing/forged/expired token blocks hook mutations. See [session setup](sessions-and-mutexes.md). When a client cannot run tool hooks, use the MCP APIs and isolated worktrees; AGENTS.md guidance alone cannot enforce writes.

Shims are inactive until `.coord/bin` is prepended to PATH. Use an absolute path, for example `export PATH="$PWD/.coord/bin:$PATH"` at the repository root. Wrappers remove that directory from PATH before invoking the real package manager, avoiding recursive self-invocation. They serialize selected install/add/remove commands through the resource broker; leases renew while commands run, and FIFO tickets persist across releases. Protected work must remain in the supervised command group.

Automated end-to-end tests launch real MCP SDK clients over stdio and execute generated hook commands, including worktree edits, Git hooks, verification, completion, and disconnect handling. The runnable `pnpm demo` covers two independent clients integrating separate worktrees. These validate the protocol and adapter boundary; native client versions must also pass the opt-in [client validation runner](client-validation.md). GUI behavior and other releases still need separate checks. Follow [Claude's hook reference](https://code.claude.com/docs/en/hooks) and [MCP guide](https://code.claude.com/docs/en/mcp) when adapting the generated configuration.

Codex reads project settings only for trusted projects. Review `.codex/config.toml` and trust the repository through Codex before connecting. Approve Kith tools in your client as needed; unattended Codex rejects tools requiring approval even when its process exits zero. Generated settings preserve the client approval policy. Existing custom Kith TOML tables are preserved with a warning when capability forwarding needs review.

Generated Claude pre-hooks use `onFailure: "block"` so a missing executable, timeout or abnormal hook exit cannot silently permit an edit on clients supporting this field. Run init again to upgrade prior generated hooks. Validate your installed client version before relying on hook failure handling.
