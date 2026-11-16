import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { KithEngine } from '../src/index.js';
import { KITH_VERSION } from '../src/version.js';
import { doctorReport } from '../src/cli/doctor.js';
import {
  HOOK_MESSAGE_BUDGET,
  HOOK_TRUNCATION_HINT,
  boundHookMessage,
  presentHookMessage,
  runHookPhase,
} from '../src/cli/hook-commands.js';
import { installKith } from '../src/cli/install.js';
import {
  claudeDesktopConfigPath,
  pruneUnreferencedRuntimes,
  shellWords,
  staleRuntimeNotice,
} from '../src/cli/runtime-pin.js';

const roots: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

const tempDir = () => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kith-runtime-')));
  roots.push(dir);
  return dir;
};

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

function gitRepo(): string {
  const root = tempDir();
  git(root, 'init', '-b', 'main');
  git(root, 'config', 'user.email', 't@example.test');
  git(root, 'config', 'user.name', 'T');
  fs.writeFileSync(path.join(root, 'a.ts'), 'export const a = 1;\n');
  git(root, 'add', '.');
  git(root, 'commit', '-m', 'seed');
  return root;
}

function writeRuntime(home: string, version: string, hash = 'ab'.repeat(12)): string {
  const dir = path.join(home, '.local/share/kith/runtimes', `${version}-${hash}`);
  fs.mkdirSync(path.join(dir, 'dist/cli'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'kith-coord', version, type: 'module' }));
  const cli = path.join(dir, 'dist/cli/index.js');
  fs.writeFileSync(cli, '// fixture\n', { mode: 0o600 });
  return cli;
}

function quote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

