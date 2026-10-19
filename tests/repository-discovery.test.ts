import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { KithEngine, LockEngine, AstAnalyzer, caseSensitivePaths, discoverRepository, repositoryFile } from '../src/index.js';
import { initializeKithRepository } from '../src/cli/init.js';
import { HookHandler } from '../src/cli/hook-handler.js';

let temp: string, root: string;
const engines: KithEngine[] = [];
const open = (dir: string) => { const engine = new KithEngine(dir); engines.push(engine); return engine; };
const git = (dir: string, ...args: string[]) => execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
beforeEach(() => {
  temp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kith-discovery-')));
  root = path.join(temp, 'project with spaces'); fs.mkdirSync(root);
  git(root, 'init'); git(root, 'config', 'user.name', 'Kith'); git(root, 'config', 'user.email', 'kith@example.test');
  fs.mkdirSync(path.join(root, 'src/nested'), { recursive: true });
  fs.writeFileSync(path.join(root, '.gitignore'), '.coord/\n');
  fs.writeFileSync(path.join(root, 'src/target.ts'), 'export function target() { return 1; }\n');
  git(root, 'add', '.'); git(root, 'commit', '-m', 'seed');
});
afterEach(() => { for (const engine of engines.splice(0)) engine.close(); fs.rmSync(temp, { recursive: true, force: true }); });

it('shares locks, tasks and capabilities from root, subdirectories, aliases and a linked checkout', () => {
  const owner = open(root); owner.fencing.registerAgent({ id: 'owner' });
  owner.locks.acquireLocks({ agentId: 'owner', patterns: ['src/target.ts'] });
  owner.intents.addTask({ id: 'task', title: 'Shared task' });
  const alias = path.join(temp, 'alias'); fs.symlinkSync(root, alias);
  const linked = path.join(temp, 'linked checkout'); git(root, 'worktree', 'add', '-b', 'linked', linked);
  for (const directory of [path.join(root, 'src/nested'), alias, path.join(linked, 'src')]) {
    const peer = open(directory);
    expect(peer.coordDb.dbPath).toBe(owner.coordDb.dbPath);
    expect(peer.intents.listTasks().some(t => t.id === 'task')).toBe(true);
    peer.fencing.registerAgent({ id: 'peer-' + engines.length });
    expect(peer.locks.acquireLocks({ agentId: 'peer-' + engines.length, patterns: ['src/target.ts'] }).ok).toBe(false);
  }
  expect(open(linked).coordDb.repoRoot).toBe(linked);
  expect(fs.existsSync(path.join(root, 'src', '.coord'))).toBe(false);
  expect(fs.existsSync(path.join(linked, '.coord'))).toBe(false);
});

it('uses the same state with a separate Git directory and discovers init at checkout root', () => {
  const separate = path.join(temp, 'metadata');
  const checkout = path.join(temp, 'separate checkout'); fs.mkdirSync(checkout);
  git(checkout, 'init', '--separate-git-dir', separate);
  fs.mkdirSync(path.join(checkout, 'nested'));
  expect(discoverRepository(path.join(checkout, 'nested')).coordDir).toBe(path.join(separate, 'kith'));
  const report = initializeKithRepository(path.join(root, 'src'), 'kith', { dryRun: true, integrations: ['claude'] });
  expect(report.repoRoot).toBe(root);
  expect(fs.existsSync(path.join(root, 'src/.claude'))).toBe(false);
});

it('does not silently abandon checkout-local legacy state or a broken Git marker', () => {
  const linked = path.join(temp, 'legacy'); git(root, 'worktree', 'add', '-b', 'legacy', linked);
  fs.mkdirSync(path.join(linked, '.coord')); fs.writeFileSync(path.join(linked, '.coord/state.db'), 'preserve');
  expect(() => open(linked)).toThrow('Legacy checkout-local');
  expect(fs.readFileSync(path.join(linked, '.coord/state.db'), 'utf8')).toBe('preserve');
  const sub = path.join(root, 'src/nested'); fs.mkdirSync(path.join(sub, '.coord'));
  fs.writeFileSync(path.join(sub, '.coord/state.db'), 'old subdirectory state');
  expect(() => open(sub)).toThrow('Legacy checkout-local');
  expect(fs.readFileSync(path.join(sub, '.coord/state.db'), 'utf8')).toBe('old subdirectory state');
  expect(fs.existsSync(path.join(root, '.coord'))).toBe(false);
  const broken = path.join(temp, 'broken'); fs.mkdirSync(broken); fs.writeFileSync(path.join(broken, '.git'), 'gitdir: /missing/kith\n');
  expect(() => open(broken)).toThrow('Cannot discover Git');
  expect(fs.existsSync(path.join(broken, '.coord'))).toBe(false);
  fs.unlinkSync(path.join(broken, '.git')); fs.symlinkSync('/missing/kith', path.join(broken, '.git'));
  expect(() => open(broken)).toThrow('Cannot discover Git');
});

