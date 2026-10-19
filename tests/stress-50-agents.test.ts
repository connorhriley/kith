import { spawn, ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { expect, it } from 'vitest';
import { KithEngine } from '../src/index.js';

it('30 tasks and one exclusive lock have unique owners across 50 simultaneous processes', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kith-process-race-'));
  const children: ChildProcess[] = [];
  const engine = new KithEngine(root);
  try {
    for (let i = 0; i < 30; i++) {
      engine.intents.addTask({ id: `task-${i}`, title: `Module ${i}`, scopeGlobs: [`src/m${i}/**`] });
    }
    const library = pathToFileURL(path.resolve('dist/index.js')).href;
    const worker = `
      import { KithEngine } from ${JSON.stringify(library)};
      const engine = new KithEngine(process.argv[1]);
      const id = process.argv[2];
      // Sessions belong to the test coordinator, which remains alive after workers exit.
      engine.fencing.registerAgent({ id, pid: process.ppid });
      process.send({ ready: true });
      process.once('message', () => {
        try {
          const task = engine.intents.claimNextTask(id);
          const lock = engine.locks.acquireLocks({ agentId: id, patterns: ['hotspot.ts'] });
          process.send({ task: task.task?.id ?? null, lock: lock.ok });
        } finally { engine.close(); process.disconnect(); }
      });
    `;
    const ready: Promise<void>[] = [];
    const results = Array.from({ length: 50 }, (_, i) => {
      const child = spawn(process.execPath, ['--input-type=module', '-e', worker, root, `worker-${i}`], {
        stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
      });
      children.push(child);
      let markReady: () => void;
      let failReady: (err: Error) => void;
      ready.push(new Promise<void>((resolve, reject) => { markReady = resolve; failReady = reject; }));
      return new Promise<{ task: string | null; lock: boolean }>((resolve, reject) => {
        let error = '';
        let result: { task: string | null; lock: boolean } | undefined;
        child.stderr!.on('data', (chunk) => { error += chunk; });
        child.on('message', (msg: any) => {
          if (msg.ready) markReady(); else result = msg;
        });
        child.on('error', (err) => { failReady(err); reject(err); });
        child.on('exit', (code) => {
          if (code === 0 && result) resolve(result);
          else {
            const err = new Error(`Worker ${i} exited ${code}: ${error}`);
            failReady(err); reject(err);
          }
        });
      });
    });
    // Attach rejection handlers before waiting for all workers to initialize.
    const allResults = Promise.all(results);
    void allResults.catch(() => {});
    await Promise.all(ready);
    for (const child of children) child.send('go');
    const outcomes = await allResults;
    const claimed = outcomes.map((r) => r.task).filter(Boolean);
    expect(claimed).toHaveLength(30);
    expect(new Set(claimed).size).toBe(30);
    expect(outcomes.filter((r) => r.lock)).toHaveLength(1);
    expect(engine.intents.listTasks({ status: 'active' })).toHaveLength(30);
  } finally {
    for (const child of children) if (child.exitCode === null) child.kill();
    engine.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
}, 120_000);
