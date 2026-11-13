import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ignoredPaths } from '../src/core/git-ignore.js';
import { KithEngine } from '../src/index.js';

const LOG = 'scripts/stack/.state/logs/web.log';

describe('Git-ignored paths are not shared source', () => {
  let dir: string;
  let engine: KithEngine;
  const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' });

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kith-ignored-'));
    git('init');
    git('config', 'user.email', 't@kith.dev');
    git('config', 'user.name', 'T');
    fs.mkdirSync(path.join(dir, 'scripts/stack/.state/logs'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'src'));
    // The ignore rule lives in a nested .gitignore, as in the reported repository.
    fs.writeFileSync(path.join(dir, 'scripts/stack/.gitignore'), '.state/\n');
    fs.writeFileSync(path.join(dir, 'src/a.ts'), 'export const a = 1;\n');
    git('add', '.');
    git('commit', '-m', 'init');
    engine = new KithEngine(dir);
  });
  afterEach(() => { engine.close(); fs.rmSync(dir, { recursive: true, force: true }); });

  it('reports ignored paths from the ignore rules of the repository they belong to', () => {
    const nested = path.join(dir, 'vendor/inner');
    fs.mkdirSync(nested, { recursive: true });
    execFileSync('git', ['init'], { cwd: nested, stdio: 'ignore' });
    fs.writeFileSync(path.join(nested, '.gitignore'), 'out.log\n');
    expect(ignoredPaths(dir, [LOG, 'src/a.ts', 'vendor/inner/out.log', 'vendor/inner/keep.ts']))
      .toEqual(new Set([LOG, 'vendor/inner/out.log']));
  });

  it('never records a conflict on an ignored file, but still on source', () => {
    engine.fencing.registerAgent({ id: 'a1' });
    engine.fencing.registerAgent({ id: 'a2' });
    for (const [id, text] of [['a1', 'one\n'], ['a2', 'two\n']]) {
      fs.writeFileSync(path.join(dir, LOG), text);
      engine.processPostFileEdit({ agentId: id, filePath: LOG, content: text });
    }
    expect(engine.shadowGit.listConflicts()).toEqual([]);

    engine.processPostFileEdit({ agentId: 'a1', filePath: 'src/b.ts', content: 'export const b = 1;\n' });
    const res = engine.processPostFileEdit({ agentId: 'a2', filePath: 'src/b.ts', content: 'export const b = 2;\n' });
    expect(JSON.stringify(res)).toContain('src/b.ts');
    expect(engine.shadowGit.listConflicts().map(c => c.file_path)).toEqual(['src/b.ts']);
  });

  it('lets two agents write an ignored file and holds no lock on it', () => {
    engine.fencing.registerAgent({ id: 'a1' });
    engine.fencing.registerAgent({ id: 'a2' });
    const got = engine.locks.acquireLocks({ agentId: 'a1', patterns: [LOG, 'src/a.ts'], lockType: 'file' });
    expect(got.ok).toBe(true);
    expect(got.locks.map(l => l.pattern)).toEqual(['src/a.ts']);
    expect(engine.locks.checkFileWriteAccess({ agentId: 'a2', filePath: LOG }).allowed).toBe(true);
    expect(engine.locks.checkFileWriteAccess({ agentId: 'a2', filePath: 'src/a.ts' }).allowed).toBe(false);
    expect(engine.locks.acquireLocks({ agentId: 'a2', patterns: [LOG], lockType: 'file' }).ok).toBe(true);
  });

  it('clears conflicts and locks already recorded on ignored paths at the next reap', () => {
    engine.fencing.registerAgent({ id: 'a1' });
    engine.fencing.registerAgent({ id: 'a2' });
    const insert = (file: string) => engine.coordDb.db.prepare(
      `INSERT INTO conflicts (id, agent_a, agent_b, file_path, severity, details_json, detected_at) VALUES (?, 'a1', 'a2', ?, 'text_conflict', '{}', ?)`
    ).run(`c-${file}`, file, Date.now());
    insert(LOG);
    insert('src/a.ts');
    engine.coordDb.db.prepare(
      `INSERT INTO locks (id, pattern, lock_type, mode, owner_agent_id, fencing_token, reason, acquired_at, expires_at) VALUES ('l1', ?, 'file', 'exclusive', 'a1', 1, '', ?, ?)`
    ).run(LOG, Date.now(), Date.now() + 60_000);

    const fresh = new KithEngine(dir);
    try {
      fresh.fencing.reapDeadAgents();
      expect(fresh.shadowGit.listConflicts().map(c => c.file_path)).toEqual(['src/a.ts']);
      expect(fresh.coordDb.db.prepare('SELECT id FROM locks').all()).toEqual([]);
    } finally { fresh.close(); }
  });
});
