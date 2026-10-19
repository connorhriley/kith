import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import { AstAnalyzer, KithEngine } from '../src/index.js';
const base = 'export function base() { return 1; }\n';
const left = 'export function left() { return 2; }\n';
const right = 'export function right() { return 3; }\n';

it('retains complete named declarations and type-only additions without executing appended source', () => {
  const a = base + left + 'export interface Left { value: string }\n';
  const b = base + right + 'export type Right = number;\n';
  const result = AstAnalyzer.checkAdditiveMergeability('file.ts', base, a, b);
  expect(result.autoMergeable).toBe(true);
  expect(result.mergedContent).toBe(a + '\n' + b.slice(base.length));
});

it.each([
  ['import', "import { value } from './value.js';\n" + left],
  ['top-level call', 'register();\n' + left],
  ['initializer', 'export const sideEffect = register();\n' + left],
  ['class initializer', 'export class Thing { static x = register(); }\n' + left],
  ['default export', 'export default function left() {}\n'],
  ['export alias', 'export { base as another };\n' + left],
  ['duplicate declaration', left + left],
  ['parse error', 'export function left() {\n'],
  ['unterminated comment', left + '/* open'],
  ['decorator', '@register\nexport class Left {}\n' + left],
  ['namespace', 'export namespace Left { export const x=register(); }\n' + left],
])('keeps %s additions as conflicts', (_name, suffix) => {
  expect(AstAnalyzer.checkAdditiveMergeability('file.ts', base, base + suffix, base + right).autoMergeable).toBe(false);
});

it('rejects hoisting, imported-binding collisions, cross-branch references and incomplete boundaries', () => {
  for (const [original, a, b] of [
    ['import { left } from "mod";\n' + base, left, right],
    ['console.log(typeof left);\n' + base, left, right],
    [base, 'export function left() { return right(); }\n', right],
    [base, left, 'export function right() { return typeof left; }\n'],
    [base.trimEnd(), left, right],
  ]) expect(AstAnalyzer.checkAdditiveMergeability('file.ts', original, original + a, original + b).autoMergeable).toBe(false);
  expect(AstAnalyzer.checkAdditiveMergeability('file.py', base, base + left, base + right).autoMergeable).toBe(false);
  expect(AstAnalyzer.checkAdditiveMergeability('file.ts', base, base + left, base + 'export function left() { return 5; }\n').autoMergeable).toBe(false);
});

it('rejects lossy or ambiguous JSON and preserves prototype-like keys as ordinary data', () => {
  for (const text of ['{"x":1,"x":2}', '{"nested":{"x":1,"x":2}}', '{"x":9007199254740993}', '{"x":1e999}', '{"x":0.10000000000000001}', '{"x":1e-999}', '{"x":-0}']) {
    expect(AstAnalyzer.checkAdditiveMergeability('file.json', '{}', text, '{"right":1}').autoMergeable).toBe(false);
  }
  const result = AstAnalyzer.checkAdditiveMergeability('file.json', '{}', '{"__proto__":{"polluted":true}}', '{"right":1}');
  expect(result.autoMergeable).toBe(true);
  expect(JSON.parse(result.mergedContent!).__proto__).toEqual({ polluted: true });
  expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  expect(AstAnalyzer.checkAdditiveMergeability('file.json', '{}', '{"x":1.5}', '{"right":1}').autoMergeable).toBe(true);
});

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
    expect(result.merged).toBe(false); expect(result.diagnostics).toContain('symlink');
    expect(git('rev-parse', 'HEAD')).toBe(before); expect(fs.readlinkSync(path.join(root, 'link.json'))).toBe('ours');
  } finally { engine?.close(); fs.rmSync(root, { recursive: true, force: true }); }
});

it('resolves ordinary conflicts with tabs/newlines in filenames through NUL-delimited Git paths', () => {
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
    expect(result.merged).toBe(true); expect(result.autoResolvedFiles).toEqual([filename]);
    expect(fs.readFileSync(path.join(root, filename), 'utf8')).toBe(base + left + '\n' + right);
  } finally { engine?.close(); fs.rmSync(root, { recursive: true, force: true }); }
});


it('refuses TypeScript syntax in JavaScript and binary or oversized conflicts', () => {
  expect(AstAnalyzer.checkAdditiveMergeability('file.js', base, base + 'export function left(x: number) {}\n', base + right).autoMergeable).toBe(false);
  expect(AstAnalyzer.checkAdditiveMergeability('file.ts', base, base + left + '\0', base + right).autoMergeable).toBe(false);
  expect(AstAnalyzer.checkAdditiveMergeability('file.ts', '', ' '.repeat(1_048_577), right).autoMergeable).toBe(false);
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
