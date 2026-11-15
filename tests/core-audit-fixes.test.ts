import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { KithEngine, gcCoordination } from '../src/index.js';

let temp: string;
const engines: KithEngine[] = [];

beforeEach(() => {
  temp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kith-audit-fixes-')));
});

afterEach(() => {
  for (const engine of engines.splice(0)) {
    try { engine.close(); } catch { /* Already closed. */ }
  }
  fs.rmSync(temp, { recursive: true, force: true });
});

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function initRepo(name = 'repo'): string {
  const dir = path.join(temp, name);
  fs.mkdirSync(dir, { recursive: true });
  git(dir, 'init', '-b', 'main');
  git(dir, 'config', 'user.email', 'test@example.invalid');
  git(dir, 'config', 'user.name', 'Test');
  fs.writeFileSync(path.join(dir, '.gitignore'), '.coord/\n');
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'src/types.ts'), 'export interface AuthPayload { id: string; role: string }\n');
  fs.writeFileSync(path.join(dir, 'src/consumer.ts'), "import { AuthPayload } from './types.js';\nexport const p = (a: AuthPayload) => a.role;\n");
  git(dir, 'add', '.');
  git(dir, 'commit', '-m', 'seed');
  return dir;
}

describe('core audit fixes', () => {
  it('detects breaking changes on single-line braced TypeScript interfaces', () => {
    const repo = initRepo();
    const engine = new KithEngine(repo);
    engines.push(engine);

    engine.fencing.registerAgent({ id: 'alice' });
    engine.fencing.registerAgent({ id: 'bob' });
    engine.beginWork({ agentId: 'alice', title: 'Update auth type', scopeGlobs: ['src/types.ts'] });
    engine.locks.acquireLocks({ agentId: 'bob', patterns: ['src/consumer.ts'] });

    engine.processPostFileEdit({ agentId: 'bob', filePath: 'src/consumer.ts' });
    engine.processPostFileEdit({ agentId: 'alice', filePath: 'src/types.ts' });

    const edited = 'export interface AuthPayload { id: string }\n';
    fs.writeFileSync(path.join(repo, 'src/types.ts'), edited);
    const report = engine.processPostFileEdit({ agentId: 'alice', filePath: 'src/types.ts', content: edited });

    expect(report.contractReport.breakingChanges.some(b => b.symbolName === 'AuthPayload' && b.affectedDownstreamFile === 'src/consumer.ts')).toBe(true);
    expect(report.warnings.some(w => w.includes('BLAST RADIUS ALERT') && w.includes('AuthPayload'))).toBe(true);
  });

  it('runs verificationCmd in main mode and preserves claims on failure until repaired', () => {
    const repo = initRepo();
    const engine = new KithEngine(repo);
    engines.push(engine);

    engine.setWorkflowMode('main');
    engine.fencing.registerAgent({ id: 'worker' });
    engine.beginWork({ agentId: 'worker', title: 'Main checkout fix', scopeGlobs: ['src/a.mjs'] });
    fs.writeFileSync(path.join(repo, 'src/a.mjs'), 'export const ok = 1;\n');

    const failed = engine.completeWork({
      agentId: 'worker',
      verificationCmd: `${JSON.stringify(process.execPath)} -e "process.exit(17)"`,
    });
    expect(failed.ok).toBe(false);
    expect(engine.locks.listLocks().some(l => l.owner_agent_id === 'worker')).toBe(true);

    const passed = engine.completeWork({
      agentId: 'worker',
      verificationCmd: `${JSON.stringify(process.execPath)} --check src/a.mjs`,
    });
    expect(passed.ok).toBe(true);
    expect(engine.locks.listLocks()).toEqual([]);
  });

  it('prunes safe garbage in kith gc while preserving dirty, unmerged, and handoff worktrees', () => {
    const repo = initRepo();
    expect(gcCoordination(repo)).toMatchObject({ ok: true, nothingToClean: true });
    expect(fs.existsSync(path.join(repo, '.coord'))).toBe(false);

    const engine = new KithEngine(repo);
    engines.push(engine);

    // 1. Merged & clean worktree -> should be removed by gc
    engine.fencing.registerAgent({ id: 'merged-agent' });
    const mergedWt = engine.beginWork({ agentId: 'merged-agent', title: 'Merged work', scopeGlobs: ['src/m.ts'], isolateWorktree: true }).worktree!;
    engine.completeWork({ agentId: 'merged-agent' });

    // 2. Dirty retained worktree -> must be preserved
    engine.fencing.registerAgent({ id: 'dirty-agent' });
    const dirtyWt = engine.beginWork({ agentId: 'dirty-agent', title: 'Dirty work', scopeGlobs: ['src/d.ts'], isolateWorktree: true }).worktree!;
    fs.writeFileSync(path.join(dirtyWt.worktreePath, 'untracked.txt'), 'keep me\n');
    engine.fencing.abandonAgentSession('dirty-agent');

    // 3. Clean but unmerged worktree -> must be preserved
    engine.fencing.registerAgent({ id: 'unmerged-agent' });
    const unmergedWt = engine.beginWork({ agentId: 'unmerged-agent', title: 'Unmerged work', scopeGlobs: ['src/u.ts'], isolateWorktree: true }).worktree!;
    fs.writeFileSync(path.join(unmergedWt.worktreePath, 'src/u.ts'), 'export const u = 1;\n');
    git(unmergedWt.worktreePath, 'add', '.');
    git(unmergedWt.worktreePath, 'commit', '-m', 'unmerged commit');
    engine.fencing.abandonAgentSession('unmerged-agent');

    // 4. Clean & merged worktree referenced by an open handoff -> must be preserved without --force
    engine.fencing.registerAgent({ id: 'handoff-agent' });
    const handoffWt = engine.beginWork({ agentId: 'handoff-agent', title: 'Blocked work', scopeGlobs: ['src/h.ts'], isolateWorktree: true }).worktree!;
    engine.handoffs.write({ agentId: 'handoff-agent', kind: 'blocked', summary: 'Waiting for review' });
    engine.fencing.abandonAgentSession('handoff-agent');

    // Orphan shadow index & expired lock
    const shadowDir = path.join(repo, '.coord', 'shadow-index');
    fs.mkdirSync(shadowDir, { recursive: true });
    fs.writeFileSync(path.join(shadowDir, 'dead-agent-99.index'), 'orphan');
    engine.coordDb.db.prepare("INSERT INTO locks (id, pattern, owner_agent_id, fencing_token, acquired_at, expires_at) VALUES ('exp1', 'x.ts', 'ghost', 1, 1, 1)").run();

    engine.close();

    const dry = gcCoordination(repo, { dryRun: true });
    expect(dry.dryRun).toBe(true);
    expect(dry.removedWorktrees).toContain(mergedWt.worktreePath);
    expect(dry.prunedShadowIndexes).toBe(1);
    expect(dry.prunedExpiredLocks).toBe(1);
    expect(fs.existsSync(mergedWt.worktreePath)).toBe(true);

    const report = gcCoordination(repo);
    expect(report.ok).toBe(true);
    expect(report.removedWorktrees).toContain(mergedWt.worktreePath);
    expect(report.deletedBranches).toContain(mergedWt.branch);
    expect(report.prunedShadowIndexes).toBe(1);
    expect(report.prunedExpiredLocks).toBe(1);
    expect(fs.existsSync(mergedWt.worktreePath)).toBe(false);
    expect(fs.existsSync(dirtyWt.worktreePath)).toBe(true);
    expect(fs.existsSync(unmergedWt.worktreePath)).toBe(true);
    expect(fs.existsSync(handoffWt.worktreePath)).toBe(true);
    expect(report.preservedWorktrees.map(w => w.reason).sort()).toEqual(['dirty', 'open-handoff', 'unmerged']);
  });
});
