import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { KithEngine, StaleFencingTokenError } from '../src/index.js';

describe('Pillar 1 & 6: Monotonic Fencing Tokens, Dead-PID Reaper, Glob Locks & DAG Queue', () => {
  let tmpDir: string;
  let engine: KithEngine;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kith-fencing-test-'));
    engine = new KithEngine(tmpDir);
  });

  afterEach(() => {
    engine.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('issues strictly increasing fencing tokens and rejects stale zombie tokens', () => {
    const regA = engine.fencing.registerAgent({
      id: 'claude-1',
      client: 'claude-code',
    });

    const lock1 = engine.locks.acquireLocks({
      agentId: 'claude-1',
      patterns: ['src/auth/**'],
      reason: 'Auth refactor',
    });
    expect(lock1.ok).toBe(true);
    expect(lock1.fencingToken).toBeGreaterThan(regA.fencingToken);

    // Re-acquiring increments fencing token
    const lock2 = engine.locks.acquireLocks({
      agentId: 'claude-1',
      patterns: ['src/auth/**'],
      reason: 'Updated auth lock',
    });
    expect(lock2.ok).toBe(true);
    expect(lock2.fencingToken).toBeGreaterThan(lock1.fencingToken);

    // Presenting the old fencing token is deterministically rejected
    expect(() =>
      engine.locks.checkFileWriteAccess({
        agentId: 'claude-1',
        filePath: 'src/auth/jwt.ts',
        fencingToken: lock1.fencingToken,
      })
    ).toThrow(StaleFencingTokenError);

    // Presenting the current fencing token succeeds
    const validCheck = engine.locks.checkFileWriteAccess({
      agentId: 'claude-1',
      filePath: 'src/auth/jwt.ts',
      fencingToken: lock2.fencingToken,
    });
    expect(validCheck.allowed).toBe(true);
  });

  it('detects glob-to-glob, glob-to-file, and symbol lock overlaps across agents', () => {
    engine.fencing.registerAgent({ id: 'agent-a' });
    engine.fencing.registerAgent({ id: 'agent-b' });

    const acqA = engine.locks.acquireLocks({
      agentId: 'agent-a',
      patterns: ['src/billing/**'],
      reason: 'Stripe webhook handler',
    });
    expect(acqA.ok).toBe(true);

    // Agent B tries to lock a concrete file inside src/billing/**
    const acqB1 = engine.locks.acquireLocks({
      agentId: 'agent-b',
      patterns: ['src/billing/stripe.ts'],
    });
    expect(acqB1.ok).toBe(false);
    expect(acqB1.conflicts).toHaveLength(1);
    expect(acqB1.conflicts[0].existingLock.owner_agent_id).toBe('agent-a');

    // Agent B tries to lock an overlapping wildcard glob src/**/*.ts
    const acqB2 = engine.locks.acquireLocks({
      agentId: 'agent-b',
      patterns: ['src/**/*.ts'],
    });
    expect(acqB2.ok).toBe(false);

    // Agent B locks an orthogonal directory src/notifications/** -> succeeds
    const acqB3 = engine.locks.acquireLocks({
      agentId: 'agent-b',
      patterns: ['src/notifications/**'],
    });
    expect(acqB3.ok).toBe(true);
  });

  it('automatically reaps locks and re-queues tasks when an agent PID dies', async () => {
    const processOwner = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
    // Use an actual process identity and death, not a production sentinel.
    engine.fencing.registerAgent({
      id: 'agent-crash',
      pid: processOwner.pid!
    });

    const t1 = engine.intents.addTask({
      id: 'task-1',
      title: 'Build database migration runner',
      scopeGlobs: ['src/db/**'],
    });
    expect(t1.status).toBe('queued');

    const claimed = engine.intents.claimNextTask('agent-crash');
    expect(claimed.claimed).toBe(true);
    expect(engine.locks.listLocks()).toHaveLength(1);

    processOwner.kill('SIGKILL');
    await once(processOwner, 'exit');

    // Live agent-rescuer arrives and claims next task -> dead agent is reaped automatically!
    engine.fencing.registerAgent({
      id: 'agent-rescuer'
    });

    const rescued = engine.intents.claimNextTask('agent-rescuer');
    expect(rescued.claimed).toBe(true);
    expect(rescued.task?.id).toBe('task-1');
    expect(rescued.task?.owner_agent_id).toBe('agent-rescuer');
  });

  it('prevents semantic duplicate intents in P2P mode even when file globs differ', () => {
    engine.fencing.registerAgent({ id: 'claude-1' });
    engine.fencing.registerAgent({ id: 'codex-2' });

    const res1 = engine.intents.declareIntent({
      agentId: 'claude-1',
      title: 'Implement JWT authentication middleware and token verification',
      scopeGlobs: ['src/middleware/**'],
    });
    expect(res1.ok).toBe(true);

    // Codex-2 tries to build the same thing in a different folder (`src/security/**`)
    const res2 = engine.intents.declareIntent({
      agentId: 'codex-2',
      title: 'Add JWT auth token verification middleware',
      scopeGlobs: ['src/security/**'],
    });
    expect(res2.ok).toBe(false);
    expect(res2.semanticOverlaps.length).toBeGreaterThan(0);
    expect(res2.semanticOverlaps[0].ownerAgentId).toBe('claude-1');
  });

  it('enforces DAG task dependencies and rejects circular graphs', () => {
    engine.intents.addTask({
      id: 'schema',
      title: 'Create user schema',
      priority: 10,
      scopeGlobs: ['src/db/schema.ts'],
    });
    engine.intents.addTask({
      id: 'api',
      title: 'Create user API endpoint',
      priority: 100, // higher priority, but blocked by `schema`!
      dependsOn: ['schema'],
      scopeGlobs: ['src/api/users.ts'],
    });

    expect(() =>
      engine.intents.addTask({
        id: 'self-dep',
        title: 'Invalid',
        dependsOn: ['self-dep'],
      })
    ).toThrow(/cannot depend on itself/);

    engine.fencing.registerAgent({ id: 'worker-1' });
    const firstClaim = engine.intents.claimNextTask('worker-1');
    expect(firstClaim.claimed).toBe(true);
    expect(firstClaim.task?.id).toBe('schema');

    // Finish `schema`, now `api` becomes unblocked
    engine.intents.completeTask({ agentId: 'worker-1', taskId: 'schema' });

    const secondClaim = engine.intents.claimNextTask('worker-1');
    expect(secondClaim.claimed).toBe(true);
    expect(secondClaim.task?.id).toBe('api');
  });
});
