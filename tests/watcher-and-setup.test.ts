import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { PassiveConflictWatcher } from '../src/core/watcher.js';
import { autoConfigureAllClients } from '../src/cli/setup-auto.js';
import { uninstallKith } from '../src/cli/setup-ledger.js';
import { discoverRepository } from '../src/core/repository.js';

let temp: string;
const cli = path.resolve('dist/cli/index.js');
beforeEach(() => { temp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kith-setup-watch-'))); });
afterEach(() => { fs.rmSync(temp, { recursive: true, force: true }); });
function git(repo: string, ...args: string[]) { return execFileSync('git', args, { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }); }
function repository(name = 'repo') {
  const dir = path.join(temp, name); fs.mkdirSync(dir, { recursive: true }); git(dir, 'init', '--quiet');
  for (const file of ['src/page.tsx', 'src/auth/index.ts', 'src/billing/index.ts', 'src/a b\n"x".ts']) {
    fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true }); fs.writeFileSync(path.join(dir, file), 'base\n');
  }
  fs.writeFileSync(path.join(dir, '.gitignore'), '.coord/\n');
  git(dir, 'add', '.'); git(dir, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '--quiet', '-m', 'seed'); return dir;
}
function linked(repo: string) { const dir = path.join(repo, '.coord/worktrees/task'); git(repo, 'worktree', 'add', '--quiet', '-b', 'task', dir); return dir; }
function home() { const dir = path.join(temp, 'home'); fs.mkdirSync(path.join(dir, '.claude'), { recursive: true }); fs.mkdirSync(path.join(dir, '.codex')); return dir; }
function writeJson(file: string, value: unknown) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(value)); }

it('preserves existing servers, settings, hooks and capabilities while binding portable launchers to the checkout', () => {
  const repo = repository(), h = home();
  const cursor = path.join(repo, '.cursor/mcp.json');
  const original = { mcpServers: { peer: { command: 'peer', env: { PRIVATE: 'dummy' } } }, setting: 'retain' };
  writeJson(cursor, original);
  const hooks = path.join(h, '.claude/settings.json'); fs.writeFileSync(hooks, '{"hooks":{"PreToolUse":[{"custom":true}]}}\n');
  writeJson(path.join(h, '.claude.json'), { projects: { retained: true }, mcpServers: { peer: { command: 'peer' } } });
  const beforeHooks = fs.readFileSync(hooks);
  const results = autoConfigureAllClients(repo, h);
  const cfg = JSON.parse(fs.readFileSync(cursor, 'utf8'));
  expect(cfg.mcpServers.peer).toEqual(original.mcpServers.peer); expect(cfg.setting).toBe('retain');
  expect(cfg.mcpServers.kith.command).toBe(process.execPath);
  expect(cfg.mcpServers.kith.args).toEqual([fs.realpathSync(cli), 'mcp', '--repo', repo]);
  expect(fs.readFileSync(hooks)).toEqual(beforeHooks);
  const user = JSON.parse(fs.readFileSync(path.join(h, '.claude.json'), 'utf8'));
  expect(user.mcpServers.kith.args).toEqual([fs.realpathSync(cli), 'mcp']);
  expect(user.projects.retained).toBe(true); expect(user.mcpServers.peer.command).toBe('peer');
  expect(results.find(r => r.clientName === 'Claude Code CLI')?.configured).toBe(true);
  expect(uninstallKith(repo).ok).toBe(true); expect(JSON.parse(fs.readFileSync(cursor, 'utf8'))).toEqual(original);
  expect(uninstallKith(h).ok).toBe(true); expect(fs.readFileSync(hooks)).toEqual(beforeHooks);
  expect(JSON.parse(fs.readFileSync(path.join(h, '.claude.json'), 'utf8')).mcpServers.kith).toBeUndefined();
});

it('previews without writes and refuses a malformed later client before changing earlier ones', () => {
  const repo = repository(), h = home();
  const before = fs.readdirSync(h); autoConfigureAllClients(repo, h, { dryRun: true });
  expect(fs.readdirSync(h)).toEqual(before); expect(fs.existsSync(path.join(repo, '.cursor'))).toBe(false);
  const bad = path.join(h, '.gemini/config/mcp_config.json'); fs.mkdirSync(path.dirname(bad), { recursive: true }); fs.writeFileSync(bad, '{broken');
  expect(() => autoConfigureAllClients(repo, h)).toThrow();
  expect(fs.existsSync(path.join(h, '.claude.json'))).toBe(false);
  expect(fs.existsSync(path.join(repo, '.cursor'))).toBe(false);
  expect(fs.readFileSync(bad, 'utf8')).toBe('{broken');
});

