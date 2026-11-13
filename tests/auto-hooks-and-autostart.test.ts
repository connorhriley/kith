import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { doctorReport } from '../src/cli/doctor.js';
import { formatDoctorHuman } from '../src/cli/format.js';
import { launchAgentPath } from '../src/cli/autostart.js';
import { installKith } from '../src/cli/install.js';
import { PassiveConflictWatcher } from '../src/core/watcher.js';

const cli = path.resolve('dist/cli/index.js');

let temp: string;
beforeEach(() => {
  temp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kith-auto-')));
});

afterEach(() => {
  fs.rmSync(temp, { recursive: true, force: true });
});

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function createRepo(name = 'repo'): string {
  const dir = path.join(temp, name);
  fs.mkdirSync(dir, { recursive: true });
  git(dir, 'init', '-b', 'main');
  git(dir, 'config', 'user.name', 'Test');
  git(dir, 'config', 'user.email', 'test@example.com');
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'src/shared.ts'), 'export const v = 1;\n');
  fs.writeFileSync(path.join(dir, 'src/other.ts'), 'export const o = 1;\n');
  git(dir, 'add', '.');
  git(dir, 'commit', '-m', 'seed');
  return dir;
}

function isolatedEnv(home: string): Record<string, string> {
  return {
    ...Object.fromEntries(
      Object.entries(process.env).filter(
        ([k, v]) => v !== undefined && !k.startsWith('KITH_') && !k.startsWith('GIT_') && k !== 'CLAUDE_PROJECT_DIR'
      )
    ) as Record<string, string>,
    HOME: home,
    USERPROFILE: home,
    KITH_HOME: home,
  };
}

function runCli(args: string[], cwd: string, env: Record<string, string>, stdinPayload?: unknown) {
  return spawnSync(process.execPath, [cli, ...args], {
    cwd,
    env,
    encoding: 'utf8',
    input: stdinPayload === undefined ? '' : JSON.stringify(stdinPayload),
  });
}

