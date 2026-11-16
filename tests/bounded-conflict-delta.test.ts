import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { KithEngine } from '../src/index.js';

const git = (cwd: string, args: string[], env: NodeJS.ProcessEnv = process.env) =>
  execFileSync('git', args, { cwd, env, encoding: 'utf8' }).trim();

describe('bounded conflict delta and conflict hygiene', () => {
  let tmpDir: string;
  let engine: KithEngine;
  const children: ChildProcess[] = [];

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kith-delta-test-'));
    git(tmpDir, ['init']);
    git(tmpDir, ['config', 'user.email', 'test@kith.dev']);
    git(tmpDir, ['config', 'user.name', 'Kith Test']);
    fs.mkdirSync(path.join(tmpDir, 'src'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'src/shared.ts'), 'export const a = 1;\n');
    git(tmpDir, ['add', '.']);
    git(tmpDir, ['commit', '-m', 'init']);
    engine = new KithEngine(tmpDir);
  });

  afterEach(() => {
    for (const child of children.splice(0)) child.kill();
    engine.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const blob = (text: string) => execFileSync('git', ['hash-object', '-w', '--stdin'], {
    cwd: tmpDir, input: text, encoding: 'utf8',
  }).trim();

  const livePid = () => {
    const child = spawn('sleep', ['60'], { stdio: 'ignore' });
    children.push(child);
    return child.pid!;
  };

  const insertConflict = (a: string, b: string, file: string) =>
    engine.coordDb.db.prepare(`INSERT INTO conflicts (id, agent_a, agent_b, file_path, severity, details_json, detected_at) VALUES (?, ?, ?, ?, 'text_conflict', ?, ?)`)
      .run(`c_${a}_${b}_${file}`, a, b, file, JSON.stringify({ reason: 'Git merge conflict requires explicit resolution' }), Date.now());

  it('does not class work committed through a temporary index as a conflict', () => {
    engine.fencing.registerAgent({ id: 'agent-1' });
    engine.fencing.registerAgent({ id: 'agent-2' });
    const one = 'export const a = 2;\n';
    engine.processPostFileEdit({ agentId: 'agent-1', filePath: 'src/shared.ts', content: one });
    fs.writeFileSync(path.join(tmpDir, 'src/shared.ts'), one);
    const env = { ...process.env, GIT_INDEX_FILE: path.join(tmpDir, '.git/tmp-index') };
    git(tmpDir, ['read-tree', 'HEAD'], env);
    git(tmpDir, ['add', 'src/shared.ts'], env);
    git(tmpDir, ['commit', '-m', 'via temp index'], env);

    const res = engine.processPostFileEdit({ agentId: 'agent-2', filePath: 'src/shared.ts', content: 'export const a = 3;\n' });
    expect(res.dirtyMergeConflicts).toHaveLength(0);
  });

  it('bounds the delta, reports only relevant conflicts, and never repeats it', () => {
    engine.fencing.registerAgent({ id: 'me' });
    for (let i = 0; i < 60; i++) {
      engine.fencing.registerAgent({ id: `peer-${i}` });
      insertConflict(`peer-${i}`, 'me', `src/other-${i}.ts`);
    }
    insertConflict('me', 'peer-0', 'src/mine.ts');

    const first = engine.consumeAgentDelta('me').formattedFooter;
    expect(first.length).toBeLessThan(1500);
    expect(first).toContain('src/mine.ts');
    expect(first).not.toContain('src/other-3.ts');
    expect(first).toContain('60');
    expect(first).toContain('kith status');
    expect(engine.consumeAgentDelta('me').formattedFooter).toBe('');

    insertConflict('me', 'peer-1', 'src/mine2.ts');
    const next = engine.consumeAgentDelta('me').formattedFooter;
    expect(next).toContain('src/mine2.ts');
    expect(next).not.toContain('src/mine.ts ');
  });

  it('drops conflicts held by idle sessions', () => {
    engine.fencing.registerAgent({ id: 'me' });
    engine.fencing.registerAgent({ id: 'idle' });
    insertConflict('me', 'idle', 'src/shared.ts');
    expect(engine.shadowGit.listConflicts()).toHaveLength(1);
    engine.coordDb.db.prepare(`UPDATE agents SET last_heartbeat_at = ? WHERE id = 'idle'`).run(Date.now() - 2 * 60 * 60 * 1000);
    expect(engine.shadowGit.listConflicts()).toHaveLength(0);
  });

  it('keeps a real overlap between subagents that share an owner pid, and between separate sessions', () => {
    engine.fencing.registerAgent({ id: 'sub-a' });
    engine.fencing.registerAgent({ id: 'sub-b' });
    const shared = engine.fencing.getAgent('sub-a')!;
    const sibling = engine.fencing.getAgent('sub-b')!;
    expect(shared.pid).toBe(sibling.pid);
    expect(shared.pid_start_time).toBe(sibling.pid_start_time);

    engine.processPostFileEdit({ agentId: 'sub-a', filePath: 'src/shared.ts', content: 'export const a = 2;\n' });
    const sameOwner = engine.processPostFileEdit({ agentId: 'sub-b', filePath: 'src/shared.ts', content: 'export const a = 3;\n' });
    expect(sameOwner.dirtyMergeConflicts.map((conflict) => conflict.file_path)).toEqual(['src/shared.ts']);
    expect(engine.shadowGit.listConflicts().map((conflict) => conflict.file_path)).toEqual(['src/shared.ts']);
    const probed = engine.shadowGit.lastConflictHygiene.mergeFileProbes;
    expect(probed).toBeGreaterThan(0);
    expect(engine.shadowGit.listConflicts().map((conflict) => conflict.file_path)).toEqual(['src/shared.ts']);
    expect(engine.shadowGit.lastConflictHygiene.mergeFileProbes).toBe(0);
    expect(engine.shadowGit.lastConflictHygiene.headReads).toBe(0);

    engine.fencing.registerAgent({ id: 'other-session', pid: livePid() });
    const separate = engine.processPostFileEdit({ agentId: 'other-session', filePath: 'src/shared.ts', content: 'export const a = 4;\n' });
    expect(separate.dirtyMergeConflicts.map((conflict) => conflict.file_path)).toContain('src/shared.ts');
  });

  it('does not drop a conflict just because the owner pid is missing or zero', () => {
    insertConflict('ghost-a', 'ghost-b', 'src/missing-owner.ts');
    expect(engine.shadowGit.listConflicts().map((conflict) => conflict.file_path)).toContain('src/missing-owner.ts');

    engine.fencing.registerAgent({ id: 'zero-a' });
    engine.fencing.registerAgent({ id: 'zero-b' });
    engine.coordDb.db.prepare(`UPDATE agents SET pid = 0 WHERE id IN ('zero-a', 'zero-b')`).run();
    insertConflict('zero-a', 'zero-b', 'src/zero-pid.ts');
    expect(engine.shadowGit.pruneFalseConflicts()).toBe(0);
    const remaining = engine.coordDb.db.prepare(`SELECT file_path FROM conflicts WHERE file_path = 'src/zero-pid.ts'`).all();
    expect(remaining).toEqual([{ file_path: 'src/zero-pid.ts' }]);
  });

  it('drops a stored conflict whose blob is already HEAD, or whose sides are identical, without merge probes', () => {
    engine.fencing.registerAgent({ id: 'me', pid: livePid() });
    engine.fencing.registerAgent({ id: 'peer', pid: livePid() });
    const headBlob = git(tmpDir, ['rev-parse', 'HEAD:src/shared.ts']);
    engine.coordDb.db.prepare(`INSERT INTO conflicts (id, agent_a, agent_b, file_path, severity, details_json, detected_at) VALUES ('c_head', 'me', 'peer', 'src/shared.ts', 'text_conflict', ?, ?)`)
      .run(JSON.stringify({ reason: 'stale', blobA: headBlob, blobB: 'a'.repeat(40) }), Date.now());
    engine.coordDb.db.prepare(`INSERT INTO conflicts (id, agent_a, agent_b, file_path, severity, details_json, detected_at) VALUES ('c_same', 'me', 'peer', 'src/same.ts', 'text_conflict', ?, ?)`)
      .run(JSON.stringify({ reason: 'stale', blobA: headBlob, blobB: headBlob }), Date.now());
    insertConflict('me', 'peer', 'src/real.ts');

    expect(engine.shadowGit.listConflicts().map((conflict) => conflict.file_path)).toEqual(['src/real.ts']);
    expect(engine.shadowGit.lastConflictHygiene.mergeFileProbes).toBe(0);
    expect(engine.shadowGit.lastConflictHygiene.removed).toBe(2);
  });

  it('drops a stored conflict git can merge, keeps one it cannot, and does not probe again', () => {
    engine.fencing.registerAgent({ id: 'me', pid: livePid() });
    engine.fencing.registerAgent({ id: 'peer', pid: livePid() });
    const base = blob('1\n2\n3\n4\n5\n6\n7\n8\n9\n');
    const ins = (id: string, file: string, ours: string, theirs: string) =>
      engine.coordDb.db.prepare(`INSERT INTO conflicts (id, agent_a, agent_b, file_path, severity, details_json, detected_at) VALUES (?, 'me', 'peer', ?, 'text_conflict', ?, ?)`)
        .run(id, file, JSON.stringify({ reason: 'x', baseBlob: base, blobA: blob(ours), blobB: blob(theirs) }), Date.now());
    ins('c1', 'src/clean.ts', 'one\n2\n3\n4\n5\n6\n7\n8\n9\n', '1\n2\n3\n4\n5\n6\n7\n8\nnine\n');
    ins('c2', 'src/bad.ts', '1\nA\n3\n4\n5\n6\n7\n8\n9\n', '1\nB\n3\n4\n5\n6\n7\n8\n9\n');

    expect(engine.shadowGit.listConflicts().map((conflict) => conflict.file_path)).toEqual(['src/bad.ts']);
    const probeDir = engine.shadowGit.lastConflictHygiene.probeDir;
    expect(probeDir).toBeTruthy();
    expect(fs.existsSync(probeDir!)).toBe(false);
    expect(probeDir!.includes(`${path.sep}.coord${path.sep}`)).toBe(false);
    const relative = path.relative(tmpDir, probeDir!);
    expect(relative.startsWith('..') || path.isAbsolute(relative)).toBe(true);
    expect(engine.shadowGit.lastConflictHygiene.mergeFileProbes).toBe(2);

    expect(engine.shadowGit.listConflicts().map((conflict) => conflict.file_path)).toEqual(['src/bad.ts']);
    expect(engine.shadowGit.lastConflictHygiene.mergeFileProbes).toBe(0);
    expect(engine.shadowGit.lastConflictHygiene.headReads).toBe(0);
  });

  it('spreads merge probes across later reads instead of repeating them', () => {
    engine.fencing.registerAgent({ id: 'me' });
    engine.fencing.registerAgent({ id: 'peer' });
    const base = blob('1\n2\n3\n4\n5\n6\n7\n8\n9\n');
    for (let i = 0; i < 3; i++) {
      engine.coordDb.db.prepare(`INSERT INTO conflicts (id, agent_a, agent_b, file_path, severity, details_json, detected_at) VALUES (?, 'me', 'peer', ?, 'text_conflict', ?, ?)`)
        .run(`clean-${i}`, `src/clean-${i}.ts`, JSON.stringify({
          reason: 'x', baseBlob: base, blobA: blob(`v${i}\n2\n3\n4\n5\n6\n7\n8\n9\n`), blobB: blob(`1\n2\n3\n4\n5\n6\n7\n8\n${i}\n`),
        }), Date.now());
    }
    expect(engine.shadowGit.pruneFalseConflicts(1)).toBe(1);
    expect(engine.shadowGit.lastConflictHygiene.mergeFileProbes).toBe(1);
    expect(engine.shadowGit.pruneFalseConflicts(1)).toBe(1);
    expect(engine.shadowGit.lastConflictHygiene.mergeFileProbes).toBe(1);
    expect(engine.shadowGit.pruneFalseConflicts()).toBe(1);
    expect(engine.shadowGit.listConflicts()).toEqual([]);
    expect(engine.shadowGit.lastConflictHygiene.mergeFileProbes).toBe(0);
  });

  it('drops a conflict whose blob landed in HEAD when kith commit moves HEAD', () => {
    engine.setWorkflowMode('main');
    const session = engine.fencing.registerAgent({ id: 'me' });
    engine.fencing.registerAgent({ id: 'peer', pid: livePid() });
    engine.locks.acquireLocks({ agentId: 'me', patterns: ['src/shared.ts'], lockType: 'file' });
    const next = 'export const a = 9;\n';
    fs.writeFileSync(path.join(tmpDir, 'src/shared.ts'), next);
    const committed = blob(next);
    engine.coordDb.db.prepare(`INSERT INTO conflicts (id, agent_a, agent_b, file_path, severity, details_json, detected_at) VALUES ('c_commit', 'me', 'peer', 'src/shared.ts', 'text_conflict', ?, ?)`)
      .run(JSON.stringify({ reason: 'temp index', blobA: committed, blobB: 'b'.repeat(40) }), Date.now());
    insertConflict('me', 'peer', 'src/untouched.ts');

    const result = engine.commit({
      agentId: 'me', sessionToken: session.sessionToken, message: 'land shared', files: ['src/shared.ts'],
    });
    expect(result.ok, result.error).toBe(true);
    const left = engine.coordDb.db.prepare(`SELECT file_path FROM conflicts ORDER BY file_path`).all();
    expect(left).toEqual([{ file_path: 'src/untouched.ts' }]);
  });
});