describe('hook message budget', () => {
  it('caps pre and post text at 2000 characters on a line boundary', () => {
    const line = 'x'.repeat(80);
    const multiline = boundHookMessage(Array.from({ length: 50 }, () => line).join('\n'));
    const body = multiline.slice(0, multiline.length - HOOK_TRUNCATION_HINT.length - 1);
    expect(multiline.endsWith(`\n${HOOK_TRUNCATION_HINT}`)).toBe(true);
    expect(body.split('\n').every((part) => part === line)).toBe(true);

    const single = boundHookMessage('y'.repeat(20_000));
    const exact = 'z'.repeat(HOOK_MESSAGE_BUDGET);
    const samples = [multiline, single, exact, boundHookMessage(exact + '!')];
    const worst = Math.max(...samples.map((sample) => sample.length));
    expect(worst).toBe(HOOK_MESSAGE_BUDGET);
    expect(single.length).toBe(HOOK_MESSAGE_BUDGET);
    expect(boundHookMessage(exact)).toBe(exact);
    expect(samples.every((sample) => sample.length <= HOOK_MESSAGE_BUDGET)).toBe(true);

    const command = `kith commit -m "land it" ${Array.from({ length: 12 }, (_, i) => `src/${'n'.repeat(40)}-${i}.ts`).join(' ')}`;
    const refusal = `[KITH BASH FIREWALL] ${'s'.repeat(2500)} To commit only your own files safely while peers are active, run: ${command}`;
    const cappedRefusal = boundHookMessage(refusal);
    expect(cappedRefusal.length).toBeLessThanOrEqual(HOOK_MESSAGE_BUDGET);
    expect(cappedRefusal.split('\n')).toContain(command);
    const oversized = `kith commit -m "too long" ${'src/file.ts '.repeat(200)}`.trim();
    expect(oversized.length).toBeGreaterThan(HOOK_MESSAGE_BUDGET);
    expect(boundHookMessage(`[KITH BASH FIREWALL] refused. run: ${oversized}`)).toBe(oversized);

    const root = gitRepo();
    const engine = new KithEngine(root);
    const previousExit = process.exitCode;
    const logs: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((line?: unknown) => { logs.push(String(line ?? '')); });
    vi.stubEnv('PATH', path.join(root, 'empty-path'));
    fs.mkdirSync(path.join(root, 'empty-path'));
    try {
      engine.fencing.registerAgent({ id: 'me' });
      const notice = 'n'.repeat(8_000);
      for (const subCmd of ['pre', 'post'] as const) {
        logs.length = 0;
        runHookPhase({
          engine,
          subCmd,
          flags: {},
          stdinPayload: { tool_name: 'Read' },
          agentId: 'me',
          promotedNotice: notice,
        });
        const payload = JSON.parse(logs[0] ?? '{}') as { hookSpecificOutput?: { additionalContext?: string } };
        const text = payload.hookSpecificOutput?.additionalContext ?? '';
        expect(text.length).toBeLessThanOrEqual(HOOK_MESSAGE_BUDGET);
        expect(text.endsWith(HOOK_TRUNCATION_HINT)).toBe(true);
        expect(text.length).toBe(worst);
      }
    } finally {
      process.exitCode = previousExit;
      engine.close();
    }
  });

  it('warns once per owning process when the hook runtime is older than the CLI on PATH', () => {
    const home = tempDir();
    const pkg = path.join(home, 'global/dist/cli');
    fs.mkdirSync(pkg, { recursive: true });
    fs.writeFileSync(path.join(home, 'global/package.json'), JSON.stringify({ name: 'kith-coord', version: '9.9.9' }));
    const cli = path.join(pkg, 'index.js');
    fs.writeFileSync(cli, '// global\n');
    const bin = path.join(home, 'bin');
    fs.mkdirSync(bin);
    fs.symlinkSync(cli, path.join(bin, 'kith'));

    const first = staleRuntimeNotice({ home, pid: 4242, pidStart: 'boot-a', ownVersion: '0.1.8', globalCli: cli });
    expect(first).toContain('Kith 0.1.8');
    expect(first).toContain('9.9.9');
    expect(first).toContain('kith install');
    expect(staleRuntimeNotice({ home, pid: 4242, pidStart: 'boot-a', ownVersion: '0.1.8', globalCli: cli })).toBeNull();
    expect(staleRuntimeNotice({ home, pid: 4242, pidStart: 'boot-b', ownVersion: '0.1.8', globalCli: cli })).toContain('9.9.9');
    expect(staleRuntimeNotice({ home, pid: 0, pidStart: 'boot-c', ownVersion: '0.1.0', globalCli: cli })).toBeNull();
    expect(staleRuntimeNotice({ home, pid: 99, pidStart: 'boot-d', ownVersion: '9.9.9', globalCli: cli })).toBeNull();

    const root = gitRepo();
    const engine = new KithEngine(root);
    engine.fencing.registerAgent({ id: 'me' });
    vi.stubEnv('PATH', bin);
    vi.stubEnv('KITH_HOME', home);
    vi.stubEnv('HOME', home);
    const logs: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((line?: unknown) => { logs.push(String(line ?? '')); });
    const previousExit = process.exitCode;
    try {
      const read = (subCmd: 'pre' | 'post') => {
        logs.length = 0;
        runHookPhase({ engine, subCmd, flags: {}, stdinPayload: { tool_name: 'Read' }, agentId: 'me' });
        return logs[0] ?? '';
      };
      expect(read('pre')).toContain('kith install');
      expect(read('post')).not.toContain('older than');
      expect(presentHookMessage('still here')).toBe('still here');
    } finally {
      process.exitCode = previousExit;
      engine.close();
    }
  });

  it('caps a shared-checkout update-ref refusal and revert without cutting the kith commit line', () => {
    const root = gitRepo();
    const engine = new KithEngine(root);
    const previousExit = process.exitCode;
    engine.setWorkflowMode('main');
    engine.fencing.registerAgent({ id: 'owner', pid: process.pid });
    engine.fencing.registerAgent({ id: 'peer', pid: process.pid });
    fs.mkdirSync(path.join(root, 'src'));
    fs.writeFileSync(path.join(root, 'src/peer.ts'), 'export const peer = 1;\n');
    git(root, 'add', 'src/peer.ts');
    git(root, 'commit', '-m', 'add peer file');
    const owned: string[] = [];
    for (let i = 0; i < 20; i++) {
      const name = `src/${'n'.repeat(80)}-${i}.ts`;
      fs.writeFileSync(path.join(root, name), `export const n${i} = 1;\n`);
      owned.push(name);
    }
    engine.locks.acquireLocks({ agentId: 'owner', patterns: owned, lockType: 'file' });
    engine.locks.acquireLocks({ agentId: 'peer', patterns: ['src/peer.ts'], lockType: 'file' });
    const old = git(root, 'rev-parse', 'HEAD');
    const index = path.join(root, '.kith-temp-index');
    const env = { ...process.env, GIT_INDEX_FILE: index };
    execFileSync('git', ['read-tree', old], { cwd: root, env, stdio: 'ignore' });
    fs.writeFileSync(path.join(root, 'src/peer.ts'), 'export const peer = 9;\n');
    execFileSync('git', ['add', '--', 'src/peer.ts'], { cwd: root, env, stdio: 'ignore' });
    const tree = execFileSync('git', ['write-tree'], { cwd: root, env, encoding: 'utf8' }).trim();
    const sha = execFileSync('git', ['commit-tree', tree, '-p', old, '-m', 'steal'], { cwd: root, encoding: 'utf8' }).trim();
    fs.rmSync(index, { force: true });
    fs.writeFileSync(path.join(root, 'src/peer.ts'), 'export const peer = 1;\n');
    const blocked = `git update-ref -m 'm' HEAD ${sha} ${old}`;
    const reason = engine.bashGuard.checkCommandSafety({ agentId: 'owner', command: blocked }).reason ?? '';
    const suggestion = reason.slice(reason.search(/\bkith commit\b/)).trim();
    expect(suggestion.startsWith('kith commit -m')).toBe(true);
    expect(`[KITH BASH FIREWALL] ${reason}`.length).toBeGreaterThan(HOOK_MESSAGE_BUDGET);
    expect(suggestion.length).toBeLessThanOrEqual(HOOK_MESSAGE_BUDGET);

    const errors: string[] = [];
    vi.spyOn(console, 'error').mockImplementation((line?: unknown) => { errors.push(String(line ?? '')); });
    try {
      runHookPhase({
        engine, subCmd: 'pre', flags: {}, stdinPayload: { tool_name: 'Bash', tool_input: { command: blocked } }, agentId: 'owner',
      });
      const refusal = errors.join('\n');
      expect(refusal.length).toBeLessThanOrEqual(HOOK_MESSAGE_BUDGET);
      expect(refusal.split('\n')).toContain(suggestion);
      expect(refusal).toContain(HOOK_TRUNCATION_HINT);

      const steal = `OLD=$(git rev-parse HEAD)
NEW=$(git commit-tree ${tree} -p "$OLD" -m steal)
git update-ref -m 'm' HEAD "$NEW" "$OLD"`;
      expect(engine.bashGuard.checkCommandSafety({ agentId: 'owner', command: steal }).deferred).toBe(true);
      execFileSync('sh', ['-c', steal], { cwd: root, stdio: 'pipe' });
      errors.length = 0;
      runHookPhase({
        engine, subCmd: 'post', flags: {}, stdinPayload: { tool_name: 'Bash', tool_input: { command: steal } }, agentId: 'owner',
      });
      const revert = errors.join('\n');
      const revertCommand = revert.split('\n').find((line) => line.startsWith('kith commit '));
      expect(process.exitCode).toBe(2);
      expect(revert.length).toBeLessThanOrEqual(HOOK_MESSAGE_BUDGET);
      expect(revert).toContain('Reverted HEAD');
      expect(revertCommand?.startsWith('kith commit -m ')).toBe(true);
      expect(revertCommand?.endsWith(owned[owned.length - 1]!)).toBe(true);
      for (const file of owned) expect(revertCommand).toContain(file);
      expect(revertCommand).not.toContain(HOOK_TRUNCATION_HINT);
      expect(git(root, 'rev-parse', 'HEAD')).toBe(old);
    } finally {
      process.exitCode = previousExit;
      engine.close();
    }
  });
});

