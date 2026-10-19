# Roadmap

Success means a new contributor can reproduce a two-agent workflow, understand its boundaries, preserve work through failure, and extend one client adapter without rewriting the engine.

## 1. Reliability foundation — implemented

Implemented: non-destructive configuration merging and previews, safer worktree lifecycle, serialized Kith integration, atomic port reservations, strictly additive JSON/source merge handling, surfaced Git errors, preserved command arguments, event pagination, non-destructive Bash recovery defaults, actual process contention coverage, contributor docs, license text, and a CI definition.

The canonical upstream is [connorhriley/kith](https://github.com/connorhriley/kith). Hosted results are available in [Actions](https://github.com/connorhriley/kith/actions/workflows/ci.yml); workflow configuration alone is not evidence of a passing matrix.

## 2. Session, command, and client validation — implemented

Capability-owned session generations now protect agent-scoped mutation boundaries; process anchors cannot be silently rebound and liveness uses actual kernel identities. Schema 2 invalidates legacy unowned sessions while preserving files. Commands renew leases asynchronously, preserve FIFO tickets, and retain a process-group execution guard across expiry, cancellation, suspension, or supervisor crashes. CLI signals and output are supervised. Actual MCP stdio clients and generated hook commands now cover worktree reports, Git hooks, verification, completion, and disconnect recovery. A two-client disposable example is available with `pnpm demo`.

These gates are covered locally. Version-specific native Codex and Claude CLI runs are recorded in [client validation](client-validation.md). Other releases, GUI discovery, and persisted project trust need separate validation.

## 3. Path, scope and merge hardening — implemented; recovery next

- Exact scope-language intersection for literals, `*`, `?` and whole-segment `**`, with generated witness checks, dotfile coverage, explicit literal-file scopes and conservative handling of legacy unsupported scopes.
- Redesign shared-tree Bash attribution before considering automatic restoration as a default. Gate: sibling edits cannot be reverted by another agent's post-hook.
- Shared common-Git-directory discovery from roots, subdirectories, linked worktrees, symlink aliases and separate Git directories; physical containment, external-link refusal, literal framework paths and invoking-index Git guards have regression coverage.
- Parsed append-only declaration resolution rejects imports, initializers, top-level execution, name collisions, cross-branch bindings, unsupported syntax, lossy JSON and ambiguous Git stages/modes. Actual Git conflicts cover symlink refusal and unusual filenames.
- Legacy migration rollback/retry (including a process killed before commit), damaged-state refusal and stopped WAL backup restoration have regressions, including killed MCP ownership and worktree continuation. Broader upgrade/downgrade combinations and corrupted-state repair remain unvalidated.

## 4. Broaden integration validation

Add more client adapter payload fixtures, tested setup rollback/uninstall, and manual workflows against actual Claude/Cursor/Codex application releases. Extend the current stdio/hook lifecycle and cancellation tests to other supported payload shapes. Cover paths with spaces, nested workspaces, custom Git hooks, missing Git identity, and crashes. Measure latency and memory in reproducible small and large repository fixtures before publishing performance claims.

## 5. Public project and release operations

The canonical upstream is established. Confirm the package namespace, maintainers, private security/moderation contacts, and decision process. Run the CI matrix on real pull requests. Publish a prerelease only after a packed-package clean-install check, dependency review, documented support matrix, changelog, rollback procedure, and end-to-end demo. Add provenance and automated publishing after ownership and credentials are established.

## 6. Adaptability after the core is sound

Define parser and client adapter interfaces, add configuration for project-specific verification/hydration, and ship small runnable examples. Prioritize requests backed by concrete user workflows. Keep enforcement, advisory analysis, and presentation separate.
