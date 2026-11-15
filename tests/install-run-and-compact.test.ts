import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { KithEngine } from '../src/index.js';
import { uninstallKith } from '../src/cli/setup-ledger.js';
import { doctorReport } from '../src/cli/doctor.js';

const cli = path.resolve('dist/cli/index.js');

let temp: string;
const clients: Client[] = [];
const engines: KithEngine[] = [];

beforeEach(() => {
  temp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kith-install-compact-')));
});

afterEach(async () => {
  await Promise.all(clients.splice(0).map(c => c.close()));
  for (const engine of engines.splice(0)) {
    try { engine.close(); } catch { /* Already closed. */ }
  }
  fs.rmSync(temp, { recursive: true, force: true });
});

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function createRepo(name = 'repo'): string {
  const dir = path.join(temp, name);
  fs.mkdirSync(dir, { recursive: true });
  git(dir, 'init', '-b', 'main');
  git(dir, 'config', 'user.email', 'test@example.invalid');
  git(dir, 'config', 'user.name', 'Test');
  fs.writeFileSync(path.join(dir, '.gitignore'), '.coord/\n');
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'src/api.mjs'), 'export const apiVersion = 1;\n');
  git(dir, 'add', '.');
  git(dir, 'commit', '-m', 'seed');
  return dir;
}

function cleanEnv(home: string): Record<string, string> {
  return {
    ...Object.fromEntries(
      Object.entries(process.env).filter(([k, v]) => v !== undefined && !k.startsWith('KITH_') && !k.startsWith('GIT_') && k !== 'CLAUDE_PROJECT_DIR')
    ) as Record<string, string>,
    HOME: home,
    USERPROFILE: home,
  };
}

async function connectMcp(args: string[], cwd: string, env: Record<string, string>): Promise<Client> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [cli, ...args],
    cwd,
    env,
    stderr: 'ignore',
  });
  const client = new Client({ name: 'kith-test-client', version: '1.0.0' });
  clients.push(client);
  await client.connect(transport);
  return client;
}

