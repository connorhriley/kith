import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { discoverRepository, isWithin, physicalPath } from './repository.js';
import { KithEngine } from './engine.js';

export interface GcOptions {
  dryRun?: boolean;
  staleDays?: number;
  force?: boolean;
}

export interface GcPreservedItem {
  path: string;
  branch: string | null;
  reason: 'active-session' | 'open-handoff' | 'dirty' | 'unmerged' | 'adopted';
}

export interface GcReport {
  ok: boolean;
  dryRun: boolean;
  repository: string;
  nothingToClean: boolean;
  reapedAgents: number;
  prunedShadowIndexes: number;
  removedWorktrees: string[];
  deletedBranches: string[];
  preservedWorktrees: GcPreservedItem[];
  prunedExpiredLocks: number;
  prunedOperations: number;
  prunedDoneTasks: number;
  prunedOldEvents: number;
  prunedDeadAgents: number;
  prunedArtifacts: number;
}

function gitStatusDirty(dir: string): boolean {
  try {
    const out = execFileSync('git', ['status', '--porcelain'], {
      cwd: dir,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
    return out.length > 0;
  } catch {
    return true;
  }
}

function gitIsMerged(repoRoot: string, commit: string): boolean {
  if (!commit) return false;
  try {
    execFileSync('git', ['merge-base', '--is-ancestor', commit, 'HEAD'], {
      cwd: repoRoot,
      stdio: ['ignore', 'ignore', 'ignore'],
    });
    return true;
  } catch {
    return false;
  }
}

/** Remove one Kith-created worktree. Never calls `git worktree prune`, which would also drop metadata Kith does not own. */
function removeCreatedWorktree(repoRoot: string, wtPath: string, force: boolean): void {
  let admin: string | null = null;
  try {
    const text = fs.readFileSync(path.join(wtPath, '.git'), 'utf8');
    const match = /^gitdir:\s*(.+)\s*$/m.exec(text);
    if (match?.[1]) admin = path.resolve(wtPath, match[1].trim());
  } catch { /* The directory may already be gone. */ }
  try {
    execFileSync('git', ['worktree', 'remove', ...(force ? ['--force'] : []), wtPath], {
      cwd: repoRoot, stdio: ['ignore', 'pipe', 'pipe'],
    });
    return;
  } catch { /* Fall through to deleting only this directory and its own git metadata. */ }
  fs.rmSync(wtPath, { recursive: true, force: true });
  if (!admin) return;
  try {
    const layout = discoverRepository(repoRoot);
    if (!layout.commonGitDir) return;
    const adminPath = physicalPath(admin);
    const worktreesAdmin = physicalPath(path.join(layout.commonGitDir, 'worktrees'));
    if (isWithin(worktreesAdmin, adminPath) && adminPath !== worktreesAdmin) fs.rmSync(adminPath, { recursive: true, force: true });
  } catch { /* Leave metadata in place rather than pruning every worktree. */ }
}

function gitHasCommitSince(repoRoot: string, sinceMs: number, files: string[]): boolean {
  if (!files.length) return false;
  try {
    const out = execFileSync(
      'git',
      ['log', '-1', '--format=%H', `--since=@${Math.floor(sinceMs / 1000)}`, '--', ...files],
      { cwd: repoRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }
    ).trim();
    return out.length > 0;
  } catch {
    return false;
  }
}

/**
 * Resyncs `.git/index` entries that drifted behind `HEAD` after temporary-index `update-ref` commits
 * without touching any files in the working tree.
 */
export function resyncStaleIndexEntries(repoRoot: string): number {
  let cachedPaths: string[] = [];
  try {
    const out = execFileSync('git', ['diff', '--cached', '--name-only', '-z', 'HEAD'], {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    cachedPaths = out.split('\0').filter(Boolean);
  } catch {
    return 0;
  }
  if (cachedPaths.length === 0) return 0;

  try {
    execFileSync('git', ['reset', '-q', 'HEAD'], {
      cwd: repoRoot,
      stdio: ['ignore', 'ignore', 'ignore'],
    });
    return cachedPaths.length;
  } catch {
    return 0;
  }
}

export function gcCoordination(directory = process.cwd(), options: GcOptions = {}): GcReport {
  const dryRun = Boolean(options.dryRun);
  const force = Boolean(options.force);
  const staleDays = Number.isFinite(options.staleDays) ? Math.max(0, options.staleDays!) : 14;
  const layout = discoverRepository(directory);
  const dbPath = path.join(layout.coordDir, 'state.db');

  const report: GcReport = {
    ok: true,
    dryRun,
    repository: layout.checkoutRoot,
    nothingToClean: false,
    reapedAgents: 0,
    prunedShadowIndexes: 0,
    removedWorktrees: [],
    deletedBranches: [],
    preservedWorktrees: [],
    prunedExpiredLocks: 0,
    prunedOperations: 0,
    prunedDoneTasks: 0,
    prunedOldEvents: 0,
    prunedDeadAgents: 0,
    prunedArtifacts: 0,
  };

  if (!fs.existsSync(dbPath)) {
    report.nothingToClean = true;
    return report;
  }

  const now = Date.now();
  const cutoff = now - staleDays * 24 * 60 * 60 * 1000;
  const engine = new KithEngine(layout.checkoutRoot);
  try {
    if (!dryRun) {
      report.reapedAgents = engine.fencing.reapDeadAgents().length;
      engine.coordDb.db
        .prepare("DELETE FROM handoffs WHERE task_id IS NULL AND summary = 'Session stopped with uncommitted changes.'")
        .run();
      if (layout.commonGitDir) {
        resyncStaleIndexEntries(layout.checkoutRoot);
      }
    }
    report.prunedShadowIndexes = engine.shadowGit.pruneStaleShadowIndexes(dryRun);

    const activeAgents = engine.fencing.listAgents(true);
    const activeWorktreePaths = new Set(
      activeAgents.map(a => a.worktree_path).filter((p): p is string => Boolean(p)).map(p => physicalPath(p))
    );
    const rawOpenHandoffs = engine.handoffs
      .unresolved(500)
      .filter(h => !(h.task_id === null && h.summary === 'Session stopped with uncommitted changes.'));
    const queuedTaskIds = new Set(
      (engine.coordDb.db.prepare("SELECT id FROM tasks WHERE status = 'queued'").all() as Array<{ id: string }>).map(r => r.id)
    );
    const resolvedAutoHandoffs = rawOpenHandoffs.filter((h) => {
      if (h.source !== 'auto' || h.kind !== 'abandoned' || !h.task_id || !queuedTaskIds.has(h.task_id)) return false;
      if (h.branch && h.branch.startsWith('kith/') && !gitIsMerged(layout.checkoutRoot, h.branch)) return false;
      return force || gitHasCommitSince(layout.checkoutRoot, h.created_at, h.files);
    });
    const resolvedAutoHandoffIds = new Set(resolvedAutoHandoffs.map(h => h.id));
    const resolvedAutoTaskIds = new Set(resolvedAutoHandoffs.map(h => h.task_id!));
    const openHandoffs = rawOpenHandoffs.filter(h => !resolvedAutoHandoffIds.has(h.id));
    // Only explicit agent-written handoffs pin clean/merged worktrees; auto-captured crash handoffs rely on dirty/unmerged checks.
    const explicitHandoffs = openHandoffs.filter(h => h.source === 'agent');
    const handoffWorktrees = new Set(
      explicitHandoffs.map(h => h.worktree_path).filter((p): p is string => Boolean(p)).map(p => physicalPath(p))
    );
    const handoffBranches = new Set(explicitHandoffs.map(h => h.branch).filter((b): b is string => Boolean(b)));
    const pinnedAgentIds = new Set<string>([
      ...activeAgents.map(a => a.id),
      ...openHandoffs.map(h => h.agent_id),
    ]);
    const pinnedTaskIds = new Set<string>(
      openHandoffs.map(h => h.task_id).filter((id): id is string => Boolean(id))
    );

    const worktreesDir = physicalPath(path.join(layout.coordDir, 'worktrees'));
    const adoptedPaths = new Set(
      engine.worktrees.listRegistrations()
        .filter(row => row.provenance === 'adopted')
        .map(row => { try { return physicalPath(row.worktreePath); } catch { return row.worktreePath; } })
    );
    if (fs.existsSync(worktreesDir)) {
      // Do not `git worktree prune`: that drops metadata for every missing worktree, including ones Kith did not create.
      const listed = engine.worktrees.listWorktrees();
      for (const wt of listed) {
        const wtPath = physicalPath(wt.path);
        if (!isWithin(worktreesDir, wtPath) || wtPath === worktreesDir) continue;
        if (adoptedPaths.has(wtPath)) {
          report.preservedWorktrees.push({ path: wtPath, branch: wt.branch, reason: 'adopted' });
          continue;
        }
        if (activeWorktreePaths.has(wtPath)) {
          report.preservedWorktrees.push({ path: wtPath, branch: wt.branch, reason: 'active-session' });
          continue;
        }
        if (!force && (handoffWorktrees.has(wtPath) || (wt.branch && handoffBranches.has(wt.branch)))) {
          report.preservedWorktrees.push({ path: wtPath, branch: wt.branch, reason: 'open-handoff' });
          continue;
        }
        if (!force && gitStatusDirty(wtPath)) {
          report.preservedWorktrees.push({ path: wtPath, branch: wt.branch, reason: 'dirty' });
          continue;
        }
        if (!force && !gitIsMerged(layout.checkoutRoot, wt.head)) {
          report.preservedWorktrees.push({ path: wtPath, branch: wt.branch, reason: 'unmerged' });
          continue;
        }
        report.removedWorktrees.push(wtPath);
        const removeBranch = Boolean(wt.branch && wt.branch.startsWith('kith/') && (!handoffBranches.has(wt.branch) || force));
        if (removeBranch) report.deletedBranches.push(wt.branch!);
        if (!dryRun) {
          removeCreatedWorktree(layout.checkoutRoot, wtPath, force);
          if (removeBranch && wt.branch) {
            try {
              execFileSync('git', ['branch', '-D', wt.branch], { cwd: layout.checkoutRoot, stdio: ['ignore', 'pipe', 'pipe'] });
            } catch { /* Branch already absent or checked out elsewhere. */ }
          }
        }
      }

      const remaining = new Set(engine.worktrees.listWorktrees().map(w => physicalPath(w.path)));
      for (const entry of fs.readdirSync(worktreesDir)) {
        const orphan = physicalPath(path.join(worktreesDir, entry));
        if (remaining.has(orphan) || activeWorktreePaths.has(orphan) || adoptedPaths.has(orphan) || (!force && handoffWorktrees.has(orphan))) continue;
        report.removedWorktrees.push(orphan);
        if (!dryRun) fs.rmSync(orphan, { recursive: true, force: true });
      }
    }

    for (const dirName of ['snapshots', 'quarantine']) {
      const dir = path.join(layout.coordDir, dirName);
      if (!fs.existsSync(dir)) continue;
      for (const entry of fs.readdirSync(dir)) {
        const full = path.join(dir, entry);
        try {
          const stat = fs.lstatSync(full);
          if (stat.mtimeMs < cutoff) {
            report.prunedArtifacts++;
            if (!dryRun) fs.rmSync(full, { recursive: true, force: true });
          }
        } catch { /* ignore */ }
      }
    }

    if (dryRun) {
      report.prunedExpiredLocks = Number(
        (engine.coordDb.db.prepare('SELECT COUNT(*) AS n FROM locks WHERE expires_at <= ?').get(now) as { n: number }).n
      );
      report.prunedOperations = Number(
        (engine.coordDb.db.prepare('SELECT COUNT(*) AS n FROM mcp_operations WHERE created_at < ?').get(cutoff) as { n: number }).n
      );
      const doneRows = engine.coordDb.db.prepare(
        "SELECT id FROM tasks WHERE status IN ('done', 'queued') AND updated_at < ?"
      ).all(cutoff) as Array<{ id: string }>;
      const prunedTaskSet = new Set([
        ...doneRows.filter(r => !pinnedTaskIds.has(r.id)).map(r => r.id),
        ...resolvedAutoTaskIds,
      ]);
      report.prunedDoneTasks = prunedTaskSet.size;
      report.prunedOldEvents = Number(
        (engine.coordDb.db.prepare('SELECT COUNT(*) AS n FROM events WHERE timestamp < ?').get(cutoff) as { n: number }).n
      );
      const deadRows = engine.coordDb.db.prepare(
        "SELECT id FROM agents WHERE status != 'active' AND (last_heartbeat_at < ? OR id LIKE 'auto-%')"
      ).all(cutoff) as Array<{ id: string }>;
      report.prunedDeadAgents = deadRows.filter(r => !pinnedAgentIds.has(r.id)).length;
    } else {
      engine.coordDb.withTransaction(() => {
        report.prunedExpiredLocks = Number(
          engine.coordDb.db.prepare('DELETE FROM locks WHERE expires_at <= ?').run(now).changes
        );
        report.prunedOperations = Number(
          engine.coordDb.db.prepare('DELETE FROM mcp_operations WHERE created_at < ?').run(cutoff).changes
        );
        for (const hid of resolvedAutoHandoffIds) {
          engine.coordDb.db.prepare('DELETE FROM handoffs WHERE id = ?').run(hid);
        }
        const doneIds = (
          engine.coordDb.db.prepare("SELECT id FROM tasks WHERE status IN ('done', 'queued') AND updated_at < ?").all(cutoff) as Array<{ id: string }>
        ).map(r => r.id).filter(id => !pinnedTaskIds.has(id));
        const pruneTaskIds = new Set([...doneIds, ...resolvedAutoTaskIds]);
        for (const id of pruneTaskIds) {
          if (resolvedAutoTaskIds.has(id)) {
            engine.coordDb.db.prepare('DELETE FROM handoffs WHERE task_id = ?').run(id);
          }
          engine.coordDb.db.prepare('DELETE FROM tasks WHERE id = ?').run(id);
          report.prunedDoneTasks++;
        }
        report.prunedOldEvents = Number(
          engine.coordDb.db.prepare('DELETE FROM events WHERE timestamp < ?').run(cutoff).changes
        );
        engine.coordDb.db.prepare('DELETE FROM quarantine WHERE created_at < ?').run(cutoff);
        const deadRows = engine.coordDb.db.prepare(
          "SELECT id FROM agents WHERE status != 'active' AND (last_heartbeat_at < ? OR id LIKE 'auto-%')"
        ).all(cutoff) as Array<{ id: string }>;
        for (const r of deadRows) {
          if (pinnedAgentIds.has(r.id)) continue;
          engine.coordDb.db.prepare('DELETE FROM agent_sessions WHERE agent_id = ?').run(r.id);
          engine.coordDb.db.prepare('DELETE FROM agents WHERE id = ?').run(r.id);
          report.prunedDeadAgents++;
        }
      });
    }

    report.nothingToClean =
      report.reapedAgents === 0 &&
      report.prunedShadowIndexes === 0 &&
      report.removedWorktrees.length === 0 &&
      report.prunedExpiredLocks === 0 &&
      report.prunedOperations === 0 &&
      report.prunedDoneTasks === 0 &&
      report.prunedOldEvents === 0 &&
      report.prunedDeadAgents === 0 &&
      report.prunedArtifacts === 0;

    return report;
  } finally {
    engine.close();
  }
}
