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
  reason: 'active-session' | 'open-handoff' | 'dirty' | 'unmerged';
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
    }
    report.prunedShadowIndexes = engine.shadowGit.pruneStaleShadowIndexes(dryRun);

    const activeAgents = engine.fencing.listAgents(true);
    const activeWorktreePaths = new Set(
      activeAgents.map(a => a.worktree_path).filter((p): p is string => Boolean(p)).map(p => physicalPath(p))
    );
    const openHandoffs = engine.handoffs.unresolved(500);
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
    if (fs.existsSync(worktreesDir)) {
      if (!dryRun) {
        try {
          execFileSync('git', ['worktree', 'prune'], { cwd: layout.checkoutRoot, stdio: ['ignore', 'ignore', 'ignore'] });
        } catch { /* Best effort. */ }
      }
      const listed = engine.worktrees.listWorktrees();
      for (const wt of listed) {
        const wtPath = physicalPath(wt.path);
        if (!isWithin(worktreesDir, wtPath) || wtPath === worktreesDir) continue;
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
          try {
            execFileSync('git', ['worktree', 'remove', ...(force ? ['--force'] : []), wtPath], {
              cwd: layout.checkoutRoot,
              stdio: ['ignore', 'pipe', 'pipe'],
            });
          } catch {
            fs.rmSync(wtPath, { recursive: true, force: true });
            try {
              execFileSync('git', ['worktree', 'prune'], { cwd: layout.checkoutRoot, stdio: ['ignore', 'ignore', 'ignore'] });
            } catch { /* ignore */ }
          }
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
        if (remaining.has(orphan) || activeWorktreePaths.has(orphan) || (!force && handoffWorktrees.has(orphan))) continue;
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
        "SELECT id FROM tasks WHERE status = 'done' AND updated_at < ?"
      ).all(cutoff) as Array<{ id: string }>;
      report.prunedDoneTasks = doneRows.filter(r => !pinnedTaskIds.has(r.id)).length;
      report.prunedOldEvents = Number(
        (engine.coordDb.db.prepare('SELECT COUNT(*) AS n FROM events WHERE timestamp < ?').get(cutoff) as { n: number }).n
      );
      const deadRows = engine.coordDb.db.prepare(
        "SELECT id FROM agents WHERE status != 'active' AND last_heartbeat_at < ?"
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
        const doneIds = (
          engine.coordDb.db.prepare("SELECT id FROM tasks WHERE status = 'done' AND updated_at < ?").all(cutoff) as Array<{ id: string }>
        ).map(r => r.id).filter(id => !pinnedTaskIds.has(id));
        for (const id of doneIds) {
          engine.coordDb.db.prepare("DELETE FROM tasks WHERE id = ?").run(id);
          report.prunedDoneTasks++;
        }
        report.prunedOldEvents = Number(
          engine.coordDb.db.prepare('DELETE FROM events WHERE timestamp < ?').run(cutoff).changes
        );
        const deadRows = engine.coordDb.db.prepare(
          "SELECT id FROM agents WHERE status != 'active' AND last_heartbeat_at < ?"
        ).all(cutoff) as Array<{ id: string }>;
        for (const r of deadRows) {
          if (pinnedAgentIds.has(r.id)) continue;
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
