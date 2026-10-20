import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import { KithEngine } from '../src/index.js';
const base = 'export function base() { return 1; }\n';
const left = 'export function left() { return 2; }\n';
const right = 'export function right() { return 3; }\n';

it('preserves tracked executable mode in shadow reports', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kith-mode-'));
  const git = (...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  let engine: KithEngine | undefined;
  try {
    git('init'); git('config', 'user.name', 'Kith'); git('config', 'user.email', 'kith@example.test');
    fs.writeFileSync(path.join(root, 'script.ts'), base, { mode: 0o755 }); git('add', '.'); git('commit', '-m', 'seed');
    engine = new KithEngine(root); engine.fencing.registerAgent({ id: 'a' });
    engine.processPostFileEdit({ agentId: 'a', filePath: 'script.ts', content: base + left });
    const agent = engine.fencing.getAgent('a')!;
    expect(git('ls-tree', agent.shadow_tree_sha!, 'script.ts')).toMatch(/^100755 /);
  } finally { engine?.close(); fs.rmSync(root, { recursive: true, force: true }); }
});

it('leaves a conflicted symlink for explicit resolution and preserves the target checkout', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kith-link-merge-'));
  const git = (...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  let engine: KithEngine | undefined;
  try {
    git('init'); git('config', 'user.name', 'Kith'); git('config', 'user.email', 'kith@example.test');
    fs.writeFileSync(path.join(root, '.gitignore'), '.coord/\n');
    fs.symlinkSync('original', path.join(root, 'link.json')); git('add', '.'); git('commit', '-m', 'seed');
    engine = new KithEngine(root); engine.fencing.registerAgent({ id: 'a' });
    const wt = engine.worktrees.spawnWorktree({ agentId: 'a' });
    fs.unlinkSync(path.join(wt.worktreePath, 'link.json')); fs.symlinkSync('theirs', path.join(wt.worktreePath, 'link.json'));
    fs.unlinkSync(path.join(root, 'link.json')); fs.symlinkSync('ours', path.join(root, 'link.json')); git('add', '.'); git('commit', '-m', 'ours');
    const before = git('rev-parse', 'HEAD');
    const result = engine.mergeTrain.enqueueAndMerge({ agentId: 'a', branch: wt.branch, worktreePath: wt.worktreePath });
    expect(result.merged).toBe(false); expect(result.diagnostics).toContain('link.json');
    expect(git('rev-parse', 'HEAD')).toBe(before); expect(fs.readlinkSync(path.join(root, 'link.json'))).toBe('ours');
  } finally { engine?.close(); fs.rmSync(root, { recursive: true, force: true }); }
});

it('preserves source and target on conflicts with tabs/newlines in filenames', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kith-filename-'));
  const filename = 'odd[bracket]*\tname\nfile.ts';
  const git = (...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  let engine: KithEngine | undefined;
  try {
    git('init'); git('config', 'user.name', 'Kith'); git('config', 'user.email', 'kith@example.test');
    fs.writeFileSync(path.join(root, '.gitignore'), '.coord/\n'); fs.writeFileSync(path.join(root, filename), base);
    git('add', '.'); git('commit', '-m', 'seed');
    engine = new KithEngine(root); engine.fencing.registerAgent({ id: 'a' });
    const wt = engine.worktrees.spawnWorktree({ agentId: 'a' });
    fs.writeFileSync(path.join(wt.worktreePath, filename), base + right);
    fs.writeFileSync(path.join(root, filename), base + left); git('add', '.'); git('commit', '-m', 'ours');
    const result = engine.mergeTrain.enqueueAndMerge({ agentId: 'a', branch: wt.branch, worktreePath: wt.worktreePath });
    expect(result.merged).toBe(false);
    expect(result.diagnostics).toContain(JSON.stringify(filename));
    expect(fs.readFileSync(path.join(root, filename), 'utf8')).toBe(base + left);
    expect(fs.readFileSync(path.join(wt.worktreePath, filename), 'utf8')).toBe(base + right);
  } finally { engine?.close(); fs.rmSync(root, { recursive: true, force: true }); }
});


it('preserves non-UTF-8 conflict bytes instead of auto-resolving replacement characters', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kith-encoding-'));
  const git = (...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  let engine: KithEngine | undefined;
  try {
    git('init'); git('config', 'user.name', 'Kith'); git('config', 'user.email', 'kith@example.test');
    const rawBase = Buffer.concat([Buffer.from('// '), Buffer.from([255]), Buffer.from('\n' + base)]);
    fs.writeFileSync(path.join(root, '.gitignore'), '.coord/\n'); fs.writeFileSync(path.join(root, 'file.ts'), rawBase);
    git('add', '.'); git('commit', '-m', 'seed');
    engine = new KithEngine(root); engine.fencing.registerAgent({ id: 'a' });
    const wt = engine.worktrees.spawnWorktree({ agentId: 'a' });
    fs.writeFileSync(path.join(wt.worktreePath, 'file.ts'), Buffer.concat([rawBase, Buffer.from(right)]));
    const ours = Buffer.concat([rawBase, Buffer.from(left)]);
    fs.writeFileSync(path.join(root, 'file.ts'), ours); git('add', '.'); git('commit', '-m', 'ours');
    const before = git('rev-parse', 'HEAD');
    expect(engine.mergeTrain.enqueueAndMerge({ agentId: 'a', branch: wt.branch, worktreePath: wt.worktreePath }).merged).toBe(false);
    expect(git('rev-parse', 'HEAD')).toBe(before);
    expect(fs.readFileSync(path.join(root, 'file.ts'))).toEqual(ours);
  } finally { engine?.close(); fs.rmSync(root, { recursive: true, force: true }); }
});
