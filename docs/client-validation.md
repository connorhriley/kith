# Native client validation

Protocol tests and the two-client demo exercise the MCP SDK. Native validation additionally launches an installed agent client, lets its model use real MCP tools and its native editor, and checks the resulting repository state. It is opt-in because it needs a logged-in client or provider credentials and consumes model usage.

```sh
pnpm install --frozen-lockfile
pnpm build
node scripts/validate-native-clients.mjs --client codex --output artifacts/codex.json
node scripts/validate-native-clients.mjs --client claude --output artifacts/claude.json
```

Use `--scenario isolated` or `--scenario shared` for a single run. Both modes integrate an isolated worktree. The isolated scenario gives Codex an MCP-owned session; shared mode forwards a capability anchored to the runner. Claude always inherits a session so its generated edit hooks and MCP server share ownership.

Each run uses a disposable Git repository with spaces and an apostrophe in its path. A peer holds a source file. The native client must receive the conflict (Claude also attempts a native edit that its pre-hook must deny), choose a separate scope, edit its returned worktree, report the edit, integrate it with verification, and release ownership. The runner checks native tool events, exact protected/integrated bytes, contracts, task completion, verification diagnostics, Git HEAD and remaining locks. An exit-zero client that merely reports a permission failure fails validation. Results are version-specific evidence, not certification of every client release or GUI.

The Codex invocation ignores user configuration/rules, uses a workspace-write sandbox, passes the generated TOML server values as invocation overrides, and approves only that fixture's Kith MCP tools for unattended execution. It does not test persisted project trust or GUI discovery; review and trust project settings in your normal client before use. Normal `kith init --only codex` does not change approval policy or mark a real project trusted. Claude loads project settings, restricts MCP to the generated config, permits its native editor and Kith tools, denies unattended permission prompts, and uses a $2 per-scenario budget. The runner has a three-minute deadline and bounded output. It does not log in, change global configuration, or create subagents.

Reports contain client/version, platform, scenario outcomes and tool names. Raw MCP results include bearer capabilities and must not be published. No raw transcript is saved by default. Keep credentials out of repository settings; generated Codex config forwards environment variable names with `env_vars`.

## Hosted checks

The `CI` workflow runs independently on Linux/macOS with Node 22.13.0, current 22 and 24. Each job checks types, process/lifecycle and MCP tests, an installed package consumer, and the two-client worktree demo. JUnit reports are retained even when a test fails. It also supports manual dispatch. Hosted CI does not run paid models or require agent credentials. Run native clients separately after adapter changes and record their exact versions and outcomes here or in the pull request.

## Recorded native runs

On 2026-10-19, macOS / Node 22.23.3: [Codex CLI 0.163.0-alpha.10.2](validation/2026-10-19-codex-client-report.json) passed MCP-owned and inherited-owner scenarios; [Claude Code 2.1.301](validation/2026-10-19-claude-client-report.json) passed both worktree flows. An additional [native Claude edit denial](validation/2026-10-19-claude-hook-report.json) confirmed that a peer-owned file edit was blocked before a valid task completed. These are recorded outcomes on these versions, with the configuration delivery limits described above.
