import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { KithEngine, ResourceBroker, LockEngine, AstAnalyzer } from '../src/index.js';
import { initializeKithRepository } from '../src/cli/init.js';
import { parse as parseToml } from 'smol-toml';
import { HookHandler } from '../src/cli/hook-handler.js';

let root: string;
let engine: KithEngine | undefined;
beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'kith-reliability-')); });
afterEach(() => { vi.restoreAllMocks(); engine?.close(); engine = undefined; fs.rmSync(root, { recursive: true, force: true }); });
function git(...args: string[]) { return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim(); }
function seedGit() {
  git('init'); git('config', 'user.email', 'test@example.test'); git('config', 'user.name', 'Test');
  fs.writeFileSync(path.join(root, '.gitignore'), '.coord/\nnode_modules/\n');
  fs.writeFileSync(path.join(root, 'file.ts'), 'export const value = 1;\n');
  git('add', '.'); git('commit', '-m', 'seed');
  engine = new KithEngine(root);
  engine.fencing.registerAgent({ id: 'worker' });
}

describe('non-destructive setup', () => {
  it('previews without writing any files or database', () => {
    const report = initializeKithRepository(root, 'kith', { dryRun: true });
    expect(report.configuredFiles).toContain('.mcp.json');
    expect(fs.readdirSync(root)).toEqual([]);
  });
  it('preserves settings, other MCP servers, and hooks; reruns are idempotent', () => {
    fs.mkdirSync(path.join(root, '.claude'));
    fs.mkdirSync(path.join(root, '.cursor'));
    const hook = { matcher: 'Bash', hooks: [{ type: 'command', command: 'my-check' }] };
    fs.writeFileSync(path.join(root, '.claude/settings.json'), JSON.stringify({ permissions: { allow: ['Read'] }, hooks: { PreToolUse: [hook], Stop: [hook] } }));
    fs.writeFileSync(path.join(root, '.cursor/mcp.json'), JSON.stringify({ mcpServers: { other: { command: 'other' } }, extra: true }));
    initializeKithRepository(root, 'kith', { integrations: ['claude', 'cursor', 'agents'] });
    const claude = JSON.parse(fs.readFileSync(path.join(root, '.claude/settings.json'), 'utf8'));
    expect(claude.permissions.allow).toEqual(['Read']);
    expect(claude.hooks.PreToolUse).toHaveLength(2);
    expect(claude.hooks.Stop).toEqual([hook]);
    const cursor = JSON.parse(fs.readFileSync(path.join(root, '.cursor/mcp.json'), 'utf8'));
    expect(cursor.mcpServers.other.command).toBe('other');
    expect(cursor.extra).toBe(true);
    expect(initializeKithRepository(root, 'kith', { integrations: ['claude', 'cursor', 'agents'] }).configuredFiles).toEqual([]);
    expect(fs.readFileSync(path.join(root, "AGENTS.md"), "utf8")).toContain('--owner-pid "$$"');
  });
  it('rejects malformed config before writing anything else', () => {
    fs.mkdirSync(path.join(root, '.cursor'));
    const file = path.join(root, '.cursor/mcp.json');
    fs.writeFileSync(file, '{broken');
    expect(() => initializeKithRepository(root)).toThrow('Cannot read');
    expect(fs.readFileSync(file, 'utf8')).toBe('{broken');
    expect(fs.existsSync(path.join(root, '.claude'))).toBe(false);
    expect(fs.existsSync(path.join(root, '.coord'))).toBe(false);
    expect(fs.existsSync(path.join(root, '.gitignore'))).toBe(false);
  });
  it('allows selecting only agent instructions', () => {
    initializeKithRepository(root, 'kith', { integrations: ['agents'] });
    expect(fs.existsSync(path.join(root, 'AGENTS.md'))).toBe(true);
    expect(fs.existsSync(path.join(root, '.claude'))).toBe(false);
  });
  it('preserves an existing executable Git hook', () => {
    seedGit(); engine!.close(); engine = undefined;
    const file = path.join(root, '.git/hooks/pre-commit');
    fs.writeFileSync(file, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    const report = initializeKithRepository(root, 'kith', { integrations: ['git'] });
    expect(report.warnings.join()).toContain('preserved');
    expect(fs.readFileSync(file, 'utf8')).toBe('#!/bin/sh\nexit 0\n');
  });
});

describe('safe Git operations', () => {
  it('never resets an existing branch or overwrites a dirty worktree', () => {
    seedGit();
    const wt = engine!.worktrees.spawnWorktree({ agentId: 'worker' });
    fs.writeFileSync(path.join(wt.worktreePath, 'untracked.txt'), 'precious');
    expect(() => engine!.worktrees.spawnWorktree({ agentId: 'worker' })).toThrow('already exists');
    expect(() => engine!.worktrees.removeWorktree('worker')).toThrow('dirty worktree');
    expect(fs.readFileSync(path.join(wt.worktreePath, 'untracked.txt'), 'utf8')).toBe('precious');
    engine!.fencing.registerAgent({ id: 'other' });
    const sha = git('rev-parse', wt.branch);
    expect(() => engine!.worktrees.spawnWorktree({ agentId: 'other', branch: wt.branch })).toThrow();
    expect(git('rev-parse', wt.branch)).toBe(sha);
  });
  it('refuses integration when the target has local changes', () => {
    seedGit(); const wt = engine!.worktrees.spawnWorktree({ agentId: 'worker' });
    fs.writeFileSync(path.join(root, 'file.ts'), 'local work');
    const before = git('rev-parse', 'HEAD');
    const result = engine!.mergeTrain.enqueueAndMerge({ agentId: 'worker', branch: wt.branch });
    expect(result.merged).toBe(false);
    expect(result.diagnostics).toContain('local changes');
    expect(git('rev-parse', 'HEAD')).toBe(before);
    expect(fs.readFileSync(path.join(root, 'file.ts'), 'utf8')).toBe('local work');
  });
  it('refuses a second merge without touching another runner’s stage or lock', () => {
    seedGit();
    const lock = path.join(root, '.coord/merge-train.lock');
    fs.writeFileSync(lock, 'existing owner');
    const result = engine!.mergeTrain.enqueueAndMerge({ agentId: 'worker', branch: 'HEAD' });
    expect(result.merged).toBe(false); expect(result.diagnostics).toContain('busy');
    expect(fs.readFileSync(lock, 'utf8')).toBe('existing owner');
  });
  it('records deleted files in shadow trees and reports invalid Git inputs as errors', () => {
    seedGit(); fs.unlinkSync(path.join(root, 'file.ts'));
    const sha = engine!.shadowGit.updateAgentShadowTree({ agentId: 'worker', modifiedFiles: [{ filePath: 'file.ts' }] });
    expect(git('ls-tree', '--name-only', sha!)).not.toContain('file.ts');
    expect(() => engine!.shadowGit.probePairConflict('worker', 'invalid', 'other', 'invalid')).toThrow('git merge-tree failed');
  });
});

describe('coordination correctness', () => {
  it('rechecks concurrent port reservations after the asynchronous OS probe', async () => {
    vi.spyOn(ResourceBroker, 'isTcpPortFree').mockResolvedValue(true);
    engine = new KithEngine(root);
    for (const id of ['a', 'b']) engine.fencing.registerAgent({ id });
    const ports = await Promise.all(['a', 'b'].map((agentId) => engine!.broker.acquirePort({ agentId, serviceName: 'web' })));
    expect(new Set(ports.map((p) => p.port)).size).toBe(2);
  });
  it('reports exhausted and invalid port ranges without creating a reservation', async () => {
    vi.spyOn(ResourceBroker, 'isTcpPortFree').mockResolvedValue(false);
    engine = new KithEngine(root);
    engine.fencing.registerAgent({ id: 'a' });
    await expect(engine.broker.acquirePort({ agentId: 'a', serviceName: 'web', basePort: 65535 })).rejects.toThrow('No free port');
    await expect(engine.broker.acquirePort({ agentId: 'a', serviceName: 'web', basePort: -1 })).rejects.toThrow('basePort');
    expect(engine.broker.listResources()).toEqual([]);
  });
  it('blocks when another agent wins the lock between check and acquire', () => {
    engine = new KithEngine(root);
    engine.fencing.registerAgent({ id: 'a' });
    vi.spyOn(engine.locks, 'acquireLocks').mockReturnValue({ ok: false, fencingToken: 1, locks: [], conflicts: [] });
    expect(new HookHandler(engine).handlePreToolUse({ agentId: 'a', toolName: 'Edit', filePath: 'file.ts' }).exitCode).toBe(2);
  });
  it('delivers every event across multiple delta pages', () => {
    engine = new KithEngine(root);
    engine.fencing.registerAgent({ id: 'a' });
    for (let i = 0; i < 125; i++) engine.coordDb.logEvent('b', 'contract_published', { i });
    const events = Array.from({ length: 3 }, () => engine!.consumeAgentDelta('a').events).flat();
    expect(events).toHaveLength(125);
    expect(new Set(events.map((e) => e.id)).size).toBe(125);
  });
  it('preserves literal command arguments through a mutex', async () => {
    engine = new KithEngine(root);
    engine.fencing.registerAgent({ id: 'a' });
    const literal = 'hello world; $(echo injected) "quoted"';
    const result = await engine.broker.executeWithMutex({ agentId: 'a', mutexName: 'test', command: [process.execPath, '-e', 'process.stdout.write(process.argv[1])', literal] });
    expect(result.stdout).toBe(literal);
  });
});


it('preserves concurrent edits by default while saving before and after recovery copies', () => {
  engine = new KithEngine(root);
  for (const id of ['a', 'b']) engine.fencing.registerAgent({ id });
  const file = path.join(root, 'shared.txt');
  fs.writeFileSync(file, 'before');
  engine.locks.acquireLocks({ agentId: 'b', patterns: ['shared.txt'] });
  engine.bashGuard.capturePreBashSnapshot('a');
  fs.writeFileSync(file, 'legitimate concurrent sibling edit');
  const report = engine.bashGuard.verifyPostBashAndQuarantine({ agentId: 'a', command: 'true' });
  expect(fs.readFileSync(file, 'utf8')).toBe('legitimate concurrent sibling edit');
  expect(report.quarantinedViolations).toHaveLength(1);
  const backup = report.quarantinedViolations[0].patch_path;
  expect(fs.readFileSync(backup, 'utf8')).toBe('legitimate concurrent sibling edit');
  expect(fs.readFileSync(backup + '.before', 'utf8')).toBe('before');
});

it('can explicitly restore a snapshot in a caller-controlled workspace', () => {
  engine = new KithEngine(root);
  for (const id of ['a', 'b']) engine.fencing.registerAgent({ id });
  const file = path.join(root, 'shared.txt'); fs.writeFileSync(file, 'before');
  engine.locks.acquireLocks({ agentId: 'b', patterns: ['shared.txt'] });
  engine.bashGuard.capturePreBashSnapshot('a'); fs.writeFileSync(file, 'after');
  engine.bashGuard.verifyPostBashAndQuarantine({ agentId: 'a', command: 'test', restoreLockedFiles: true });
  expect(fs.readFileSync(file, 'utf8')).toBe('before');
});


it('does not integrate when verification overlaps external target edits', () => {
  seedGit();
  const wt = engine!.worktrees.spawnWorktree({ agentId: 'worker' });
  const target = path.join(root, 'file.ts');
  const before = git('rev-parse', 'HEAD');
  const edit = `require('node:fs').writeFileSync(${JSON.stringify(target)}, 'external edit')`;
  const result = engine!.mergeTrain.enqueueAndMerge({
    agentId: 'worker', branch: wt.branch,
    verificationCmd: `node -e ${"'" + edit.replace(/'/g, "'\\''") + "'"}`,
  });
  expect(result.merged).toBe(false);
  expect(result.diagnostics).toContain('local changes');
  expect(git('rev-parse', 'HEAD')).toBe(before);
  expect(fs.readFileSync(target, 'utf8')).toBe('external edit');
});


it('normalizes lexical path aliases and rejects scopes outside the repository', () => {
  expect(LockEngine.normalizePattern(root, 'src/../locked.ts')).toBe('locked.ts');
  expect(() => LockEngine.normalizePattern(root, '../outside.ts')).toThrow(/scope/i);
  expect(() => LockEngine.normalizePattern(root, '/outside/file.ts')).toThrow('outside');
});


it('refuses to remove ignored worktree files such as environment secrets', () => {
  seedGit();
  fs.appendFileSync(path.join(root, '.gitignore'), '.env\n'); git('add', '.gitignore'); git('commit', '-m', 'ignore env');
  const wt = engine!.worktrees.spawnWorktree({ agentId: 'worker' });
  fs.writeFileSync(path.join(wt.worktreePath, '.env'), 'SECRET=preserve');
  expect(() => engine!.worktrees.removeWorktree('worker')).toThrow('ignored');
  expect(fs.readFileSync(path.join(wt.worktreePath, '.env'), 'utf8')).toBe('SECRET=preserve');
});

it('does not install repository-specific hooks into an external hooks directory', () => {
  seedGit();
  const hooks = fs.mkdtempSync(path.join(os.tmpdir(), 'kith-external-hooks-'));
  try {
    git('config', 'core.hooksPath', hooks);
    const report = initializeKithRepository(root, 'kith', { integrations: ['git'] });
    expect(report.warnings.join()).toContain('outside this repository');
    expect(fs.readdirSync(hooks)).toEqual([]);
  } finally { fs.rmSync(hooks, { recursive: true, force: true }); }
});


it('appends valid Codex project settings without rewriting comments or unrelated values', () => {
  fs.mkdirSync(path.join(root, '.codex'));
  const file = path.join(root, '.codex/config.toml');
  const original = '# Keep this comment\nmodel = "configured-model"\n[features]\ncustom = true\n[mcp_servers.other]\ncommand = "other"\n';
  fs.writeFileSync(file, original);
  initializeKithRepository(root, 'kith', { integrations: ['codex'] });
  const content = fs.readFileSync(file, 'utf8');
  expect(content.startsWith(original)).toBe(true);
  const config = parseToml(content) as any;
  expect(config.mcp_servers.kith.args).toEqual(['mcp', '--repo', fs.realpathSync(root)]);
  expect(config.mcp_servers.kith.env_vars).toEqual(['KITH_AGENT_ID', 'KITH_SESSION_TOKEN']);
  expect(config.mcp_servers.other.command).toBe('other');
  expect(initializeKithRepository(root, 'kith', { integrations: ['codex'] }).configuredFiles).toEqual([]);
});

it('preserves a custom Codex Kith transport and reports missing capability forwarding', () => {
  fs.mkdirSync(path.join(root, '.codex'));
  const file = path.join(root, '.codex/config.toml');
  const original = '[mcp_servers.kith]\ncommand = "custom-kith"\n';
  fs.writeFileSync(file, original);
  const report = initializeKithRepository(root, 'kith', { integrations: ['codex'] });
  expect(fs.readFileSync(file, 'utf8')).toBe(original);
  expect(report.warnings.join()).toContain('env_vars');
});

it('rejects malformed Codex settings before writing any other integration', () => {
  fs.mkdirSync(path.join(root, '.codex'));
  fs.writeFileSync(path.join(root, '.codex/config.toml'), 'broken = [');
  expect(() => initializeKithRepository(root)).toThrow('invalid TOML');
  expect(fs.existsSync(path.join(root, '.claude'))).toBe(false);
  expect(fs.existsSync(path.join(root, '.coord'))).toBe(false);
  expect(fs.existsSync(path.join(root, '.gitignore'))).toBe(false);
});

it('makes generated Claude pre-hooks block on launch failure and upgrades existing Kith hooks', () => {
  initializeKithRepository(root, 'kith', { integrations: ['claude'] });
  const file = path.join(root, '.claude/settings.json');
  const settings = JSON.parse(fs.readFileSync(file, 'utf8'));
  expect(settings.hooks.PreToolUse[0].hooks[0].onFailure).toBe('block');
  delete settings.hooks.PreToolUse[0].hooks[0].onFailure;
  fs.writeFileSync(file, JSON.stringify(settings));
  initializeKithRepository(root, 'kith', { integrations: ['claude'] });
  const updated = JSON.parse(fs.readFileSync(file, 'utf8'));
  expect(updated.hooks.PreToolUse).toHaveLength(1);
  expect(updated.hooks.PreToolUse[0].hooks[0].onFailure).toBe('block');
});

it.each(['staged', 'commit', 'untracked'])('refuses verification that leaves %s changes outside the candidate commit', action => {
  seedGit();
  const wt = engine!.worktrees.spawnWorktree({ agentId: 'worker' });
  fs.writeFileSync(path.join(wt.worktreePath, 'file.ts'), 'export const value = 2;\n');
  const before = git('rev-parse', 'HEAD');
  const commands = {
    staged: 'git rm file.ts',
    commit: 'git -c user.name=Verifier -c user.email=test@example.test commit --allow-empty -m changed-head',
    untracked: 'node -e "require(\'node:fs\').writeFileSync(\'only-in-stage.txt\',\'not integrated\')"',
  };
  const result = engine!.mergeTrain.enqueueAndMerge({ agentId: 'worker', branch: wt.branch, worktreePath: wt.worktreePath, verificationCmd: commands[action as keyof typeof commands] });
  expect(result.merged).toBe(false);
  expect(result.diagnostics).toContain('staging checkout');
  expect(git('rev-parse', 'HEAD')).toBe(before);
  expect(fs.readFileSync(path.join(wt.worktreePath, 'file.ts'), 'utf8')).toBe('export const value = 2;\n');
});

it('allows unchanged dependency hydration and ignored outputs during verification', () => {
  seedGit();
  fs.mkdirSync(path.join(root, 'node_modules'));
  const wt = engine!.worktrees.spawnWorktree({ agentId: 'worker' });
  // This fixture intentionally leaves node_modules unignored; Kith creates this stage symlink itself.
  const ignore = path.join(root, '.gitignore'); fs.writeFileSync(ignore, '.coord/\n');
  git('add', '.gitignore'); git('commit', '-m', 'Leave dependency hydration unignored');
  fs.writeFileSync(path.join(wt.worktreePath, 'file.ts'), 'export const value = 2;\n');
  const result = engine!.mergeTrain.enqueueAndMerge({ agentId: 'worker', branch: wt.branch, worktreePath: wt.worktreePath,
    verificationCmd: 'node -e "const fs=require(\'node:fs\');fs.mkdirSync(\'.coord\',{recursive:true});fs.writeFileSync(\'.coord/result\',\'passed\')"' });
  expect(result.merged, result.diagnostics).toBe(true);
});