it('preserves custom Kith transports and updates only recognized generated TOML launcher fields', () => {
  const repo = repository(), h = home();
  const custom = path.join(repo, '.cursor/mcp.json'); writeJson(custom, { mcpServers: { kith: { url: 'https://example.invalid/mcp', headers: { Custom: 'retain' } } } });
  const bytes = fs.readFileSync(custom);
  const toml = path.join(h, '.codex/config.toml');
  const original = `# keep comment\nmodel = "retained"\n\n[mcp_servers.kith]\ncommand = ${JSON.stringify(process.execPath)}\nargs = ${JSON.stringify([fs.realpathSync(cli), 'mcp'])}\nenv_vars = ["KITH_AGENT_ID", "KITH_SESSION_TOKEN"]\n\n[mcp_servers.kith.env]\nCUSTOM = "retained"\n`;
  fs.writeFileSync(toml, original);
  const results = autoConfigureAllClients(repo, h);
  expect(results.find(r => r.clientName === 'Cursor')?.configured).toBe(false);
  expect(fs.readFileSync(custom)).toEqual(bytes);
  const updated = fs.readFileSync(toml, 'utf8');
  expect(updated).toContain('# keep comment'); expect(updated).toContain('CUSTOM = "retained"'); expect(updated).not.toContain('--repo');
  expect(updated).toContain('"KITH_SESSION_TOKEN"');
  expect(uninstallKith(h).ok).toBe(true); expect(fs.readFileSync(toml, 'utf8')).toBe(original);
});

it('refuses redirected config and backup paths without touching the destination', () => {
  const repo = repository(), h = home(), external = path.join(temp, 'outside.json');
  fs.writeFileSync(external, '{}'); fs.mkdirSync(path.join(repo, '.cursor'));
  fs.symlinkSync(external, path.join(repo, '.cursor/mcp.json'));
  expect(() => autoConfigureAllClients(repo, h)).toThrow(/redirected/);
  expect(fs.readFileSync(external, 'utf8')).toBe('{}'); expect(fs.existsSync(path.join(h, '.claude.json'))).toBe(false);
});

it('binds a real MCP connection launched at filesystem root to the explicit project', async () => {
  const repo = repository(), h = home();
  expect(() => discoverRepository(path.parse(repo).root)).toThrow(/filesystem root/);
  const transport = new StdioClientTransport({ command: process.execPath, args: [cli, 'mcp', '--repo', repo], cwd: path.parse(repo).root,
    env: { PATH: process.env.PATH!, HOME: h }, stderr: 'ignore' });
  const client = new Client({ name: 'root-launch-fixture', version: '1' });
  try {
    await client.connect(transport);
    const result = await client.callTool({ name: 'kith_get_status', arguments: {} });
    expect(result.isError).toBe(false); expect((result.structuredContent as any).repository.root).toBe(repo);
    expect(fs.existsSync(path.join(h, '.coord'))).toBe(false);
  } finally { await client.close(); }
});

it('discovers hidden linked worktrees and detects hotspots without unrelated-repo false positives', async () => {
  const repo = repository(), peer = linked(repo), unrelated = repository('unrelated');
  for (const dir of [repo, peer, unrelated]) fs.writeFileSync(path.join(dir, 'src/page.tsx'), `${path.basename(dir)} changed\n`);
  const watcher = new PassiveConflictWatcher(repo);
  expect(watcher.discoverGitRepos().sort()).toEqual([repo, peer].sort());
  const alerts = await watcher.scanOnce();
  expect(watcher.getScanState().complete).toBe(true);
  expect(alerts).toHaveLength(1); expect(alerts[0].filePath).toBe('src/page.tsx'); expect(alerts[0].repos.sort()).toEqual([repo, peer].sort());
  const all = await new PassiveConflictWatcher(temp).scanOnce(); expect(all).toHaveLength(1); expect(all[0].repos).not.toContain(unrelated);
});

it('compares full relative paths and NUL-delimited filenames rather than basenames', async () => {
  const repo = repository(), peer = linked(repo);
  fs.writeFileSync(path.join(repo, 'src/auth/index.ts'), 'left\n'); fs.writeFileSync(path.join(peer, 'src/billing/index.ts'), 'right\n');
  const watcher = new PassiveConflictWatcher(repo); expect(await watcher.scanOnce()).toEqual([]);
  for (const dir of [repo, peer]) fs.writeFileSync(path.join(dir, 'src/a b\n"x".ts'), `${path.basename(dir)} edited\n`);
  expect((await watcher.scanOnce()).map(a => a.filePath)).toEqual(['src/a b\n"x".ts']);
});

