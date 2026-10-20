import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { KithEngine } from '../src/index.js';

describe('Dirty-Tree Shadow Git (`git merge-tree`), CoW Worktrees & Speculative Merge Train', () => {
  let tmpDir: string;
  let engine: KithEngine;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kith-git-merge-test-'));
    execFileSync('git', ['init'], { cwd: tmpDir });
    execFileSync('git', ['config', 'user.email', 'test@kith.dev'], { cwd: tmpDir });
    execFileSync('git', ['config', 'user.name', 'Kith Test'], { cwd: tmpDir });

    fs.mkdirSync(path.join(tmpDir, 'src'), { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, 'src/shared.ts'),
      `export function calculateTotal(price: number): number {\n  return price;\n}\n`,
      'utf8'
    );
    fs.writeFileSync(
      path.join(tmpDir, 'src/index.ts'),
      `export function baseHelper(): string {\n  return 'base';\n}\n`,
      'utf8'
    );

    execFileSync('git', ['add', '.'], { cwd: tmpDir });
    execFileSync('git', ['commit', '-m', 'Initial commit'], { cwd: tmpDir });

    engine = new KithEngine(tmpDir);
  });

  afterEach(() => {
    engine.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('detects live dirty-tree conflicts across uncommitted files via GIT_INDEX_FILE + git merge-tree', () => {
    engine.fencing.registerAgent({ id: 'agent-1' });
    engine.fencing.registerAgent({ id: 'agent-2' });

    // Agent 1 makes an uncommitted edit to calculateTotal in src/shared.ts
    engine.processPostFileEdit({
      agentId: 'agent-1',
      filePath: 'src/shared.ts',
      content: `export function calculateTotal(price: number): number {\n  return price * 1.2;\n}\n`,
    });

    // Agent 2 makes a conflicting uncommitted edit to the same function in src/shared.ts
    const res2 = engine.processPostFileEdit({
      agentId: 'agent-2',
      filePath: 'src/shared.ts',
      content: `export function calculateTotal(price: number): number {\n  return price * 0.85;\n}\n`,
    });

    expect(res2.dirtyMergeConflicts).toHaveLength(1);
    expect(res2.dirtyMergeConflicts[0].file_path).toBe('src/shared.ts');
    expect(res2.dirtyMergeConflicts[0].severity).toBe('text_conflict');
    expect(res2.warnings.some((w) => w.includes('LIVE DIRTY-TREE CONFLICT'))).toBe(true);
  });

  it('reports Git conflicts even for apparently disjoint appended exports', () => {
    engine.fencing.registerAgent({ id: 'agent-1' });
    engine.fencing.registerAgent({ id: 'agent-2' });

    // Agent 1 appends helperAlpha to src/index.ts
    engine.processPostFileEdit({
      agentId: 'agent-1',
      filePath: 'src/index.ts',
      content: `export function baseHelper(): string {\n  return 'base';\n}\nexport function helperAlpha(x: number): number {\n  return x + 1;\n}\n`,
    });

    // Agent 2 appends helperBeta to src/index.ts at the exact same lines
    const res2 = engine.processPostFileEdit({
      agentId: 'agent-2',
      filePath: 'src/index.ts',
      content: `export function baseHelper(): string {\n  return 'base';\n}\nexport function helperBeta(y: string): string {\n  return y.trim();\n}\n`,
    });

    expect(res2.dirtyMergeConflicts).toHaveLength(1);
    expect(res2.dirtyMergeConflicts[0].file_path).toBe('src/index.ts');
  });

  it('preserves conflicted worktrees for explicit repair and gates retry on verification', () => {
    engine.fencing.registerAgent({ id: 'wt-agent-1' });
    engine.fencing.registerAgent({ id: 'wt-agent-2' });

    const wt1 = engine.worktrees.spawnWorktree({ agentId: 'wt-agent-1' });
    const wt2 = engine.worktrees.spawnWorktree({ agentId: 'wt-agent-2' });

    // Both worktrees append disjoint functions to src/index.ts
    fs.writeFileSync(
      path.join(wt1.worktreePath, 'src/index.ts'),
      `export function baseHelper(): string {\n  return 'base';\n}\nexport function fromAgentOne(): number {\n  return 101;\n}\n`,
      'utf8'
    );
    fs.writeFileSync(
      path.join(wt2.worktreePath, 'src/index.ts'),
      `export function baseHelper(): string {\n  return 'base';\n}\nexport function fromAgentTwo(): number {\n  return 202;\n}\n`,
      'utf8'
    );

    // Merge wt-agent-1 via Speculative Merge Train
    const merge1 = engine.mergeTrain.enqueueAndMerge({
      agentId: 'wt-agent-1',
      branch: wt1.branch,
      worktreePath: wt1.worktreePath,
      verificationCmd: 'node -e "process.exit(0)"',
    });
    expect(merge1.merged).toBe(true);

    // Git conflicts require explicit repair in the retained source worktree.
    const merge2 = engine.mergeTrain.enqueueAndMerge({
      agentId: 'wt-agent-2',
      branch: wt2.branch,
      worktreePath: wt2.worktreePath,
      verificationCmd: 'node -e "process.exit(0)"',
    });
    expect(merge2.merged).toBe(false);
    expect(merge2.diagnostics).toContain('Resolve conflicts');
    expect(fs.readFileSync(path.join(wt2.worktreePath, 'src/index.ts'), 'utf8')).toContain('fromAgentTwo');
    expect(fs.readFileSync(path.join(tmpDir, 'src/index.ts'), 'utf8')).not.toContain('fromAgentTwo');
    const target = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: tmpDir, encoding: 'utf8' }).trim();
    expect(() => execFileSync('git', ['merge', target], { cwd: wt2.worktreePath, stdio: 'pipe' })).toThrow();
    fs.writeFileSync(path.join(wt2.worktreePath, 'src/index.ts'), fs.readFileSync(path.join(tmpDir, 'src/index.ts'), 'utf8') + 'export function fromAgentTwo(): number { return 202; }\n');
    execFileSync('git', ['add', 'src/index.ts'], { cwd: wt2.worktreePath });
    execFileSync('git', ['commit', '-m', 'Resolve conflict explicitly'], { cwd: wt2.worktreePath, stdio: 'pipe' });
    expect(engine.mergeTrain.enqueueAndMerge({ agentId: 'wt-agent-2', branch: wt2.branch, worktreePath: wt2.worktreePath, verificationCmd: 'node -e "process.exit(0)"' }).merged).toBe(true);

    const finalMainIndex = fs.readFileSync(path.join(tmpDir, 'src/index.ts'), 'utf8');
    expect(finalMainIndex).toContain('fromAgentOne');
    expect(finalMainIndex).toContain('fromAgentTwo');

    // Now test verification failure gate: if verificationCmd fails, main is NOT modified!
    engine.fencing.registerAgent({ id: 'wt-broken' });
    const wtBroken = engine.worktrees.spawnWorktree({ agentId: 'wt-broken' });
    fs.writeFileSync(
      path.join(wtBroken.worktreePath, 'src/broken.ts'),
      `export const broken = true;\n`,
      'utf8'
    );

    const failedMerge = engine.mergeTrain.enqueueAndMerge({
      agentId: 'wt-broken',
      branch: wtBroken.branch,
      worktreePath: wtBroken.worktreePath,
      verificationCmd: 'node -e "console.error(\'Type error in broken.ts\'); process.exit(1)"',
    });
    expect(failedMerge.merged).toBe(false);
    expect(failedMerge.diagnostics).toContain('Type error in broken.ts');
    expect(fs.existsSync(path.join(tmpDir, 'src/broken.ts'))).toBe(false);
  });
});
