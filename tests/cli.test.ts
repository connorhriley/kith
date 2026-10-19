import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { initializeKithRepository } from '../src/cli/init.js';

let root: string;
const cli = path.resolve('dist/cli/index.js');
beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), "kith cli ' ")); });
afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });
function run(...args: string[]) {
  return spawnSync(process.execPath, [cli, ...args], { cwd: root, encoding: 'utf8', input: '' });
}
it('help, version, and invalid commands do not create local state', () => {
  expect(run('help').stdout).toContain('Usage:');
  expect(run('--version').stdout.trim()).toBe('1.0.0');
  const bad = run('typo');
  expect(bad.status).toBe(1); expect(bad.stderr).toContain('Unknown command');
  expect(fs.readdirSync(root)).toEqual([]);
});
it('previews setup and rejects an invalid integration without writes', () => {
  const preview = run('init', '--dry-run', '--only', 'agents');
  expect(preview.status).toBe(0); expect(JSON.parse(preview.stdout).dryRun).toBe(true);
  expect(run('init', '--only', 'typo').status).toBe(1);
  expect(fs.readdirSync(root)).toEqual([]);
});
it('returns blocking exit status when pre-tool processing fails', () => {
  // A file in place of a repo root makes opening local state fail.
  fs.writeFileSync(path.join(root, 'blocked'), 'file');
  const blocked = run('hook', 'pre', '--repo', path.join(root, 'blocked'));
  expect(blocked.status).toBe(2);
});
it('preserves literal arguments in the distributed mutex CLI and returns command failures', () => {
  const value = 'spaces ; $(echo changed) "literal"';
  const result = run('mutex', '--agent', 'cli-test', '--', process.execPath, '-e', 'process.stdout.write(process.argv[1])', value);
  expect(result.status).toBe(0); expect(result.stdout).toBe(value);
  expect(run('mutex', '--agent', 'cli-test', '--', process.execPath, '-e', 'process.exit(7)').status).toBe(7);
});
it('package shims resolve the real executable without recursing and preserve arguments', () => {
  initializeKithRepository(root, 'kith', { integrations: ['shims'] });
  const bin = path.join(root, 'fake-bin'); fs.mkdirSync(bin);
  for (const name of ['npm', 'kith']) {
    fs.writeFileSync(path.join(bin, name), '#!/usr/bin/env node\nprocess.stdout.write(JSON.stringify(process.argv.slice(2)));\n', { mode: 0o755 });
  }
  const shim = path.join(root, '.coord/bin/npm');
  const env = { ...process.env, PATH: `${path.dirname(shim)}:${bin}:${process.env.PATH}` };
  expect(JSON.parse(execFileSync(shim, ['--version'], { env, encoding: 'utf8', timeout: 5000 }))).toEqual(['--version']);
  const installed = JSON.parse(execFileSync(shim, ['install', 'some package'], { env, encoding: 'utf8', timeout: 5000 }));
  expect(installed.slice(-3)).toEqual(['npm', 'install', 'some package']);
  expect(installed).toContain(root);
});


it('blocks malformed hook input and edit payloads missing a file path', () => {
  const bad = spawnSync(process.execPath, [cli, 'hook', 'pre'], { cwd: root, encoding: 'utf8', input: '{' });
  expect(bad.status).toBe(2);
  expect(bad.stderr).toContain('hook input');
  expect(run('hook', 'pre', '--tool', 'Edit').status).toBe(2);
});
