import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { HookHandler } from '../src/cli/hook-handler.js';
import { initializeKithRepository } from '../src/cli/init.js';
import { KithEngine } from '../src/index.js';
import { renderDashboardFrame } from '../src/tui/dashboard.js';

describe('Bash Merkle Quarantine, Port/Mutex Broker, Auto-Installer & TUI', () => {
  let tmpDir: string;
  let engine: KithEngine;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kith-quarantine-test-'));
    execFileSync('git', ['init'], { cwd: tmpDir });
    fs.mkdirSync(path.join(tmpDir, 'src'), { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, 'src/protected.ts'),
      `export const SECRET_KEY = 'original-safe-value';\n`,
      'utf8'
    );
    engine = new KithEngine(tmpDir);
  });

  afterEach(() => {
    engine.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('blocks direct writes and saves Bash recovery copies without reverting shared bytes', () => {
    engine.fencing.registerAgent({ id: 'owner-agent' });
    engine.fencing.registerAgent({ id: 'rogue-agent' });

    // owner-agent locks src/protected.ts
    engine.locks.acquireLocks({
      agentId: 'owner-agent',
      patterns: ['src/protected.ts'],
      reason: 'Security config work',
    });

    const hook = new HookHandler(engine);

    // 1. Direct Edit tool call by rogue-agent is blocked at PreToolUse
    const preEdit = hook.handlePreToolUse({
      agentId: 'rogue-agent',
      toolName: 'Edit',
      filePath: 'src/protected.ts',
    });
    expect(preEdit.allowed).toBe(false);
    expect(preEdit.exitCode).toBe(2);

    // 2. Destructive git reset --hard in shared workspace is blocked at PreToolUse
    const preReset = hook.handlePreToolUse({
      agentId: 'rogue-agent',
      toolName: 'Bash',
      command: 'git reset --hard HEAD~1',
    });
    expect(preReset.allowed).toBe(false);
    expect(preReset.exitCode).toBe(2);

    // 3. rogue-agent runs a seemingly innocent bash script that secretly overwrites src/protected.ts
    const preBash = hook.handlePreToolUse({
      agentId: 'rogue-agent',
      toolName: 'Bash',
      command: 'node -e "fs.writeFileSync(\'src/protected.ts\', \'CORRUPTED\')"',
    });
    expect(preBash.allowed).toBe(true);

    // Simulate the bash script mutating src/protected.ts on disk
    fs.writeFileSync(path.join(tmpDir, 'src/protected.ts'), 'CORRUPTED BY BASH\n', 'utf8');

    // PostToolUse detects a locked-file change and saves recovery copies.
    const postBash = hook.handlePostToolUse({
      agentId: 'rogue-agent',
      toolName: 'Bash',
      command: 'node -e "fs.writeFileSync(\'src/protected.ts\', \'CORRUPTED\')"',
    });

    expect(postBash.allowed).toBe(false);
    expect(postBash.exitCode).toBe(2);
    expect(postBash.warnings[0]).toContain('KITH BASH QUARANTINE');

    // Shared-file restoration is disabled because changes cannot be safely attributed.
    const restoredContent = fs.readFileSync(path.join(tmpDir, 'src/protected.ts'), 'utf8');
    expect(restoredContent).toBe('CORRUPTED BY BASH\n');

    // Verify quarantined copy exists so work is still inspectable
    const quarantinedList = engine.bashGuard.listQuarantined();
    expect(quarantinedList).toHaveLength(1);
    expect(fs.readFileSync(quarantinedList[0].patch_path, 'utf8')).toBe('CORRUPTED BY BASH\n');
    expect(fs.readFileSync(quarantinedList[0].patch_path + '.before', 'utf8')).toBe(`export const SECRET_KEY = 'original-safe-value';\n`);
  });

  it('allocates collision-free TCP ports and serializes commands via mutexes', async () => {
    engine.fencing.registerAgent({ id: 'agent-1' });
    engine.fencing.registerAgent({ id: 'agent-2' });

    const p1 = await engine.broker.acquirePort({
      agentId: 'agent-1',
      serviceName: 'web',
      basePort: 4200,
    });
    const p2 = await engine.broker.acquirePort({
      agentId: 'agent-2',
      serviceName: 'web',
      basePort: 4200,
    });

    expect(p1.port).toBeGreaterThanOrEqual(4200);
    expect(p2.port).toBeGreaterThanOrEqual(4200);
    expect(p1.port).not.toBe(p2.port);

    // Mutex FIFO queue test
    const m1 = engine.broker.tryAcquireMutex({
      agentId: 'agent-1',
      mutexName: 'package-install',
    });
    expect(m1.acquired).toBe(true);

    const m2 = engine.broker.tryAcquireMutex({
      agentId: 'agent-2',
      mutexName: 'package-install',
    });
    expect(m2.acquired).toBe(false);
    expect(m2.holderAgentId).toBe('agent-1');
    expect(m2.queuePosition).toBe(1);

    engine.broker.releaseMutex({
      agentId: 'agent-1',
      mutexName: 'package-install',
      fencingToken: m1.fencingToken,
    });

    const m2Retry = engine.broker.tryAcquireMutex({
      agentId: 'agent-2',
      mutexName: 'package-install',
    });
    expect(m2Retry.acquired).toBe(true);
  });

  it('auto-installs Claude Code, Cursor, Antigravity, AGENTS.md, Git hooks, and renders the TUI dashboard', () => {
    const report = initializeKithRepository(tmpDir);
    expect(report.configuredFiles).toContain('.claude/settings.json');
    expect(report.configuredFiles).toContain('.cursor/mcp.json');
    expect(report.configuredFiles).toContain('.agent/skills/kith/SKILL.md');
    expect(report.configuredFiles).toContain('AGENTS.md');
    expect(report.configuredFiles.some((file) => file.endsWith('/hooks/pre-commit'))).toBe(true);

    const frame = renderDashboardFrame(engine);
    expect(frame).toContain('KITH — PARALLEL AGENT COORDINATOR');
    expect(frame).toContain('LIVE DIRTY-TREE & BLAST-RADIUS RADAR');
  });
});
