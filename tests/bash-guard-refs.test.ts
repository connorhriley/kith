import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runHookPhase } from '../src/cli/hook-commands.js';
import { HookHandler } from '../src/cli/hook-handler.js';
import { refUpdateResyncRoots } from '../src/core/bash-guard.js';
import { discoverRepository } from '../src/core/repository.js';
import { KithEngine } from '../src/index.js';

const q = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`;
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, {
  cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
});

describe('Bash firewall owned ref updates', () => {
  let root: string;
  let engine: KithEngine;
  let worktree: string;
  let branch: string;
  let mainBranch: string;
  let ownerToken: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'kith-ref-guard-'));
    execFileSync('git', ['init', '-b', 'main'], { cwd: root, stdio: 'ignore' });
    execFileSync('git', ['config', 'user.email', 'test@kith.dev'], { cwd: root });
    execFileSync('git', ['config', 'user.name', 'Kith Test'], { cwd: root });
    execFileSync('git', ['config', 'commit.gpgsign', 'false'], { cwd: root });
    fs.mkdirSync(path.join(root, 'src'));
    fs.writeFileSync(path.join(root, 'src/a.ts'), 'export const a = 1;\n');
    git(root, 'add', '.');
    git(root, 'commit', '-m', 'init');
    mainBranch = git(root, 'branch', '--show-current').trim();
    engine = new KithEngine(root);
    ownerToken = engine.fencing.registerAgent({ id: 'owner', pid: process.pid }).sessionToken;
    engine.fencing.registerAgent({ id: 'peer', pid: process.pid });
    const spawned = engine.worktrees.spawnWorktree({ agentId: 'owner' });
    worktree = spawned.worktreePath;
    branch = spawned.branch;
  });

  afterEach(() => {
    engine.close();
    fs.rmSync(root, { recursive: true, force: true });
  });

  function safety(command: string, agentId = 'owner') {
    return engine.bashGuard.checkCommandSafety({ agentId, command, inIsolatedWorktree: Boolean(worktree) });
  }

  it('allows update-ref of HEAD and the caller branch in an isolated worktree', () => {
    const own = `refs/heads/${branch}`;
    const allowed = [
      'git update-ref HEAD abc def',
      `git update-ref ${own} abc def`,
      `git update-ref -m 'commit: temp index commit' HEAD abc def`,
      'git update-ref -m"commit: temp" --no-deref --create-reflog HEAD abc def',
      `git update-ref -m "commit: a && b" HEAD abc def`,
      'git --no-pager update-ref HEAD abc def',
      `git -C ${q(worktree)} update-ref -m 'commit: x' HEAD abc def`,
      `git -C ${q(worktree)} -C src update-ref HEAD abc def`,
      'git -C src update-ref HEAD abc def',
      "git -C '' update-ref HEAD abc def",
      `cd ${q(path.join(worktree, 'src'))} && git update-ref HEAD abc def`,
      `cd ${q(path.join(os.tmpdir(), 'missing-kith-dir'))} || git update-ref HEAD abc def`,
      'git status --short && git update-ref HEAD abc def',
      `GIT_INDEX_FILE=${q(path.join(worktree, 'idx'))} git commit-tree abc -p def -m 'temp index commit'; git update-ref -m 'commit: temp index commit' HEAD abc def`,
      `git update-ref -d ${own}`,
      'git update-ref -d HEAD',
      'git symbolic-ref --short HEAD',
      'git symbolic-ref -q HEAD',
      `git symbolic-ref -m attach HEAD ${own}`,
      'git branch --list',
      'git commit -m "note git update-ref HEAD later"',
      'git reset --hard',
      'git checkout -- src/a.ts',
    ];
    for (const command of allowed) {
      expect(safety(command).safe, command).toBe(true);
    }

    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'kith-ref-outside-'));
    try {
      const blocked = [
        `git update-ref refs/heads/${mainBranch} abc def`,
        'git update-ref refs/heads/kith/peer abc def',
        'git update-ref refs/tags/v1 abc def',
        `git -C ${q(root)} update-ref HEAD abc def`,
        `git -C ${q(outside)} update-ref HEAD abc def`,
        'git -C ../.. update-ref HEAD abc def',
        `git -C ${q(worktree)} -C .. update-ref HEAD abc def`,
        `cd ${q(outside)} && git update-ref HEAD abc def`,
        `cd ${q(outside)}; git update-ref HEAD abc def`,
        'git update-ref --stdin',
        'git update-ref --stdin -z',
        'git update-ref -z HEAD abc def',
        'git update-ref --not-an-option HEAD abc def',
        'git -c core.commentChar=# update-ref HEAD abc def',
        'git --git-dir=/tmp/elsewhere update-ref HEAD abc def',
        'git update-ref HEAD $(echo abc) def',
        'git update-ref -m "unterminated HEAD abc',
        'echo git update-ref HEAD abc def',
        `export GIT_DIR=${q(outside)}; git update-ref HEAD abc def`,
        `GIT_DIR=${q(outside)} git update-ref HEAD abc def`,
        `git update-ref HEAD abc def && git branch -D ${branch}`,
        `git update-ref HEAD abc def; git update-ref refs/heads/${mainBranch} abc def`,
        'git update-ref HEAD abc def; git worktree prune',
        'git branch -D other',
        'git branch -m old new',
        'git branch -f other HEAD',
        'git branch --delete other',
        'git worktree remove somewhere',
        'git worktree prune',
        `git symbolic-ref HEAD refs/heads/${mainBranch}`,
        `git symbolic-ref ${own} ${own}`,
        'git symbolic-ref --delete HEAD',
        `git update-ref -d refs/heads/${mainBranch}`,
        'git update-ref -d refs/heads/kith/peer',
      ];
      for (const command of blocked) {
        const result = safety(command);
        expect(result.safe, command).toBe(false);
        expect(result.reason, command).toContain('kith commit -m');
      }
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }

    const hook = new HookHandler(engine);
    expect(hook.handlePreToolUse({ agentId: 'owner', toolName: 'Bash', command: 'git update-ref HEAD abc def' }).allowed).toBe(true);
    expect(hook.handlePreToolUse({ agentId: 'owner', toolName: 'Bash', command: 'git branch -D peer' }).allowed).toBe(false);
  });

  it('blocks HEAD updates in a shared checkout and allows a read-only symbolic-ref', () => {
    engine.coordDb.db.prepare('UPDATE agents SET worktree_path=NULL, branch=NULL WHERE id=?').run('owner');
    expect(safety('git update-ref HEAD deadbeef cafebabe').safe).toBe(false);
    expect(safety(`git update-ref refs/heads/${mainBranch} deadbeef cafebabe`).safe).toBe(false);
    expect(safety('git reset --hard').safe).toBe(false);
    expect(safety('git symbolic-ref -q --short HEAD').safe).toBe(true);
    expect(safety('git status --short').safe).toBe(true);
  });

  it('blocks the caller when another active agent shares the branch or the worktree', () => {
    engine.coordDb.db.prepare('UPDATE agents SET branch=? WHERE id=?').run(branch, 'peer');
    expect(safety('git update-ref HEAD abc def').safe).toBe(false);
    expect(safety(`git update-ref refs/heads/${branch} abc def`).safe).toBe(false);

    engine.coordDb.db.prepare('UPDATE agents SET branch=NULL, worktree_path=? WHERE id=?').run(worktree, 'peer');
    expect(safety('git update-ref HEAD abc def').safe).toBe(false);
    expect(safety(`git symbolic-ref HEAD refs/heads/${branch}`).safe).toBe(false);
  });

  it('blocks a branch ref that is not checked out, and still allows a detached HEAD', () => {
    git(worktree, 'checkout', '--detach');
    expect(safety('git update-ref HEAD abc def').safe).toBe(true);
    expect(safety('git update-ref --no-deref HEAD abc def').safe).toBe(true);
    expect(safety(`git update-ref refs/heads/${branch} abc def`).safe).toBe(false);
    expect(safety(`git update-ref -d refs/heads/${branch}`).safe).toBe(false);
  });

  it('allows any ref update when no peer is active', () => {
    engine.coordDb.db.prepare("UPDATE agents SET status='completed' WHERE id=?").run('peer');
    expect(safety(`git update-ref refs/heads/${mainBranch} abc def`).safe).toBe(true);
    expect(safety('git branch -D other').safe).toBe(true);
    expect(safety('git worktree prune').safe).toBe(true);
  });

  it('resolves update-ref resync roots to the targeted checkout of this repository', () => {
    const worktreeRoot = discoverRepository(worktree).checkoutRoot;
    const mainRoot = discoverRepository(root).checkoutRoot;
    expect(refUpdateResyncRoots('git update-ref -m msg HEAD abc def', worktree)).toEqual([worktreeRoot]);
    expect(refUpdateResyncRoots('git -C src update-ref HEAD abc def', worktree)).toEqual([worktreeRoot]);
    expect(refUpdateResyncRoots(`git -C ${q(root)} update-ref HEAD abc def`, worktree)).toEqual([mainRoot]);
    expect(refUpdateResyncRoots('git update-ref --stdin', worktree)).toEqual([]);
    expect(refUpdateResyncRoots('git update-ref HEAD $(echo abc)', worktree)).toEqual([]);

    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'kith-ref-other-repo-'));
    try {
      execFileSync('git', ['init', '-q'], { cwd: outside });
      expect(refUpdateResyncRoots(`git -C ${q(outside)} update-ref HEAD abc def`, worktree)).toEqual([]);
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  it('commits through a temporary index in an isolated worktree while a peer is active, and resyncs that worktree', () => {
    fs.writeFileSync(path.join(worktree, 'src/a.ts'), 'export const a = 2;\n');
    const index = path.join(worktree, '.kith-temp-index');
    const env = { ...process.env, GIT_INDEX_FILE: index };
    const old = git(worktree, 'rev-parse', 'HEAD').trim();
    execFileSync('git', ['read-tree', 'HEAD'], { cwd: worktree, env, stdio: 'ignore' });
    execFileSync('git', ['add', '--', 'src/a.ts'], { cwd: worktree, env, stdio: 'ignore' });
    const tree = execFileSync('git', ['write-tree'], { cwd: worktree, env, encoding: 'utf8' }).trim();
    const sha = execFileSync('git', ['commit-tree', tree, '-p', old, '-m', 'temp index commit'], {
      cwd: worktree, env, encoding: 'utf8',
    }).trim();
    const command = `GIT_INDEX_FILE=${q(index)} git commit-tree ${tree} -p ${old} -m 'temp index commit'; git update-ref -m 'commit: temp index commit' HEAD ${sha} ${old}`;
    expect(safety(command).safe).toBe(true);
    expect(refUpdateResyncRoots(command, worktree)).toEqual([discoverRepository(worktree).checkoutRoot]);

    fs.writeFileSync(path.join(root, 'src/b.ts'), 'export const staged = 1;\n');
    git(root, 'add', 'src/b.ts');
    expect(git(root, 'diff', '--cached', '--name-only').trim()).toBe('src/b.ts');

    execFileSync('sh', ['-c', command], { cwd: worktree, stdio: 'pipe' });
    expect(git(worktree, 'rev-parse', 'HEAD').trim()).toBe(sha);
    expect(git(worktree, 'log', '-1', '--format=%s').trim()).toBe('temp index commit');
    expect(git(worktree, 'diff', '--cached', '--name-only', 'HEAD')).toContain('src/a.ts');
    expect(git(root, 'rev-parse', 'HEAD').trim()).toBe(old);
    expect(git(root, 'rev-parse', branch).trim()).toBe(sha);

    const previousExit = process.exitCode;
    runHookPhase({
      engine,
      subCmd: 'post',
      flags: {},
      stdinPayload: { tool_name: 'Bash', tool_input: { command } },
      agentId: 'owner',
    });
    expect(process.exitCode ?? 0).toBe(0);
    process.exitCode = previousExit;

    expect(git(worktree, 'diff', '--cached', '--name-only', 'HEAD').trim()).toBe('');
    expect(git(worktree, 'show', 'HEAD:src/a.ts')).toBe('export const a = 2;\n');
    expect(git(root, 'rev-parse', 'HEAD').trim()).toBe(old);
    expect(git(root, 'diff', '--cached', '--name-only').trim()).toBe('src/b.ts');
    expect(git(root, 'show', ':src/b.ts')).toBe('export const staged = 1;\n');
  });

  it('uses the same ownership rule when the engine is opened inside the worktree', () => {
    const local = new KithEngine(worktree);
    try {
      local.fencing.resumeSession('owner', ownerToken);
      const check = (command: string) => local.bashGuard.checkCommandSafety({ agentId: 'owner', command });
      expect(check('git update-ref HEAD abc def').safe).toBe(true);
      expect(check(`git update-ref refs/heads/${branch} abc def`).safe).toBe(true);
      expect(check(`git update-ref refs/heads/${mainBranch} abc def`).safe).toBe(false);
      expect(check('git worktree remove somewhere').safe).toBe(false);
    } finally {
      local.close();
    }
  });
});