it('clears resolved alerts, emits a new onset after recurrence, and does not refresh unchanged edit ages', async () => {
  const repo = repository(), peer = linked(repo); let notifications = 0;
  const watcher = new PassiveConflictWatcher(repo, { onCollision: () => { notifications++; } });
  for (const dir of [repo, peer]) { const file = path.join(dir, 'src/page.tsx'); fs.writeFileSync(file, `${path.basename(dir)} changed\n`); fs.utimesSync(file, new Date(0), new Date(0)); }
  expect(await watcher.scanOnce()).toHaveLength(1); expect(watcher.getRecentEdits()).toEqual([]);
  expect(await watcher.scanOnce()).toHaveLength(1); expect(notifications).toBe(1);
  for (const dir of [repo, peer]) fs.writeFileSync(path.join(dir, 'src/page.tsx'), 'base\n');
  expect(await watcher.scanOnce()).toEqual([]); expect(watcher.getActiveCollisions()).toEqual([]);
  for (const dir of [repo, peer]) fs.writeFileSync(path.join(dir, 'src/page.tsx'), `${path.basename(dir)} changed again\n`);
  expect(await watcher.scanOnce()).toHaveLength(1); expect(notifications).toBe(2);
});

it('reports unavailable and returns nonzero for broken repositories instead of all clear', async () => {
  const broken = path.join(temp, 'broken'); fs.mkdirSync(broken); fs.writeFileSync(path.join(broken, '.git'), 'gitdir: /missing/kith-fixture\n');
  const watcher = new PassiveConflictWatcher(broken); expect(await watcher.scanOnce()).toEqual([]);
  expect(watcher.getScanState().complete).toBe(false); expect(watcher.getScanState().errors.length).toBeGreaterThan(0);
  const run = spawnSync(process.execPath, [cli, 'watch', broken, '--once', '--raw'], { encoding: 'utf8' });
  expect(run.status).toBe(1); expect(JSON.parse(run.stdout).complete).toBe(false); expect(run.stdout).not.toContain('All Clear');
  const unknown = new PassiveConflictWatcher(path.join(temp, 'missing')); await unknown.scanOnce(); expect(unknown.getScanState().complete).toBe(false);
});

it('refuses damaged coordination state before writing any client configuration', () => {
  const repo = repository(), h = home();
  fs.mkdirSync(path.join(repo, '.coord'), { recursive: true });
  fs.writeFileSync(path.join(repo, '.coord/state.db'), 'damaged state');
  expect(() => autoConfigureAllClients(repo, h)).toThrow();
  expect(fs.existsSync(path.join(h, '.claude.json'))).toBe(false);
  expect(fs.existsSync(path.join(repo, '.cursor'))).toBe(false);
  expect(fs.readFileSync(path.join(repo, '.coord/state.db'), 'utf8')).toBe('damaged state');
});

it('suppresses identical dirty copies and deletions, but retains unverified large files', async () => {
  const repo = repository(), peer = linked(repo);
  const watcher = new PassiveConflictWatcher(repo);
  for (const dir of [repo, peer]) fs.writeFileSync(path.join(dir, 'src/page.tsx'), 'same edit\n');
  expect(await watcher.scanOnce()).toEqual([]);
  fs.writeFileSync(path.join(peer, 'src/page.tsx'), 'different edit\n');
  expect(await watcher.scanOnce()).toHaveLength(1);
  for (const dir of [repo, peer]) fs.unlinkSync(path.join(dir, 'src/page.tsx'));
  expect(await watcher.scanOnce()).toEqual([]);
  for (const dir of [repo, peer]) fs.writeFileSync(path.join(dir, 'src/page.tsx'), Buffer.alloc(8 * 1024 * 1024 + 1));
  expect(await watcher.scanOnce()).toHaveLength(1);
  expect(watcher.getScanState().complete).toBe(true);
});

it('sets up global clients from home or filesystem root without creating a project database', () => {
  const h = home();
  for (const cwd of [h, path.parse(h).root]) {
    const results = autoConfigureAllClients(cwd, h);
    expect(results.find(r => r.clientName === 'Cursor')?.configured).toBe(false);
    expect(JSON.parse(fs.readFileSync(path.join(h, '.claude.json'), 'utf8')).mcpServers.kith.args).toEqual([fs.realpathSync(cli), 'mcp']);
    expect(fs.existsSync(path.join(h, '.coord/state.db'))).toBe(false);
    expect(fs.existsSync(path.join(h, '.cursor'))).toBe(false);
  }
  expect(uninstallKith(h).ok).toBe(true);
});
