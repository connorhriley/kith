import { execFileSync } from 'node:child_process';
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
    engine.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

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
});
