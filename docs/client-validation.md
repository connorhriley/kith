# Native client validation

Protocol tests and the two-client demo exercise the MCP SDK. Native validation additionally launches an installed agent client, lets its model use real MCP tools and its native editor, and checks the resulting repository state. It is opt-in because it needs a logged-in client or provider credentials and consumes model usage.

```sh
pnpm install --frozen-lockfile
pnpm build
node scripts/validate-native-clients.mjs --client codex --output artifacts/codex.json
node scripts/validate-native-clients.mjs --client claude --output artifacts/claude.json
node scripts/validate-native-clients.mjs --client cursor --output artifacts/cursor.json
```

Use `--scenario isolated` or `--scenario shared` for a single run. Claude and Cursor also run `--scenario hook-failure` by default, replacing the pre-hook executable with a missing path and proving that a native edit is denied. Both worktree modes integrate an isolated worktree. The isolated scenario gives Codex an MCP-owned session; shared mode forwards a capability anchored to the runner. Claude and Cursor always inherit a session so its generated edit hooks and MCP server share ownership.

Each run uses a disposable Git repository with spaces and an apostrophe in its path. A peer holds a source file. The native client must receive the conflict (Claude and Cursor also attempt a native edit that their pre-hook must deny), choose a separate scope, edit its returned worktree, report the edit, run a supervised MCP command across multiple lease periods, encounter an expected verification failure, inspect retained ownership, retry completion successfully, and release ownership. The runner checks native tool events, exact protected/integrated bytes, contracts, task completion, verification diagnostics, Git HEAD and remaining locks. An exit-zero client that merely reports a permission failure fails validation. Results are version-specific evidence, not certification of every client release or GUI.

The Codex invocation ignores user configuration/rules, uses a workspace-write sandbox, passes the generated TOML server values as invocation overrides, and approves only that fixture's Kith MCP tools for unattended execution. It does not test persisted project trust or GUI discovery; review and trust project settings in your normal client before use. Normal `kith init --only codex` does not change approval policy or mark a real project trusted. Claude loads project settings, restricts MCP to the generated config, permits its native editor and Kith tools, denies unattended permission prompts, and uses a $2 per-scenario budget. Cursor uses its installed `agent` executable (override with `--binary /absolute/path`), generated project MCP/hook settings, fixture trust, automatic MCP approval and its enabled sandbox. It uses your existing Cursor login/default model and can consume Cursor usage; no price cap is available in this runner. The CLI can record trust/session metadata for the disposable fixture. The runner has a three-minute deadline and bounded output, does not log in or edit global client settings directly, and never requests subagents. Model-driven runs currently require macOS/Linux process groups for bounded cleanup.

Reports contain client/version, platform, scenario outcomes and tool names. Raw MCP results include bearer capabilities and must not be published. No raw transcript is saved by default. Keep credentials out of repository settings; generated Codex config forwards environment variable names with `env_vars`.

## Hosted checks

The `CI` workflow runs independently on Linux/macOS with Node 22.13.0, current 22 and 24. Each job checks types, process/lifecycle and MCP tests, an installed package consumer, and the two-client worktree demo. JUnit reports are retained even when a test fails. It also supports manual dispatch. Hosted CI does not run paid models or require agent credentials. Run native clients separately after adapter changes and record their exact versions and outcomes here or in the pull request.

## Recorded native runs

On 2026-10-19, macOS / Node 22.23.3: [Codex CLI 0.163.0-alpha.10.2](validation/2026-10-19-codex-client-report.json) passed MCP-owned and inherited-owner scenarios; [Claude Code 2.1.301](validation/2026-10-19-claude-client-report.json) passed both worktree flows. An additional [native Claude edit denial](validation/2026-10-19-claude-hook-report.json) confirmed that a peer-owned file edit was blocked before a valid task completed. These are recorded outcomes on these versions, with the configuration delivery limits described above.

The separate [missing guard check](validation/2026-10-19-claude-hook-unavailable-report.json) also passed: a native Write attempted once was denied and the marker file remained absent. This case is included in the reusable runner.

The native shell check found a concrete macOS Codex failure: direct CLI supervision could not inspect its mutex waiter under the command sandbox. The new MCP command adapter preserves process-identity checks. [Codex](validation/2026-10-19-codex-mutex-report.json) and [Claude](validation/2026-10-19-claude-mutex-report.json) subsequently passed the full inherited-session workflow with a 1.2-second command on a 300 ms renewable lease.

Wire-level regression coverage also caught an SDK transport lifecycle gap: stdin EOF did not invoke the server close callback while a command kept the event loop alive. Kith now translates EOF/signals into graceful closure, aborts active commands, waits for their guarded groups to stop, and closes state afterward. A borrowed owner remains active and its mutex becomes available after cleanup.