it('canonicalizes internal aliases and refuses escaping, dangling and looping links, including missing files', () => {
  fs.symlinkSync(path.join(root, 'src'), path.join(root, 'alias'));
  expect(LockEngine.normalizePattern(root, 'alias/**/*.ts')).toBe('src/**/*.ts');
  expect(repositoryFile(root, 'alias/new/file.ts')).toBe('src/new/file.ts');
  expect(LockEngine.normalizePattern(root, 'symbol:alias/target.ts#target')).toBe('symbol:src/target.ts#target');
  const outside = path.join(temp, 'outside'); fs.mkdirSync(outside);
  fs.symlinkSync(outside, path.join(root, 'escape'));
  fs.symlinkSync(path.join(temp, 'missing'), path.join(root, 'dangling'));
  fs.symlinkSync('loop', path.join(root, 'loop'));
  for (const file of ['escape/new.ts', 'escape/../stolen.ts', 'dangling/new.ts', 'loop/new.ts']) {
    expect(() => repositoryFile(root, file)).toThrow();
    expect(() => LockEngine.normalizePattern(root, file)).toThrow();
  }
  const engine = open(root); engine.fencing.registerAgent({ id: 'writer' });
  expect(() => new HookHandler(engine).handlePreToolUse({ agentId: 'writer', toolName: 'Write', filePath: 'escape/new.ts' })).toThrow();
  expect(() => AstAnalyzer.analyzeSource(root, 'escape/new.ts', 'export const x=1;')).toThrow('outside');
});

it('blocks writes through aliases, wildcard aliases and retargeted links', () => {
  const engine = open(root); for (const id of ['owner', 'peer']) engine.fencing.registerAgent({ id });
  fs.symlinkSync('src', path.join(root, 'alias'));
  engine.locks.acquireLocks({ agentId: 'owner', patterns: ['alias/target.ts'] });
  expect(engine.locks.checkFileWriteAccess({ agentId: 'peer', filePath: 'src/target.ts' }).allowed).toBe(false);
  expect(engine.locks.checkFileWriteAccess({ agentId: 'peer', filePath: 'alias/target.ts' }).allowed).toBe(false);
  engine.locks.releaseLocks({ agentId: 'owner' });
  fs.mkdirSync(path.join(root, 'aliases')); fs.symlinkSync('../src', path.join(root, 'aliases', 'dynamic'));
  engine.locks.acquireLocks({ agentId: 'owner', patterns: ['aliases/*/*.ts'] });
  expect(engine.locks.checkFileWriteAccess({ agentId: 'peer', filePath: 'src/target.ts' }).allowed).toBe(false);
  engine.locks.releaseLocks({ agentId: 'owner' });
  engine.locks.acquireLocks({ agentId: 'owner', patterns: ['future/**/*.ts'] });
  fs.symlinkSync('src', path.join(root, 'future'));
  expect(engine.locks.checkFileWriteAccess({ agentId: 'peer', filePath: 'src/target.ts' }).allowed).toBe(false);
});

it('refuses coordination and configuration symlinks before writing outside the checkout', () => {
  const outside = path.join(temp, 'outside'); fs.mkdirSync(outside);
  fs.symlinkSync(outside, path.join(root, '.coord'));
  expect(() => open(root)).toThrow('must not be a symlink');
  expect(fs.readdirSync(outside)).toEqual([]);
  fs.unlinkSync(path.join(root, '.coord'));
  fs.symlinkSync(outside, path.join(root, '.claude'));
  expect(() => initializeKithRepository(root, 'kith', { integrations: ['claude'] })).toThrow('Configuration path');
  expect(fs.readdirSync(outside)).toEqual([]);
  expect(fs.existsSync(path.join(root, '.mcp.json'))).toBe(false);
});