describe('autonomous hook promotion, reboot persistence, and intuitive CLI', () => {
  it('stays invisible solo and auto-promotes to lock overlapping files when a second Claude session joins', async () => {
    const repo = createRepo();
    const home = path.join(temp, 'home');
    fs.mkdirSync(home, { recursive: true });
    const env = isolatedEnv(home);

    // 1. Solo session A starts and edits src/shared.ts via --auto hooks: zero .coord files created
    const aStart = runCli(['hook', 'session-start', '--client', 'claude'], repo, env, {
      session_id: 'sess-a',
      cwd: repo,
    });
    expect(aStart.status).toBe(0);
    expect(aStart.stdout).toBe('');
    expect(fs.existsSync(path.join(repo, '.coord'))).toBe(false);

    const aPre = runCli(['hook', 'pre', '--client', 'claude', '--auto'], repo, env, {
      session_id: 'sess-a',
      cwd: repo,
      tool_name: 'Edit',
      tool_input: { file_path: path.join(repo, 'src/shared.ts') },
    });
    expect(aPre.status, aPre.stderr).toBe(0);
    expect(fs.existsSync(path.join(repo, '.coord'))).toBe(false);

    // Passive watcher picks up active repo from global presence.db even if watching an empty dir
    const emptyWatchRoot = path.join(temp, 'empty-root');
    fs.mkdirSync(emptyWatchRoot, { recursive: true });
    const prevKithHome = process.env.KITH_HOME;
    process.env.KITH_HOME = home;
    try {
      const watcher = new PassiveConflictWatcher(emptyWatchRoot, { includeExternalPresence: true });
      const discovered = watcher.discoverGitRepos();
      expect(discovered).toContain(repo);
    } finally {
      if (prevKithHome === undefined) delete process.env.KITH_HOME;
      else process.env.KITH_HOME = prevKithHome;
    }

    // 2. Plain kith status does not create .coord/ when uninitialized, and shows solo presence
    const soloStatus = runCli(['status', '--human'], repo, env);
    expect(soloStatus.status).toBe(0);
    expect(soloStatus.stdout).toContain('claude:sess-a');
    expect(fs.existsSync(path.join(repo, '.coord'))).toBe(false);

    // 3. Second session B enters the same repo -> SessionStart immediately alerts about A's solo file
    const bStart = runCli(['hook', 'session-start', '--client', 'claude'], repo, env, {
      session_id: 'sess-b',
      cwd: repo,
    });
    expect(bStart.status).toBe(0);
    expect(bStart.stdout).toContain('2 active sessions');
    expect(bStart.stdout).toContain('src/shared.ts');

    // 4. B tries to edit src/shared.ts -> auto-promotion enforces A's solo lock and blocks B!
    const bBlocked = runCli(['hook', 'pre', '--client', 'claude', '--auto'], repo, env, {
      session_id: 'sess-b',
      cwd: repo,
      tool_name: 'Edit',
      tool_input: { file_path: path.join(repo, 'src/shared.ts') },
    });
    expect(bBlocked.status).toBe(2);
    expect(bBlocked.stderr).toContain('KITH LOCK GUARD');
    expect(fs.existsSync(path.join(repo, '.coord/state.db'))).toBe(true);
    // Auto-created .coord/ is hidden via .git/info/exclude so git status stays clean
    expect(git(repo, 'status', '--porcelain')).toBe('');

    // 5. B edits a separate file src/other.ts cleanly and receives auto-enforced context notice
    const bAllow = runCli(['hook', 'pre', '--client', 'claude', '--auto'], repo, env, {
      session_id: 'sess-b',
      cwd: repo,
      tool_name: 'Edit',
      tool_input: { file_path: path.join(repo, 'src/other.ts') },
    });
    expect(bAllow.status, bAllow.stderr).toBe(0);

    const bPost = runCli(['hook', 'post', '--client', 'claude', '--auto'], repo, env, {
      session_id: 'sess-b',
      cwd: repo,
      tool_name: 'Edit',
      tool_input: { file_path: path.join(repo, 'src/other.ts') },
    });
    expect(bPost.status).toBe(0);

    // 6. Stop releases A's session/locks cleanly so B can later claim src/shared.ts if needed
    const aStop = runCli(['hook', 'stop', '--client', 'claude', '--auto'], repo, env, {
      session_id: 'sess-a',
      cwd: repo,
    });
    expect(aStop.status).toBe(0);

    const bAfterStop = runCli(['hook', 'pre', '--client', 'claude', '--auto'], repo, env, {
      session_id: 'sess-b',
      cwd: repo,
      tool_name: 'Edit',
      tool_input: { file_path: path.join(repo, 'src/shared.ts') },
    });
    expect(bAfterStop.status, bAfterStop.stderr).toBe(0);
  });

  it('auto-promotes Cursor hooks with Cursor JSON responses and installs/uninstalls LaunchAgent + global hooks', async () => {
    const repo = createRepo('cursor-repo');
    const home = path.join(temp, 'home');
    fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
    fs.mkdirSync(path.join(home, '.cursor'), { recursive: true });
    const origCursorHooks = JSON.stringify({
      version: 1,
      hooks: { preToolUse: [{ command: 'echo keep-cursor-hook' }] },
    }) + '\n';
    fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify({ mcpServers: {} }) + '\n');
    fs.writeFileSync(path.join(home, '.claude/settings.json'), JSON.stringify({ hooks: {} }) + '\n');
    fs.writeFileSync(path.join(home, '.cursor/hooks.json'), origCursorHooks);
    const env = isolatedEnv(home);

    // Use a stub kith-menubar helper so tests exercise Radar + LaunchAgent without opening a real GUI window
    const fakeCli = path.join(temp, 'runtime/dist/cli/index.js');
    const fakeHelper = path.join(temp, 'runtime/bin/kith-menubar');
    fs.mkdirSync(path.dirname(fakeCli), { recursive: true });
    fs.mkdirSync(path.dirname(fakeHelper), { recursive: true });
    fs.copyFileSync(cli, fakeCli);
    fs.writeFileSync(fakeHelper, `#!${process.execPath}\nprocess.stdout.write('KITH_RADAR_STARTED\\n');\n`, { mode: 0o700 });

    const report = await installKith({
      targetDir: repo,
      home,
      cliPath: fakeCli,
    });
    expect(report.ok).toBe(true);
    expect(report.cursorHooks.configured).toBe(true);
    expect(report.cursorHooks.events).toEqual(['sessionStart', 'preToolUse', 'postToolUse', 'stop']);

    const cursorHooks = JSON.parse(fs.readFileSync(path.join(home, '.cursor/hooks.json'), 'utf8'));
    expect(cursorHooks.hooks.preToolUse).toHaveLength(2);
    expect(cursorHooks.hooks.preToolUse[0].command).toBe('echo keep-cursor-hook');
    expect(cursorHooks.hooks.preToolUse[1].command).toContain('--client cursor --auto');

    if (process.platform === 'darwin') {
      expect(report.autostart.configured).toBe(true);
      const plistFile = launchAgentPath(home);
      expect(fs.existsSync(plistFile)).toBe(true);
      expect(fs.readFileSync(plistFile, 'utf8')).toContain('dev.kith.radar');
    }

    // Doctor formats human output without [object Object] and recognizes global hooks
    const doc = doctorReport(repo, home);
    expect(doc.ok, JSON.stringify(doc)).toBe(true);
    expect(doc.checks.some(c => c.name === 'global-claude-hooks' && c.ok)).toBe(true);
    expect(doc.checks.some(c => c.name === 'global-cursor-hooks' && c.ok)).toBe(true);
    const docHuman = formatDoctorHuman(doc);
    expect(docHuman).toContain(repo);
    expect(docHuman).not.toContain('[object Object]');

    // Cross-client auto-protection: Cursor conversation vs Claude session
    runCli(['hook', 'pre', '--client', 'cursor', '--auto'], repo, env, {
      conversation_id: 'cur-1',
      workspace_roots: [repo],
      tool_name: 'Write',
      tool_input: { file_path: path.join(repo, 'src/shared.ts') },
    });
    runCli(['hook', 'session-start', '--client', 'claude'], repo, env, {
      session_id: 'cl-2',
      cwd: repo,
    });
    const curStart = runCli(['hook', 'session-start', '--client', 'cursor'], repo, env, {
      conversation_id: 'cur-2',
      workspace_roots: [repo],
    });
    expect(curStart.status).toBe(0);
    expect(JSON.parse(curStart.stdout).additional_context).toContain('active sessions');

    const curDeny = runCli(['hook', 'pre', '--client', 'cursor', '--auto'], repo, env, {
      conversation_id: 'cur-2',
      workspace_roots: [repo],
      tool_name: 'Write',
      tool_input: { file_path: path.join(repo, 'src/shared.ts') },
    });
    expect(curDeny.status).toBe(2);
    expect(JSON.parse(curDeny.stdout).permission).toBe('deny');

    // Symmetric CLI uninstall from repo also restores global hooks and removes LaunchAgent
    const un = runCli(['uninstall'], repo, env);
    expect(un.status, un.stderr).toBe(0);
    expect(JSON.parse(un.stdout).ok).toBe(true);
    expect(fs.readFileSync(path.join(home, '.cursor/hooks.json'), 'utf8')).toBe(origCursorHooks);
    expect(fs.existsSync(launchAgentPath(home))).toBe(false);
  });
});
