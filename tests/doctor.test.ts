import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { KithEngine } from '../src/index.js';
import { doctorReport } from '../src/cli/doctor.js';
import { initializeKithRepository } from '../src/cli/init.js';

// Doctor should tell a user what is wrong and what to do, and stay quiet about history and non-participation.

let root: string;
let engine: KithEngine;
const git = (...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kith-doctor-')));
  git('init', '-b', 'main'); git('config', 'user.email', 't@example.test'); git('config', 'user.name', 'T');
  fs.writeFileSync(path.join(root, '.gitignore'), '.coord/\n'); fs.writeFileSync(path.join(root, 'a.ts'), 'export const a = 1;\n');
  git('add', '.'); git('commit', '-m', 'seed');
  engine = new KithEngine(root);
});
afterEach(() => { vi.unstubAllEnvs(); engine.close(); fs.rmSync(root, { recursive: true, force: true }); });
const check = (name: string) => doctorReport(root, root).checks.find(c => c.name === name);
const withWorktree = (id: string) => {
  engine.fencing.registerAgent({ id });
  const { worktreePath } = engine.worktrees.spawnWorktree({ agentId: id });
  return worktreePath;
};

it('treats an ended session whose worktree was removed as history, not a failure', () => {
  const worktree = withWorktree('ghost');
  engine.fencing.abandonAgentSession('ghost');
  fs.rmSync(worktree, { recursive: true, force: true });
  const result = check('workspace:ghost');
  expect(result?.ok).toBe(true);
  expect(result?.detail).toContain('Retired');
  expect(result?.detail).toContain('no longer exists');
  expect(result?.detail).not.toContain('ENOENT');
});

it('still fails, with a plain explanation, when a live session loses its worktree', () => {
  const worktree = withWorktree('live');
  fs.rmSync(worktree, { recursive: true, force: true });
  const result = check('workspace:live');
  expect(result?.ok).toBe(false);
  expect(result?.detail).toContain('Worktree is missing');
  expect(result?.detail).toContain('restore the directory or end the session');
});

it('does not fail a shell that has no Kith session, now that hooks pass through', () => {
  initializeKithRepository(root, 'kith', { integrations: ['claude'], mcpOnly: false });
  vi.stubEnv('KITH_AGENT_ID', ''); vi.stubEnv('KITH_SESSION_TOKEN', '');
  const result = check('session-environment');
  expect(result?.ok).toBe(true);
  expect(result?.detail).toContain('allow everything');
});

it('still fails a shell that names a session it does not hold', () => {
  initializeKithRepository(root, 'kith', { integrations: ['claude'], mcpOnly: false });
  vi.stubEnv('KITH_AGENT_ID', 'nobody'); vi.stubEnv('KITH_SESSION_TOKEN', 'forged');
  expect(check('session-environment')?.ok).toBe(false);
});
