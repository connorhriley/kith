import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { PassiveConflictWatcher } from '../src/core/watcher.js';
import { autoConfigureAllClients } from '../src/cli/setup-auto.js';

let tempRoot: string;

beforeEach(() => {
  tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kith-watcher-test-'));
});

afterEach(() => {
  fs.rmSync(tempRoot, { recursive: true, force: true });
});

it('discovers git repositories and reports active file modifications', async () => {
  const repoA = path.join(tempRoot, 'repo-a');
  const repoB = path.join(tempRoot, 'repo-b');
  fs.mkdirSync(repoA);
  fs.mkdirSync(repoB);

  execFileSync('git', ['init'], { cwd: repoA });
  execFileSync('git', ['init'], { cwd: repoB });

  const watcher = new PassiveConflictWatcher(tempRoot);
  const discovered = watcher.discoverGitRepos();
  expect(discovered.sort()).toEqual([repoA, repoB].sort());

  // Create dirty files
  fs.writeFileSync(path.join(repoA, 'service.ts'), 'export function a() {}');
  fs.writeFileSync(path.join(repoB, 'service.ts'), 'export function b() {}');

  const collisions = await watcher.scanOnce();
  expect(collisions.length).toBeGreaterThan(0);
  const col = collisions.find((c) => c.filePath === 'service.ts');
  expect(col).toBeDefined();
  expect(col?.severity).toBe('collision');
  expect(col?.repos).toEqual(['repo-a', 'repo-b']);
});

it('autoConfigureAllClients writes valid client configs without corruption', () => {
  const mockHome = path.join(tempRoot, 'home');
  const mockWorkspace = path.join(tempRoot, 'workspace');
  fs.mkdirSync(mockHome, { recursive: true });
  fs.mkdirSync(mockWorkspace, { recursive: true });

  const results = autoConfigureAllClients(mockWorkspace);
  expect(Array.isArray(results)).toBe(true);
  expect(results.length).toBeGreaterThanOrEqual(3);

  // Check cursor workspace config was generated
  const cursorMcp = path.join(mockWorkspace, '.cursor', 'mcp.json');
  expect(fs.existsSync(cursorMcp)).toBe(true);
  const parsed = JSON.parse(fs.readFileSync(cursorMcp, 'utf8'));
  expect(parsed.mcpServers?.kith).toBeDefined();
});