describe('compact MCP, install, passive hooks, kith run, and human output', () => {
  it('cuts MCP schema bytes substantially in --compact mode and runs full workflow end-to-end', async () => {
    const repo = createRepo();
    const home = path.join(temp, 'home');
    fs.mkdirSync(home, { recursive: true });
    const env = cleanEnv(home);

    const fullClient = await connectMcp(['mcp', '--repo', repo], repo, env);
    const compactClient = await connectMcp(['mcp', '--compact', '--repo', repo], repo, env);
    const peerClient = await connectMcp(['mcp', '--compact', '--repo', repo], repo, env);

    const fullTools = await fullClient.listTools();
    const compactTools = await compactClient.listTools();

    expect(fullTools.tools).toHaveLength(17);
    expect(compactTools.tools.map(t => t.name)).toEqual([
      'kith_brief',
      'kith_work',
      'kith_claim',
      'kith_handoff',
      'kith_finish',
      'kith_resource',
    ]);

    const fullBytes = Buffer.byteLength(JSON.stringify(fullTools.tools), 'utf8');
    const compactBytes = Buffer.byteLength(JSON.stringify(compactTools.tools), 'utf8');
    expect(compactBytes).toBeLessThan(fullBytes * 0.45);

    const briefRes = await compactClient.callTool({ name: 'kith_brief', arguments: {} });
    expect(briefRes.isError).toBe(false);
    expect((briefRes.structuredContent as any).brief.empty).toBe(true);

    const workRes = await compactClient.callTool({
      name: 'kith_work',
      arguments: { agentId: 'alpha', title: 'Add compact route', scopeGlobs: ['src/route.mjs'], isolateWorktree: true },
    });
    expect(workRes.isError).toBe(false);
    const workData = workRes.structuredContent as any;
    expect(workData.worktree.worktreePath).toBeTruthy();

    // Another client without sessionToken cannot hijack alpha's session
    const hijack = await peerClient.callTool({
      name: 'kith_finish',
      arguments: { agentId: 'alpha' },
    });
    expect(hijack.isError).toBe(true);

    const fileInWt = path.join(workData.worktree.worktreePath, 'src/route.mjs');
    fs.writeFileSync(fileInWt, 'export const routeReady = true;\n');
    const editRes = await compactClient.callTool({
      name: 'kith_claim',
      arguments: { action: 'edit', agentId: 'alpha', filePath: fileInWt },
    });
    expect(editRes.isError).toBe(false);
    expect((editRes.structuredContent as any).upsertedCount).toBe(1);

    git(workData.worktree.worktreePath, 'add', '.');
    git(workData.worktree.worktreePath, 'commit', '-m', 'add route');

    const preview = await compactClient.callTool({
      name: 'kith_finish',
      arguments: { agentId: 'alpha', previewOnly: true },
    });
    expect((preview.structuredContent as any).clean).toBe(true);

    const finish = await compactClient.callTool({
      name: 'kith_finish',
      arguments: { agentId: 'alpha', verificationCmd: `${JSON.stringify(process.execPath)} --check src/route.mjs` },
    });
    expect(finish.isError).toBe(false);
    expect((finish.structuredContent as any).ok).toBe(true);
    expect(fs.existsSync(path.join(repo, 'src/route.mjs'))).toBe(true);
  });

  it('installs --compact MCP and reversible global hooks without dirtying the repo, and passes doctor', async () => {
    const repo = createRepo();
    const home = path.join(temp, 'home');
    fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
    const origClaudeJson = JSON.stringify({ mcpServers: { existing: { command: 'keep' } }, theme: 'dark' }) + '\n';
    const origSettingsJson = JSON.stringify({
      permissions: { allow: ['Read'] },
      hooks: {
        PreToolUse: [{ matcher: 'Read', hooks: [{ type: 'command', command: 'echo user-hook' }] }],
      },
    }) + '\n';
    fs.writeFileSync(path.join(home, '.claude.json'), origClaudeJson);
    fs.writeFileSync(path.join(home, '.claude/settings.json'), origSettingsJson);

    const env = cleanEnv(home);
    const res = spawnSync(process.execPath, [cli, 'install', repo, '--no-radar', '--json'], {
      cwd: repo,
      env,
      encoding: 'utf8',
    });
    expect(res.status, res.stderr).toBe(0);
    const report = JSON.parse(res.stdout);
    expect(report.ok).toBe(true);
    expect(report.profile).toBe('compact');
    expect(report.globalHooks.configured).toBe(true);
    expect(report.globalHooks.events).toEqual(['SessionStart', 'PreToolUse', 'PostToolUse', 'Stop']);

    // Repo stays completely clean (no AGENTS.md or .mcp.json generated by default install)
    expect(git(repo, 'status', '--porcelain')).toBe('');
    expect(fs.existsSync(path.join(repo, '.coord'))).toBe(false);

    const claudeCfg = JSON.parse(fs.readFileSync(path.join(home, '.claude.json'), 'utf8'));
    expect(claudeCfg.mcpServers.existing.command).toBe('keep');
    expect(claudeCfg.mcpServers.kith.args).toContain('--compact');

    const settingsCfg = JSON.parse(fs.readFileSync(path.join(home, '.claude/settings.json'), 'utf8'));
    expect(settingsCfg.permissions.allow).toEqual(['Read']);
    expect(settingsCfg.hooks.PreToolUse).toHaveLength(2);
    expect(settingsCfg.hooks.PreToolUse[0].hooks[0].command).toBe('echo user-hook');
    expect(settingsCfg.hooks.SessionStart[0].hooks[0].command).toContain('hook session-start');

    // Solo session-start emits 0 bytes and creates 0 .coord files
    const soloStart = spawnSync(process.execPath, [cli, 'hook', 'session-start'], {
      cwd: repo,
      env,
      input: JSON.stringify({ cwd: repo }),
      encoding: 'utf8',
    });
    expect(soloStart.status).toBe(0);
    expect(soloStart.stdout).toBe('');
    expect(fs.existsSync(path.join(repo, '.coord'))).toBe(false);

    // Doctor accepts compact MCP launcher
    const doc = doctorReport(repo, home);
    expect(doc.ok, JSON.stringify(doc)).toBe(true);

    // Uninstall in home restores both ~/.claude.json and ~/.claude/settings.json byte-for-byte
    const uninstalled = uninstallKith(home);
    expect(uninstalled.ok).toBe(true);
    expect(fs.readFileSync(path.join(home, '.claude.json'), 'utf8')).toBe(origClaudeJson);
    expect(fs.readFileSync(path.join(home, '.claude/settings.json'), 'utf8')).toBe(origSettingsJson);
  });

  it('launches kith run cleanly solo and isolates parallel runs automatically', () => {
    const repo = createRepo();
    const home = path.join(temp, 'home');
    fs.mkdirSync(home, { recursive: true });
    const env = cleanEnv(home);

    const outFile = path.join(temp, 'solo-env.json');
    const solo = spawnSync(
      process.execPath,
      [
        cli,
        '--repo',
        repo,
        'run',
        '--agent',
        'solo-runner',
        '--',
        process.execPath,
        '-e',
        `require('node:fs').writeFileSync(${JSON.stringify(outFile)}, JSON.stringify({ id: process.env.KITH_AGENT_ID, hasToken: Boolean(process.env.KITH_SESSION_TOKEN), wt: process.env.KITH_WORKTREE || null }))`,
      ],
      { cwd: repo, env, encoding: 'utf8' }
    );
    expect(solo.status, solo.stderr).toBe(0);
    const soloSeen = JSON.parse(fs.readFileSync(outFile, 'utf8'));
    expect(soloSeen).toEqual({ id: 'solo-runner', hasToken: true, wt: null });

    // Start a peer session so second kith run auto-isolates in a worktree
    const engine = new KithEngine(repo);
    engines.push(engine);
    engine.fencing.registerAgent({ id: 'peer-1' });
    engine.beginWork({ agentId: 'peer-1', title: 'Peer active', scopeGlobs: ['src/other.mjs'] });

    const wtFile = path.join(temp, 'parallel-env.json');
    const parallel = spawnSync(
      process.execPath,
      [
        cli,
        '--repo',
        repo,
        'run',
        '--agent',
        'parallel-runner',
        '--',
        process.execPath,
        '-e',
        `const fs = require('node:fs'); fs.writeFileSync(${JSON.stringify(wtFile)}, JSON.stringify({ cwd: fs.realpathSync(process.cwd()), wt: process.env.KITH_WORKTREE, sameCwd: fs.realpathSync(process.cwd()) === fs.realpathSync(process.env.KITH_WORKTREE) }))`,
      ],
      { cwd: repo, env, encoding: 'utf8' }
    );
    expect(parallel.status, parallel.stderr).toBe(0);
    const parSeen = JSON.parse(fs.readFileSync(wtFile, 'utf8'));
    expect(parSeen.wt).toBeTruthy();
    expect(parSeen.sameCwd).toBe(true);
    // Untouched worktree is automatically removed on clean exit
    expect(fs.existsSync(parSeen.wt)).toBe(false);
  });

  it('supports --human terminal summaries while preserving non-TTY JSON output', () => {
    const repo = createRepo();
    const env = cleanEnv(temp);

    const statusJson = spawnSync(process.execPath, [cli, '--repo', repo, 'status', '--offline'], { cwd: repo, env, encoding: 'utf8' });
    expect(statusJson.status).toBe(0);
    expect(() => JSON.parse(statusJson.stdout)).not.toThrow();

    const statusHuman = spawnSync(process.execPath, [cli, '--repo', repo, 'status', '--offline', '--human'], { cwd: repo, env, encoding: 'utf8' });
    expect(statusHuman.status).toBe(0);
    expect(statusHuman.stdout).toContain('Active agents: none');

    const gcHuman = spawnSync(process.execPath, [cli, '--repo', repo, 'gc', '--human'], { cwd: repo, env, encoding: 'utf8' });
    expect(gcHuman.status).toBe(0);
    expect(gcHuman.stdout).toContain('nothing to prune');
  });
});