it('keeps literal framework route filenames distinct from glob syntax and indexes no external symlink sources', () => {
  const engine = open(root); for (const id of ['owner', 'peer']) engine.fencing.registerAgent({ id });
  fs.mkdirSync(path.join(root, 'src/[id]'));
  fs.writeFileSync(path.join(root, 'src/[id]/page.ts'), 'export function page() { return 1; }\n');
  expect(engine.locks.acquireLocks({ agentId: 'owner', patterns: ['file:src/[id]/page.ts'] }).ok).toBe(true);
  expect(engine.locks.checkFileWriteAccess({ agentId: 'peer', filePath: 'src/[id]/page.ts' }).allowed).toBe(false);
  expect(engine.locks.checkFileWriteAccess({ agentId: 'peer', filePath: 'src/other.ts' }).allowed).toBe(true);
  engine.locks.releaseLocks({ agentId: 'owner' });
  expect(new HookHandler(engine).handlePreToolUse({ agentId: 'owner', toolName: 'Write', filePath: 'src/[id]/page.ts' }).allowed).toBe(true);
  const report = engine.processPostFileEdit({ agentId: 'owner', filePath: 'src/[id]/page.ts' });
  expect(report.filePath).toBe('src/[id]/page.ts');
  const outside = path.join(temp, 'outside.ts'); fs.writeFileSync(outside, 'export function secret() {}');
  fs.symlinkSync(outside, path.join(root, 'src/external.ts'));
  const nested = path.join(root, 'nested-repo'); fs.mkdirSync(nested); git(nested, 'init'); fs.writeFileSync(path.join(nested, 'nested.ts'), 'export function nested() {}');
  engine.depGraph.indexRepositoryFiles();
  expect(engine.depGraph.listContracts().map(c => c.symbol_name)).not.toContain('secret');
  expect(engine.depGraph.listContracts().map(c => c.symbol_name)).not.toContain('nested');
});


it('retains exclusion for case aliases of not-yet-created files on insensitive filesystems', () => {
  const engine = open(root); for (const id of ['owner', 'peer']) engine.fencing.registerAgent({ id });
  engine.locks.acquireLocks({ agentId: 'owner', patterns: ['src/Future.ts'] });
  expect(engine.locks.checkFileWriteAccess({ agentId: 'peer', filePath: 'src/future.ts' }).allowed).toBe(caseSensitivePaths(root));
  engine.locks.releaseLocks({ agentId: 'owner' });
  engine.locks.acquireLocks({ agentId: 'owner', patterns: ['src/*.TS'] });
  expect(engine.locks.checkFileWriteAccess({ agentId: 'peer', filePath: 'src/new.ts' }).allowed).toBe(caseSensitivePaths(root));
});


it("rejects normalized-ID worktree collisions and mismatched merge sources without staging anyone else's files", () => {
  const engine = open(root); for (const id of ['a.b', 'a:b']) engine.fencing.registerAgent({ id });
  const owned = engine.worktrees.spawnWorktree({ agentId: 'a.b' });
  expect(() => engine.worktrees.spawnWorktree({ agentId: 'a:b' })).toThrow('already exists');
  expect(() => engine.worktrees.removeWorktree('a:b')).toThrow('exclusively registered');
  expect(fs.existsSync(owned.worktreePath)).toBe(true);
  fs.writeFileSync(path.join(owned.worktreePath, 'src/target.ts'), 'preserve uncommitted bytes');
  const sourceHead = git(owned.worktreePath, 'rev-parse', 'HEAD');
  const result = engine.mergeTrain.enqueueAndMerge({ agentId: 'a:b', branch: owned.branch, worktreePath: owned.worktreePath });
  expect(result.merged).toBe(false); expect(result.diagnostics).toContain('registered worktree');
  expect(git(owned.worktreePath, 'rev-parse', 'HEAD')).toBe(sourceHead);
  expect(git(owned.worktreePath, 'diff', '--cached', '--name-only')).toBe('');
  const wrongBranch = engine.mergeTrain.enqueueAndMerge({ agentId: 'a.b', branch: 'another-branch', worktreePath: owned.worktreePath });
  expect(wrongBranch.merged).toBe(false); expect(wrongBranch.diagnostics).toContain('branch');
  expect(engine.mergeTrain.enqueueAndMerge({ agentId: 'a:b', branch: '--help' }).merged).toBe(false);
  expect(git(owned.worktreePath, 'rev-parse', 'HEAD')).toBe(sourceHead);
  expect(git(owned.worktreePath, 'diff', '--cached', '--name-only')).toBe('');
});