After the repository/path/scope/merge hardening pass, the isolated workflows passed again on macOS / Node 22.23.3: [Codex](validation/2026-10-19-path-hardening-codex.json) and [Claude](validation/2026-10-19-path-hardening-claude.json). These reruns confirm native editing, conflict handling, contract reports, renewable command supervision, verified integration and release; the existing shared-owner and unavailable-hook reports cover those separate scenarios. Regression tests additionally launch real MCP clients from a Git subdirectory and an existing linked checkout, edit literal `[id]` route paths, and prove the invoking checkout's staged index is guarded.


The recovery pass reran the isolated workflows on macOS / Node 22.23.3: [Codex](validation/2026-10-19-recovery-codex.json) and [Claude](validation/2026-10-19-recovery-claude.json) both passed an intentional verification failure followed by successful completion on the same session and worktree. Separate automated MCP regressions cover staging-only repairs being refused and a killed owner being recovered from a stopped database/WAL backup with a fresh capability and preserved worktree. These checks do not establish arbitrary corruption recovery or GUI behavior.


The 2026-10-20 subtraction pass reran the isolated native workflows on macOS / Node 22.23.3: [Codex CLI 0.163.0-alpha.10.2](validation/2026-10-20-subtraction-codex.json) and [Claude Code 2.1.301](validation/2026-10-20-subtraction-claude.json) both passed edit reporting, renewable commands, failed verification followed by successful retry, integration and ownership release. Claude also verified native peer-edit denial with its inherited owner preserved. These runs use the shared begin/complete implementation after removing fuzzy advice, custom conflict rewriting and the dashboard.


## Cursor adapter coverage

Generated Cursor hooks use the documented native `preToolUse`/`postToolUse` protocol and `failClosed:true`. Subprocess fixtures exercise allow/deny JSON, block/warn/off mode changes, preservation of unrelated hooks, and missing/forged ownership refusal. Native Cursor CLI evidence is recorded below. Cursor GUI discovery/trust and other client versions remain unvalidated; CLI and payload fixtures do not establish those outcomes. The shared Git/worktree and MCP boundaries have separate automated coverage.


The 2026-10-20 adoption pass reran the isolated workflows on macOS / Node 22.23.3: [Codex CLI 0.163.0-alpha.10.2](validation/2026-10-20-adoption-codex.json) and [Claude Code 2.1.301](validation/2026-10-20-adoption-claude.json) passed native editing, renewable mutex execution, failed verification/retry, integration and ownership release. Claude also passed the separate [unavailable-guard denial](validation/2026-10-20-adoption-hook-failure.json).

The [first Codex attempt](validation/2026-10-20-adoption-codex-first-attempt.json) stopped after its mutex call without completing the fixture; the runner correctly marked it failed despite the client exiting zero. Its cause was not established. A diagnostic rerun passed and now records redacted outcome fields without raw tool arguments/results. Keep the incomplete attempt visible: model-driven validation can vary, and one successful rerun does not explain an earlier incomplete workflow.


On 2026-10-20, macOS / Node 22.23.3, [Cursor CLI 2026.10.19-6bbf2c4](validation/2026-10-20-cursor-cli.json) passed the real model workflow with an inherited session: native peer-edit denial, worktree editing, edit reporting, renewable command supervision, failed verification/retry, integration and released claims. A temporary wrapper forwarded the exact generated guard and recorded only path/exit status; native editor events and repository state were also checked. The separate [unavailable-guard check](validation/2026-10-20-cursor-hook-unavailable.json) passed: one native edit attempt was denied and the marker stayed absent. Raw capability-bearing transcripts were not saved.


## Native Windows

Version 0.1.1 has real `windows-latest` SDK/Node/Git workflow evidence on [Node 22.13.0](validation/2026-10-20-windows-node-22.13.0.json) and [Node 24](validation/2026-10-20-windows-node-24.json). These checks use two actual MCP server processes, not path mocks: owned sessions and refused theft/overlap, native and Git-style paths, literal bracket filenames, internal/escaping directory junctions, separate worktrees, port leases, dirty-preview refusal, failed verification/retry, integration, killed-owner recovery with a new capability, unchanged-state offline inspection, generated Node-based MCP startup and conservative uninstall. Git's configured checkout line endings are respected; failed verification must preserve the source's exact existing bytes. The installed package is tested from a fresh npm cache: source pushes use a packed archive, while matching release tags install the exact public registry version. The separate [Windows workflow](../.github/workflows/windows.yml) runs on pushes/PRs and retains redacted JSON; it also checks damaged-state refusal without replacing state or losing work.

This is **partial native Windows support**, included in npm `kith-coord@0.1.1`. `kith_run_with_mutex` refuses before execution or lease/guard acquisition because its cleanup guarantee needs POSIX process groups. Native shell hooks/shims are refused during setup before writes; use `kith init --mcp-only` or WSL for the full workflow. `doctor` reports the platform limitation and exits nonzero. This does not certify a Windows model-driven client or GUI; the native Cursor runs above are on macOS. Windows backup files are flushed before client writes, but Node cannot flush directory entries there, so setup-ledger durability across sudden power loss is not promised.
