# Roadmap

The product gate is a developer completing a real task with cooperating agents: connect, claim, edit separate worktrees, coordinate shared resources, verify/integrate, and recover without losing unfinished work.

## Keep the core small

MCP is the default agent interface. Keep one shared ownership ledger per Git common directory, capability-owned sessions, renewable command exclusion, conservative Git integration and retained-work recovery. Global connections select a repository per task. CLI inspection, the optional menu and editor adapters expose the same core; they do not become fleet controllers. Preserve existing client configuration and review gates.

## Current delivery gates

1. **Truthful observations.** Missing/future file times must not appear as fresh activity. Differing dirty copies, recorded ownership, unavailable scans and verified merge results remain distinct. No writer attribution or compatibility guarantee from polling.
2. **One onboarding journey.** Explain global setup versus project init once; diagnose both without writes. Configuration is not connection or ownership. Keep MCP-only use free of manual capability exports and preserve custom entries/hooks/permissions.
3. **Actual workflow completion.** Use current Kith fixes as real project work through scoped claims, isolated edits, normal verification and integration. Record native client versions separately from MCP fixtures. Validate failure/repair/retry and preserved target bytes; internal checks are not external adoption.
4. **Followable recovery.** Exercise disconnect, expiry, failed checks, partial setup, interrupted migration and damaged-state refusal. Preserve worktrees and matching stopped database/sidecars; no automatic repair, forced claim release or deletion of `.coord`.
5. **Exact release evidence.** Require all six Linux/macOS and both Windows jobs on the candidate, including any editor checks, plus the exact packed-package consumer. Verify registry bytes and tag workflows after publication. Maintain versioned client evidence and honest platform limits.

Published 0.1.3 / protocol 1.2 has recorded source/tag and clean-registry evidence. Current main adds protocol 1.3 dev-server supervision and bounded claim waits; these are not in published 0.1.3. The editor branch must pass its own native/bundled-server checks before integration and delivery. A green prior release does not certify a new branch.

## Deferred

No new dashboard, fleet spawning, model router, automatic merges, semantic scoring, writer-PID attribution, whole-Mac crawler or new adapters are planned in this reliability pass. Prioritize concrete blocked workflows over feature requests. Actual external task completion remains a separate product-validation gate.
