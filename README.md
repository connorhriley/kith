# Kith (`kith`)

**Zero-trust parallel agent coordination engine.**
Prevent concurrent AI coding agents (**Claude Code**, **Antigravity**, **Codex CLI**, **Cursor**) from duplicating work, colliding on files, drifting on shared contracts, or thrashing local ports and toolchains.

---

## Why Kith?

Running parallel coding agents on the same repository fails in predictable ways:
1. **Prompt instructions get ignored:** Agents forget to check markdown handoff files or run bash scripts (`sed`, `python`, `git checkout`) that overwrite sibling agents' uncommitted work.
2. **Duplicate utilities & overlapping work:** Two agents both notice a missing helper (`formatCurrency` vs `formatMoney`) and implement incompatible versions in different files.
3. **Silent contract drift (Transitive Blast Radius):** Agent A changes the signature of `verifyToken` in `src/lib/auth.ts` while Agent B is writing code in `src/routes/checkout.ts` two import hops away.
4. **Late merge conflicts:** Standard `git worktree` setups isolate files on disk, so conflicts aren't discovered until 45 minutes later when branches are merged.

**Kith solves all four deterministically at the OS, Git plumbing, AST, and Hook layer—with zero external servers or Docker containers.**

---

## Six Bulletproof Pillars

1. **Zero-Trust Enforcement (`Pre/PostToolUse` Hooks + Merkle Bash Quarantine + `PATH` Shims):**
   - Intercepts `Edit`/`Write`/`MultiEdit` before touching disk if another agent holds a fencing lock on the target scope.
   - Captures a **Merkle snapshot** before every `Bash` execution. If a script modifies a file locked by another agent, Kith **automatically reverts the file to its exact pre-command bytes** and saves the unauthorized change into `.coord/quarantine/`.
   - Blocks destructive `git reset --hard` / `git clean -fd` in shared workspaces and serializes `npm`/`pnpm`/`yarn install` via FIFO mutex shims.
2. **Sub-15ms Live Dirty-Tree Conflict Radar (`GIT_INDEX_FILE` + `git merge-tree` + AST Filter):**
   - Maintains an ephemeral shadow Git index per agent (`.coord/shadow-index/<agent>.index`) without touching `.git/index`.
   - Runs `git merge-tree --write-tree` across **uncommitted files** on every edit, using an AST additive filter so disjoint exports added to `index.ts` or keys added to `package.json` are marked `AUTO-MERGEABLE`.
3. **Import-Graph Blast Radius & Zero-Touch Contract Blackboard:**
   - Automatically extracts exported functions, types, interfaces, schemas, and routes on every file edit.
   - Traces the repository's transitive import graph (up to 4 hops) and immediately alerts downstream agents when an upstream signature changes.
4. **Semantic Duplicate-Work Prevention (SQLite FTS5 BM25 + AST Type Fingerprinting):**
   - Combines SQLite FTS5, domain synonym normalization, and structural parameter/return-type fingerprints to warn agents when they create a symbol that duplicates an existing export or a sibling agent's new helper.
5. **Instant Copy-on-Write Worktrees & Bors-Style Speculative Merge Train:**
   - Spawns isolated worktrees hydrated via **APFS `cp -cR` (macOS) / Reflink (Linux)** in `<100ms` with zero extra disk usage.
   - Integrates completed branches in a detached speculative staging worktree, auto-resolves AST-additive conflicts, and runs verification (`tsc --noEmit` / tests) before fast-forwarding `main`.
6. **Monotonic Fencing Tokens & `(pid, lstart)` Process Liveness Reaper:**
   - Every lock and resource lease carries a strictly increasing `fencing_token` to reject zombie split-brain writes.
   - Verifies kernel process start timestamps (`ps -o lstart=`) to reclaim locks, ports, and tasks from crashed terminals in `<50ms`.

---

## Quick Start (1-Command Install)

```bash
npx kith init
```

Running `kith init` in any repository automatically configures:
- `.claude/settings.json` (MCP server + `PreToolUse` / `PostToolUse` hooks)
- `.cursor/mcp.json` (MCP server)
- `.agent/skills/kith/SKILL.md` (Antigravity / generic agent skill)
- `AGENTS.md` (Codex / CLI instructions)
- `.git/hooks/pre-commit` & `.coord/bin/{npm,pnpm,yarn}` shims

---

## CLI Usage (`kith` / `coord`)

```bash
# Launch live TUI dashboard
kith top

# Peer-to-Peer Mode: declare intent, check semantic & glob overlaps, and lock scope
kith begin --agent claude-1 --title "Refactor JWT middleware" --scope "src/auth/**"

# Spawn an isolated Copy-on-Write worktree
kith begin --agent codex-2 --title "Billing webhooks" --scope "src/billing/**" --worktree

# Orchestrator Mode: add DAG tasks with dependencies and claim next unblocked task
kith task add --id schema --title "Add Drizzle billing schema" --scope "src/db/**"
kith task add --id api --title "Add billing endpoints" --depends-on schema --scope "src/api/**"
kith task claim --agent worker-1

# Lease a collision-free local TCP port
kith port --agent claude-1 --service web

# Serialize package installs or migrations across parallel agents
kith mutex --agent claude-1 --name install -- pnpm install

# Complete work & run Speculative Merge Train with verification gate
kith complete --agent codex-2 --verify "pnpm run typecheck"
```
