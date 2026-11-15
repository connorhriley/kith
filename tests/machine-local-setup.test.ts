import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { initializeKithRepository } from '../src/cli/init.js';
import { uninstallKith } from '../src/cli/setup-ledger.js';

// `kith init` writes client configuration that embeds this machine's paths. It must not turn every
// repository into a permanently dirty tree or invite those files into a commit.

let root: string;
beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'kith-machine-local-')); });
afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });
const git = (...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const status = () => git('status', '--porcelain', '--untracked-files=all').split('\n').filter(Boolean).map(line => line.slice(3));
const exclude = () => fs.readFileSync(path.join(root, '.git/info/exclude'), 'utf8');
const setup = { integrations: ['claude', 'codex', 'cursor', 'agents'] as const, mcpOnly: false };

it('hides the machine-local files it creates from git status, and only those', () => {
  git('init');
  initializeKithRepository(root, 'kith', { ...setup, integrations: [...setup.integrations] });
  const visible = status();
  for (const local of ['.mcp.json', '.claude/settings.json', '.cursor/mcp.json', '.cursor/hooks.json', '.codex/config.toml', '.agent/skills/kith/SKILL.md']) {
    expect(fs.existsSync(path.join(root, local)), local).toBe(true);
    expect(visible, local).not.toContain(local);
  }
  // The shared files stay visible: they are meant to be reviewed and committed.
  expect(visible).toContain('AGENTS.md');
  expect(visible).toContain('.gitignore');
  expect(exclude()).toContain('/.mcp.json');
});

it('never hides a file that already existed or is already tracked', () => {
  git('init'); git('config', 'user.email', 't@example.test'); git('config', 'user.name', 'T');
  fs.writeFileSync(path.join(root, '.mcp.json'), JSON.stringify({ mcpServers: {} }));
  fs.mkdirSync(path.join(root, '.cursor'));
  fs.writeFileSync(path.join(root, '.cursor/hooks.json'), JSON.stringify({ version: 1, hooks: {} }));
  git('add', '.cursor/hooks.json'); git('commit', '-m', 'track cursor hooks');
  initializeKithRepository(root, 'kith', { ...setup, integrations: [...setup.integrations] });
  expect(status()).toContain('.mcp.json');          // pre-existing and untracked: the user's, so it stays visible
  expect(status()).toContain('.cursor/hooks.json'); // tracked and now modified: must show as a change
  expect(exclude()).not.toContain('/.mcp.json');
  expect(exclude()).not.toContain('/.cursor/hooks.json');
  expect(status()).not.toContain('.codex/config.toml'); // created from nothing: hidden
});

it('is idempotent, and uninstall restores the exclude file exactly', () => {
  git('init');
  const original = exclude();
  initializeKithRepository(root, 'kith', { ...setup, integrations: [...setup.integrations] });
  const once = exclude();
  expect(once).not.toBe(original);
  expect(initializeKithRepository(root, 'kith', { ...setup, integrations: [...setup.integrations] }).configuredFiles).toEqual([]);
  expect(exclude()).toBe(once);
  expect(once.match(/\/\.mcp\.json/g)).toHaveLength(1);
  const report = uninstallKith(root);
  expect(report.ok, JSON.stringify(report)).toBe(true);
  expect(exclude()).toBe(original);
});

it('leaves a repository that already ignores the file alone', () => {
  git('init');
  fs.writeFileSync(path.join(root, '.gitignore'), '.coord/\n.mcp.json\n');
  initializeKithRepository(root, 'kith', { ...setup, integrations: [...setup.integrations] });
  expect(exclude()).not.toContain('/.mcp.json');
});