describe('runtime version doctor and install prune', () => {
  it('splits quoted hook commands', () => {
    expect(shellWords(`/usr/bin/node ${quote("/tmp/a b/kith's cli")} hook pre`)).toEqual([
      '/usr/bin/node', "/tmp/a b/kith's cli", 'hook', 'pre',
    ]);
  });

  it('fails doctor when hook or MCP config points at a different Kith, and passes when it matches', () => {
    const project = gitRepo();
    const home = tempDir();
    const oldCli = writeRuntime(home, '0.1.7', '11'.repeat(12));
    const hook = `${quote(process.execPath)} ${quote(oldCli)} hook pre --client claude --auto`;
    fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
    fs.writeFileSync(path.join(home, '.claude/settings.json'), JSON.stringify({
      hooks: { PreToolUse: [{ hooks: [{ type: 'command', command: hook }] }] },
    }));
    fs.mkdirSync(path.join(home, '.cursor'), { recursive: true });
    fs.writeFileSync(path.join(home, '.cursor/hooks.json'), JSON.stringify({
      version: 1,
      hooks: { preToolUse: [{ command: `${quote(process.execPath)} ${quote(oldCli)} hook pre --client cursor --auto`, failClosed: true }] },
    }));
    fs.mkdirSync(path.join(home, '.codex'), { recursive: true });
    fs.writeFileSync(path.join(home, '.codex/config.toml'), `[mcp_servers.kith]\ncommand = ${JSON.stringify(process.execPath)}\nargs = ${JSON.stringify([oldCli, 'mcp'])}\n`);
    const desktop = claudeDesktopConfigPath(home);
    fs.mkdirSync(path.dirname(desktop), { recursive: true });
    fs.writeFileSync(desktop, JSON.stringify({ mcpServers: { kith: { command: process.execPath, args: [oldCli, 'mcp'] } } }));

    vi.stubEnv('KITH_AGENT_ID', '');
    vi.stubEnv('KITH_SESSION_TOKEN', '');
    const mismatch = doctorReport(project, home);
    const version = mismatch.checks.find((check) => check.name === 'runtime-version');
    expect(version?.ok).toBe(false);
    expect(version?.detail).toContain('0.1.7');
    expect(version?.detail).toContain('kith install');
    expect(version?.detail).toContain('Claude hooks');
    expect(version?.detail).toContain('Cursor hooks');
    expect(version?.detail).toContain('Codex config');
    expect(version?.detail).toContain('Claude Desktop');
    expect(mismatch.ok).toBe(false);

    const current = writeRuntime(home, KITH_VERSION, '22'.repeat(12));
    const currentHook = `${quote(process.execPath)} ${quote(current)} hook pre --client claude --auto`;
    fs.writeFileSync(path.join(home, '.claude/settings.json'), JSON.stringify({
      hooks: { PreToolUse: [{ hooks: [{ type: 'command', command: currentHook }] }] },
    }));
    fs.writeFileSync(path.join(home, '.cursor/hooks.json'), JSON.stringify({
      version: 1,
      hooks: { preToolUse: [{ command: `${quote(process.execPath)} ${quote(current)} hook pre --client cursor --auto`, failClosed: true }] },
    }));
    fs.writeFileSync(path.join(home, '.codex/config.toml'), `[mcp_servers.kith]\ncommand = ${JSON.stringify(process.execPath)}\nargs = ${JSON.stringify([current, 'mcp', '--compact'])}\n`);
    fs.writeFileSync(desktop, JSON.stringify({ mcpServers: { kith: { command: process.execPath, args: [current, 'mcp', '--compact'] } } }));
    const match = doctorReport(project, home);
    expect(match.checks.find((check) => check.name === 'runtime-version')).toMatchObject({ ok: true });
    expect(match.ok, JSON.stringify(match.checks.filter((check) => !check.ok))).toBe(true);
  });

  it('removes unreferenced retained runtimes on install and keeps ones a live config still names', async () => {
    const home = tempDir();
    const current = writeRuntime(home, KITH_VERSION, '33'.repeat(12));
    const stale = writeRuntime(home, '0.1.7', '44'.repeat(12));
    const kept = writeRuntime(home, '0.1.6', '55'.repeat(12));
    const staging = path.join(home, '.local/share/kith/runtimes', '.install-partial');
    fs.mkdirSync(staging);
    fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
    fs.writeFileSync(path.join(home, '.claude/settings.json'), JSON.stringify({
      hooks: { PreToolUse: [{ hooks: [{ command: `${quote(process.execPath)} ${quote(current)} hook pre` }] }] },
    }));
    fs.mkdirSync(path.join(home, '.codex'), { recursive: true });
    fs.writeFileSync(path.join(home, '.codex/config.toml'), `[mcp_servers.kith]\ncommand = ${JSON.stringify(process.execPath)}\nargs = ${JSON.stringify([kept, 'mcp'])}\n`);
    fs.mkdirSync(path.join(home, '.coord/setup'), { recursive: true });
    fs.writeFileSync(path.join(home, '.coord/setup/previous.json'), JSON.stringify({ cli: stale }));

    const removed = pruneUnreferencedRuntimes(home);
    expect(removed.map((dir) => path.basename(dir))).toEqual([path.basename(path.resolve(stale, '../../..'))]);
    expect(fs.existsSync(path.resolve(current, '../../..'))).toBe(true);
    expect(fs.existsSync(path.resolve(kept, '../../..'))).toBe(true);
    expect(fs.existsSync(path.resolve(stale, '../../..'))).toBe(false);
    expect(fs.existsSync(staging)).toBe(true);

    const again = writeRuntime(home, '0.1.5', '66'.repeat(12));
    const preview = pruneUnreferencedRuntimes(home, { dryRun: true });
    expect(preview.map((dir) => path.basename(dir))).toEqual([path.basename(path.resolve(again, '../../..'))]);
    expect(fs.existsSync(path.resolve(again, '../../..'))).toBe(true);

    const project = gitRepo();
    const installHome = tempDir();
    fs.mkdirSync(path.join(installHome, '.claude'), { recursive: true });
    fs.writeFileSync(path.join(installHome, '.claude.json'), '{"mcpServers":{}}\n');
    fs.writeFileSync(path.join(installHome, '.claude/settings.json'), '{}\n');
    const orphan = writeRuntime(installHome, '0.1.4', '77'.repeat(12));
    const fake = path.join(installHome, 'fake-cli.js');
    fs.writeFileSync(fake, '// not a runtime\n');
    const dry = await installKith({ targetDir: project, home: installHome, cliPath: fake, noRadar: true, dryRun: true });
    expect(dry.prunedRuntimes).toEqual([]);
    expect(fs.existsSync(path.resolve(orphan, '../../..'))).toBe(true);
    const installed = await installKith({ targetDir: project, home: installHome, cliPath: fake, noRadar: true });
    expect(installed.prunedRuntimes.map((dir) => path.basename(dir))).toEqual([path.basename(path.resolve(orphan, '../../..'))]);
    expect(fs.existsSync(path.resolve(orphan, '../../..'))).toBe(false);
  });
});
