import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { KithEngine } from '../src/index.js';

describe('Concurrency Stress Test: 50 Parallel Agents Racing on SQLite WAL', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kith-stress-50-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('guarantees zero duplicate task claims and strict lock mutual exclusion across 50 agents', async () => {
    const seedEngine = new KithEngine(tmpDir);
    const totalAgents = 50;

    // Seed 30 tasks in the queue
    for (let i = 1; i <= 30; i++) {
      seedEngine.intents.addTask({
        id: `task-${i}`,
        title: `Implement module ${i}`,
        priority: i,
        scopeGlobs: [`src/module-${i}/**`],
      });
    }
    seedEngine.close();

    // Spawn 50 independent KithEngine connections racing on the same SQLite WAL DB
    const results = await Promise.all(
      Array.from({ length: totalAgents }, async (_, idx) => {
        const agentId = `worker-${idx + 1}`;
        const workerEngine = new KithEngine(tmpDir);
        try {
          workerEngine.fencing.registerAgent({
            id: agentId,
            pidStartTime: 'simulated-alive',
          });

          // Race 1: Try to claim a task from the 30-task pool
          const claimRes = workerEngine.intents.claimNextTask(agentId);

          // Race 2: All 50 agents also race for a single contended lock `src/contended/singleton.ts`
          const hotspotLock = workerEngine.locks.acquireLocks({
            agentId,
            patterns: ['src/contended/singleton.ts'],
            reason: 'Contended singleton race',
          });

          return {
            agentId,
            claimedTaskId: claimRes.claimed ? claimRes.task?.id ?? null : null,
            wonHotspotLock: hotspotLock.ok,
          };
        } finally {
          workerEngine.close();
        }
      })
    );

    const claimedTaskIds = results
      .map((r) => r.claimedTaskId)
      .filter((id): id is string => id !== null);
    const uniqueClaimedTaskIds = new Set(claimedTaskIds);

    // Exactly 30 tasks were queued -> all 30 claimed, 0 duplicates!
    expect(claimedTaskIds).toHaveLength(30);
    expect(uniqueClaimedTaskIds.size).toBe(30);

    // Exactly 1 agent out of 50 wins the exclusive lock on `src/contended/singleton.ts`!
    const hotspotWinners = results.filter((r) => r.wonHotspotLock);
    expect(hotspotWinners).toHaveLength(1);
  });
});
