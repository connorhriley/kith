import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, it } from 'vitest';
import { claudeInstallHookNote, claudeKithPluginStatus } from '../src/cli/claude-plugin.js';
import { doctorReport } from '../src/cli/doctor.js';
import { installKith } from '../src/cli/install.js';
import { HOOK_PHASES, kithHookAlreadyInstalled, runHook, shouldDefer } from '../plugins/kith/hooks/run.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tempDirs: string[] = [];
afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function tempDir(prefix: string) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  tempDirs.push(dir);
  return dir;
}

function gitRepo() {
  const root = tempDir('kith-plugin-repo-');
  const git = (...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  git('init', '-b', 'main');
  git('config', 'user.email', 't@example.test');
  git('config', 'user.name', 'T');
  fs.writeFileSync(path.join(root, 'a.ts'), 'export const a = 1;\n');
  git('add', '.');
  git('commit', '-m', 'seed');
  return root;
}

const installHook = (phase: string) => `node '/usr/bin/node' '/opt/kith/dist/cli/index.js' hook ${phase} --client claude --auto`;

it('parses the Claude Code marketplace and plugin manifests', () => {
  const marketplace = JSON.parse(fs.readFileSync(path.join(repoRoot, '.claude-plugin/marketplace.json'), 'utf8'));
  const plugin = JSON.parse(fs.readFileSync(path.join(repoRoot, 'plugins/kith/.claude-plugin/plugin.json'), 'utf8'));
  const hooks = JSON.parse(fs.readFileSync(path.join(repoRoot, 'plugins/kith/hooks/hooks.json'), 'utf8'));
  const mcp = JSON.parse(fs.readFileSync(path.join(repoRoot, 'plugins/kith/.mcp.json'), 'utf8'));

  expect(marketplace.name).toBe('kith');
  expect(marketplace.owner?.name).toBeTruthy();
  expect(marketplace.plugins).toEqual([
    expect.objectContaining({ name: 'kith', source: './plugins/kith' }),
  ]);
  expect(marketplace.plugins[0].version).toBe('0.2.0');
  expect(plugin.name).toBe('kith');
  expect(plugin.version).toBe('0.2.0');
  expect(fs.existsSync(path.join(repoRoot, 'plugins/kith/.claude-plugin/plugin.json'))).toBe(true);

  const events = hooks.hooks;
  expect(events.SessionStart[0].hooks[0].command).toContain('run.mjs" session-start');
  expect(events.PreToolUse[0].matcher).toBe('Edit|Write|MultiEdit|Bash');
  expect(events.PreToolUse[0].hooks[0].onFailure).toBe('block');
  expect(events.PreToolUse[0].hooks[0].command).toContain('run.mjs" pre');
  expect(events.PostToolUse[0].hooks[0].command).toContain('run.mjs" post');
  expect(events.Stop[0].hooks[0].command).toContain('run.mjs" stop');
  expect(events.PostToolUse[0].hooks[0].onFailure).toBeUndefined();

  expect(mcp.mcpServers.kith).toEqual({
    command: 'npx',
    args: ['-y', 'kith-coord', 'mcp', '--compact'],
  });
  expect(Object.keys(HOOK_PHASES).sort()).toEqual(['post', 'pre', 'session-start', 'stop']);
});

it('defers to kith install and kith init hooks, and otherwise runs npx kith-coord', async () => {
  expect(kithHookAlreadyInstalled(installHook('pre'), 'pre')).toBe(true);
  expect(kithHookAlreadyInstalled("kith --repo '/repo' hook pre --enforcement block", 'pre')).toBe(true);
  expect(kithHookAlreadyInstalled('some-tool hook preview --client claude', 'pre')).toBe(false);
  expect(kithHookAlreadyInstalled('echo hook pre', 'pre')).toBe(false);
  expect(kithHookAlreadyInstalled(installHook('pre'), 'post')).toBe(false);

  const home = tempDir('kith-plugin-home-');
  const project = tempDir('kith-plugin-project-');
  const env = { HOME: home, USERPROFILE: home, CLAUDE_PROJECT_DIR: project };
  expect(shouldDefer('pre', env)).toBe(false);

  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(home, '.claude/settings.json'), JSON.stringify({
    hooks: { PreToolUse: [{ hooks: [{ type: 'command', command: installHook('pre') }] }] },
  }));
  expect(shouldDefer('pre', env)).toBe(true);
  expect(shouldDefer('session-start', env)).toBe(false);

  fs.writeFileSync(path.join(home, '.claude/settings.json'), '{}\n');
  fs.mkdirSync(path.join(project, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(project, '.claude/settings.json'), JSON.stringify({
    hooks: { PreToolUse: [{ hooks: [{ type: 'command', command: "kith --repo '/repo' hook pre" }] }] },
  }));
  expect(shouldDefer('pre', env)).toBe(true);

  const spawned: Array<{ args: string[]; stdin: Buffer }> = [];
  const ran = await runHook({
    phase: 'pre',
    env: { HOME: tempDir('kith-plugin-empty-'), USERPROFILE: tempDir('kith-plugin-empty-') },
    stdin: Buffer.from('{"tool_name":"Edit"}'),
    spawnImpl: async (args: string[], stdin: Buffer) => {
      spawned.push({ args, stdin });
      return { code: 0, deferred: false };
    },
  });
  expect(ran).toEqual({ code: 0, deferred: false });
  expect(spawned).toEqual([{ args: ['hook', 'pre', '--client', 'claude', '--auto'], stdin: Buffer.from('{"tool_name":"Edit"}') }]);

  const deferred = await runHook({
    phase: 'pre',
    env,
    stdin: Buffer.from('{}'),
    spawnImpl: async () => {
      throw new Error('spawned');
    },
  });
  expect(deferred).toEqual({ code: 0, deferred: true });
  expect(await runHook({ phase: 'nope', spawnImpl: async () => ({ code: 0, deferred: false }) })).toEqual({ code: 1, deferred: false });
});

it('treats the Claude Code plugin and install hooks as one passing doctor check', () => {
  const root = gitRepo();
  const home = tempDir('kith-plugin-doctor-');
  fs.mkdirSync(path.join(home, '.claude/plugins'), { recursive: true });
  fs.writeFileSync(path.join(home, '.claude/plugins/installed_plugins.json'), JSON.stringify({
    plugins: { 'kith@kith': [{ scope: 'user', installPath: '/cache/kith', version: 'sha' }] },
  }));
  const pluginOnly = doctorReport(root, home);
  expect(pluginOnly.checks.find(c => c.name === 'global-claude-hooks')).toMatchObject({ ok: true });
  expect(pluginOnly.checks.find(c => c.name === 'mcp-configuration')?.ok).toBe(true);
  expect(pluginOnly.checks.find(c => c.name === 'mcp-configuration')?.detail).toContain('kith@kith');
  expect(pluginOnly.checks.filter(c => /hook|mcp-configuration/.test(c.name) && !c.ok)).toEqual([]);

  const hook = (command: string) => ({ hooks: [{ type: 'command', command }] });
  fs.writeFileSync(path.join(home, '.claude/settings.json'), JSON.stringify({
    enabledPlugins: { 'kith@kith': true },
    hooks: { PreToolUse: [hook(installHook('pre')), hook(installHook('pre'))] },
  }));
  const both = doctorReport(root, home);
  const claude = both.checks.find(c => c.name === 'global-claude-hooks');
  expect(claude?.ok).toBe(true);
  expect(claude?.detail).toContain('not a failure');
  expect(claude?.detail).toContain('checked once');
  expect(both.checks.filter(c => c.name.includes('hook') && !c.ok)).toEqual([]);

  fs.writeFileSync(path.join(home, '.claude/settings.json'), JSON.stringify({
    enabledPlugins: { 'kith@kith': false },
  }));
  const disabled = claudeKithPluginStatus(home, root);
  expect(disabled.active).toBe(false);
  const disabledReport = doctorReport(root, home);
  expect(disabledReport.checks.find(c => c.name === 'global-claude-hooks')).toBeUndefined();
  expect(disabledReport.checks.find(c => c.name === 'mcp-configuration')?.ok).toBe(false);
});

it('tells kith install that the Claude Code plugin will defer to its hooks', async () => {
  const cli = path.join(repoRoot, 'dist/cli/index.js');
  expect(fs.existsSync(cli), 'pnpm test builds dist before vitest').toBe(true);
  const home = tempDir('kith-plugin-install-');
  const project = gitRepo();
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(home, '.claude/settings.json'), JSON.stringify({
    enabledPlugins: { 'kith@kith': true },
  }) + '\n');
  const report = await installKith({
    targetDir: project,
    home,
    cliPath: cli,
    noRadar: true,
  });
  expect(report.globalHooks.configured).toBe(true);
  expect(report.globalHooks.notes).toContain('checked once');
  const settings = fs.readFileSync(path.join(home, '.claude/settings.json'), 'utf8');
  expect(settings).toContain('hook pre --client claude --auto');
  expect(JSON.parse(settings).enabledPlugins['kith@kith']).toBe(true);
  expect(shouldDefer('pre', { HOME: home, USERPROFILE: home })).toBe(true);
});

it('names the install hook note when the plugin is already enabled', () => {
  expect(claudeInstallHookNote('Wired hooks.', false)).toBe('Wired hooks.');
  expect(claudeInstallHookNote('Wired hooks.', true)).toContain('checked once');

  const home = tempDir('kith-plugin-status-');
  const project = tempDir('kith-plugin-status-project-');
  expect(claudeKithPluginStatus(home, project).active).toBe(false);
  fs.mkdirSync(path.join(project, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(project, '.claude/settings.local.json'), JSON.stringify({
    enabledPlugins: { 'kith@inline': true, 'other@kith': true },
  }));
  expect(claudeKithPluginStatus(home, project)).toEqual({ active: true, id: 'kith@inline' });
});
