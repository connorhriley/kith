import {execFileSync} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {KithEngine, inspectWorkspaceContracts, verifyCrossRepoImportsForFile, buildSwarmPrompts} from '../src/core/engine.js';
import {PassiveConflictWatcher} from '../src/core/watcher.js';

let temp: string;
const engines: KithEngine[] = [];
const git = (root: string, ...args: string[]) => execFileSync('git', args, {cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe']}).trim();
function repo(name: string, separate = false) {
  const root = path.join(temp, name);
  fs.mkdirSync(path.join(root, 'src'), {recursive: true});
  git(root, 'init', '-q', ...(separate ? ['--separate-git-dir', path.join(temp, `${name}-git`)] : []));
  git(root, 'config', 'user.name', 'Fixture'); git(root, 'config', 'user.email', 'fixture@example.invalid');
  fs.writeFileSync(path.join(root, '.gitignore'), '.coord/\n');
  fs.writeFileSync(path.join(root, 'src/base.js'), 'export const base = true;\n');
  git(root, 'add', '.'); git(root, 'commit', '-qm', 'Initial');
  return root;
}
function open(root: string) { const engine = new KithEngine(root); engines.push(engine); return engine; }
function config(root: string, paths: Record<string, string[]>, extra = {}) {
  fs.writeFileSync(path.join(root, 'tsconfig.json'), JSON.stringify({...extra, compilerOptions: {baseUrl: '.', paths}}));
  git(root, 'add', '.'); git(root, 'commit', '-qm', 'Aliases');
}
function contract(root: string, file: string, content: string) {
  fs.mkdirSync(path.dirname(path.join(root, file)), {recursive: true});
  fs.writeFileSync(path.join(root, file), content); git(root, 'add', '.'); git(root, 'commit', '-qm', 'Contract');
}
beforeEach(() => { temp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kith-regressions-'))); });
afterEach(() => { vi.restoreAllMocks(); while (engines.length) engines.pop()!.close(); fs.rmSync(temp, {recursive: true, force: true}); });

describe('Recoverable task handoff', () => {
  it('refuses a switched branch without consuming the queued task or changing unfinished work', () => {
    const root = repo('app'), e = open(root); e.fencing.registerAgent({id: 'worker'});
    const wt = e.worktrees.spawnWorktree({agentId: 'worker'});
    git(wt.worktreePath, 'switch', '-c', 'another-task');
    fs.writeFileSync(path.join(wt.worktreePath, 'keep.txt'), 'unfinished');
    const task = e.intents.addTask({title: 'Next', scopeGlobs: ['src/new.js']});
    expect(() => e.claimNextTask({agentId: 'worker', isolateWorktree: true})).toThrow(/identity|ownership/);
    expect(e.intents.getTask(task.id)?.status).toBe('queued'); expect(e.locks.listLocks()).toHaveLength(0);
    expect(fs.readFileSync(path.join(wt.worktreePath, 'keep.txt'), 'utf8')).toBe('unfinished');
    expect(git(wt.worktreePath, 'branch', '--show-current')).toBe('another-task');
  });
  it('refuses a saved path pointing at a foreign repository without changing either checkout', () => {
    const root = repo('app'), other = repo('foreign'), e = open(root); e.fencing.registerAgent({id: 'worker'});
    const wt = e.worktrees.spawnWorktree({agentId: 'worker'});
    e.coordDb.db.prepare('UPDATE agents SET worktree_path = ? WHERE id = ?').run(other, 'worker');
    const task = e.intents.addTask({title: 'Next', scopeGlobs: ['src/new.js']});
    const foreignHead = git(other, 'rev-parse', 'HEAD');
    expect(() => e.claimNextTask({agentId: 'worker', isolateWorktree: true})).toThrow(/identity|ownership/);
    expect(e.intents.getTask(task.id)?.status).toBe('queued'); expect(e.locks.listLocks()).toHaveLength(0);
    expect(git(other, 'rev-parse', 'HEAD')).toBe(foreignHead); expect(fs.existsSync(wt.worktreePath)).toBe(true);
  });
  it('rolls back failed spawning, preserving the occupied directory and allowing a non-isolated retry', () => {
    const root = repo('app'), e = open(root); e.fencing.registerAgent({id: 'worker'});
    const task = e.intents.addTask({title: 'Next', scopeGlobs: ['src/new.js']});
    const occupied = path.join(e.coordDb.coordDir, 'worktrees/worker');
    fs.mkdirSync(occupied, {recursive: true}); fs.writeFileSync(path.join(occupied, 'keep.txt'), 'unfinished');
    expect(() => e.claimNextTask({agentId: 'worker', isolateWorktree: true})).toThrow(/already exists/);
    expect(e.intents.getTask(task.id)?.status).toBe('queued'); expect(e.locks.listLocks()).toHaveLength(0);
    expect(e.fencing.getAgent('worker')?.worktree_path).toBeNull();
    expect(fs.readFileSync(path.join(occupied, 'keep.txt'), 'utf8')).toBe('unfinished');
    expect(e.claimNextTask({agentId: 'worker'}).task?.id).toBe(task.id);
  });
  it('does not consume a begin claim when its worktree cannot be created', () => {
    const root = repo('app'), e = open(root); e.fencing.registerAgent({id: 'worker'});
    const occupied = path.join(e.coordDb.coordDir, 'worktrees/worker'); fs.mkdirSync(occupied, {recursive: true});
    expect(() => e.beginWork({agentId: 'worker', title: 'New', scopeGlobs: ['src/new.js'], isolateWorktree: true})).toThrow();
    expect(e.intents.listTasks()).toHaveLength(0); expect(e.locks.listLocks()).toHaveLength(0);
    expect(fs.existsSync(occupied)).toBe(true);
  });
  it('accepts a clean validated registered worktree but refuses dirty and stale ones', () => {
    const root = repo('app'), e = open(root); e.fencing.registerAgent({id: 'worker'});
    const wt = e.worktrees.spawnWorktree({agentId: 'worker'});
    const first = e.intents.addTask({title: 'First', scopeGlobs: ['src/one.js']});
    expect(e.claimNextTask({agentId: 'worker', isolateWorktree: true}).worktree?.branch).toBe(wt.branch);
    e.intents.completeTask({agentId: 'worker', taskId: first.id});
    const next = e.intents.addTask({title: 'Next', scopeGlobs: ['src/two.js']});
    fs.writeFileSync(path.join(wt.worktreePath, 'keep.txt'), 'unfinished');
    expect(() => e.claimNextTask({agentId: 'worker', isolateWorktree: true})).toThrow(/unfinished/);
    fs.unlinkSync(path.join(wt.worktreePath, 'keep.txt'));
    fs.writeFileSync(path.join(root, 'new-base.txt'), 'new dependency'); git(root, 'add', '.'); git(root, 'commit', '-qm', 'New base');
    expect(() => e.claimNextTask({agentId: 'worker', isolateWorktree: true})).toThrow(/behind/);
    expect(e.intents.getTask(next.id)?.status).toBe('queued');
  });
});

describe('Bounded cross-repository advice', () => {
  it('does not read non-Git or untracked alias targets and omits tracked initializers', () => {
    const app = repo('consumer'); const outside = path.join(temp, 'private'); fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, 'secret.ts'), 'export const SECRET = "never-disclose";');
    config(app, {'@secret': ['../private/secret.ts']});
    let report = inspectWorkspaceContracts(app);
    expect(report.linkedContracts).toHaveLength(0); expect(report.complete).toBe(false);
    const provider = repo('provider'); fs.writeFileSync(path.join(provider, 'secret.ts'), 'export const SECRET = "never-disclose";');
    config(app, {'@secret': ['../provider/secret.ts']});
    expect(inspectWorkspaceContracts(app).linkedContracts).toHaveLength(0);
    git(provider, 'add', '.'); git(provider, 'commit', '-qm', 'Public symbol');
    report = inspectWorkspaceContracts(app); expect(report.linkedContracts).toHaveLength(1);
    expect(JSON.stringify(report)).not.toContain('never-disclose');
  });
  it('resolves the imported wildcard module, including nested modules and separate Git directories', () => {
    const provider = repo('shared library', true), app = repo('client with spaces');
    contract(provider, 'types/a.ts', 'export const OnlyA = 1;');
    contract(provider, 'types/b.ts', 'export const OnlyB = 1;');
    contract(provider, 'types/nested/c.ts', 'export interface OnlyC {id: string}');
    config(app, {'@types/*': ['../shared library/types/*']});
    const check = (content: string) => verifyCrossRepoImportsForFile({repoRoot: app, filePath: 'src/use.ts', content});
    expect(check("import {OnlyB} from '@types/a';").some(w => w.includes('MISMATCH'))).toBe(true);
    expect(check("import {OnlyC} from '@types/nested/c';").some(w => w.includes('MISMATCH'))).toBe(false);
    expect(check("import Alias from '@types/a';").some(w => w.includes('MISMATCH'))).toBe(false);
    expect(check("import {OnlyA} from '@types/a';\nimport {OnlyC} from '@types/nested/c';").some(w => w.includes('MISMATCH'))).toBe(false);
    expect(fs.existsSync(path.join(provider, '.coord'))).toBe(false);
  });
  it('returns explicit unknown state for damaged sibling ownership, including the radar', async () => {
    const provider = repo('provider'), app = repo('client');
    contract(provider, 'public.ts', 'export interface Shape {id: string}');
    config(app, {'@api': ['../provider/public.ts']});
    fs.mkdirSync(path.join(provider, '.coord')); fs.writeFileSync(path.join(provider, '.coord/state.db'), 'damaged');
    const report = inspectWorkspaceContracts(app);
    expect(report.complete).toBe(false); expect(report.linkedContracts[0].ownershipAvailable).toBe(false);
    expect(report.warnings.some(w => w.includes('ownership'))).toBe(true);
    const watcher = new PassiveConflictWatcher(app); await watcher.scanOnce();
    expect(watcher.getScanState().contractsComplete).toBe(false);
    expect(watcher.getScanState().contractWarnings.some(w => w.includes('ownership'))).toBe(true);
    expect(fs.readFileSync(path.join(provider, '.coord/state.db'), 'utf8')).toBe('damaged');
  });
  it('does not fail a successful claim when advisory file I/O fails', () => {
    const provider = repo('provider'), app = repo('client'); contract(provider, 'public.ts', 'export const Public = 1;');
    config(app, {'@api': ['../provider/public.ts']});
    const original = fs.openSync;
    vi.spyOn(fs, 'openSync').mockImplementation(((file: fs.PathLike, ...rest: any[]) => {
      if (String(file) === path.join(provider, 'public.ts')) throw Object.assign(new Error('denied'), {code: 'EACCES'});
      return (original as any)(file, ...rest);
    }) as any);
    const e = open(app); e.fencing.registerAgent({id: 'worker'});
    const result = e.beginWork({agentId: 'worker', title: 'New', scopeGlobs: ['src/**'], isolateWorktree: true});
    expect(result.ok).toBe(true); expect(result.worktree).toBeTruthy(); expect(result.crossRepoComplete).toBe(false);
    expect(result.crossRepoWarnings.some(w => w.includes('UNAVAILABLE'))).toBe(true);
    expect(e.intents.getTask(result.task!.id)?.status).toBe('active');
  });
  it('bounds source inspection and replies while reporting partial exports honestly', () => {
    const provider = repo('provider'), app = repo('client');
    contract(provider, 'public.ts', Array.from({length: 1000}, (_, n) => `export const Item${n} = ${n};`).join('\n'));
    config(app, {'@api': ['../provider/public.ts']});
    let report = inspectWorkspaceContracts(app);
    expect(report.complete).toBe(false); expect(report.linkedContracts[0].exportsComplete).toBe(false);
    expect(report.linkedContracts[0].symbols.length).toBeLessThanOrEqual(64);
    expect(Buffer.byteLength(JSON.stringify(report))).toBeLessThanOrEqual(16384);
    expect(verifyCrossRepoImportsForFile({repoRoot: app, filePath: 'src/use.ts', content: "import {Item999} from '@api';"}).some(w => w.includes('MISMATCH'))).toBe(false);
    contract(provider, 'public.ts', 'export const Large = "' + 'x'.repeat(70000) + '";');
    report = inspectWorkspaceContracts(app); expect(report.complete).toBe(false); expect(report.linkedContracts).toHaveLength(0);
  });
  it('keeps ordinary internal aliases quiet and marks unsupported inherited config as unknown', () => {
    const app = repo('ordinary'); config(app, {'@/*': ['src/*']});
    expect(inspectWorkspaceContracts(app)).toEqual({linkedContracts: [], warnings: [], complete: true});
    config(app, {'@/*': ['src/*']}, {extends: './configs/base.json'});
    const report = inspectWorkspaceContracts(app); expect(report.complete).toBe(false);
    expect(report.warnings.some(w => w.includes('Inherited'))).toBe(true);
  });
  it('refuses a parent workspace as a prompt repository and normalizes actual Git subdirectories', () => {
    const app = repo('arbitrary project');
    expect(() => buildSwarmPrompts(temp)).toThrow(/Git checkout/);
    const prompts = buildSwarmPrompts(path.join(app, 'src'));
    expect(prompts.worker).toContain(`repository "${app}"`); expect(prompts.worker).toContain('verificationCmd');
    expect(prompts.architect).toContain(`repository "${app}"`);
  });
});
