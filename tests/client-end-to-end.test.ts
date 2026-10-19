import { execFileSync, spawnSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import { once } from 'node:events';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { KithEngine } from '../src/index.js';
import { initializeKithRepository } from '../src/cli/init.js';

const cli = path.resolve('dist/cli/index.js');
const quote = (text: string) => "'" + text.replace(/'/g, "'\\''") + "'";
const clients: Client[] = [];
let root: string;
let bin: string;
let env: Record<string, string>;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "kith client ' "));
  bin = fs.mkdtempSync(path.join(os.tmpdir(), 'kith-client-bin-'));
  env = Object.fromEntries(Object.entries(process.env).filter(([key, value]) => value !== undefined && !key.startsWith('KITH_'))) as Record<string, string>;
  env.PATH = `${bin}:${env.PATH}`;
  fs.writeFileSync(path.join(bin, 'kith'), `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(cli)} "$@"\n`, { mode: 0o755 });
});
afterEach(async () => {
  await Promise.all(clients.splice(0).map((c) => c.close()));
  fs.rmSync(root, { recursive: true, force: true }); fs.rmSync(bin, { recursive: true, force: true });
});
async function connect(directory = root, discover = false) {
  const transport = new StdioClientTransport({ command: process.execPath, args: [cli, 'mcp', ...(discover ? [] : ['--repo', directory])], cwd: directory, env, stderr: 'pipe' });
  transport.stderr?.on('data', () => {});
  const client = new Client({ name: 'kith-end-to-end', version: '1.0.0' }); clients.push(client);
  await client.connect(transport); return { client, transport };
}
async function tool(client: Client, name: string, args: Record<string, unknown>) {
  return client.callTool({ name, arguments: args });
}
function data(result: any): any {
  expect(result.isError, JSON.stringify(result.content)).not.toBe(true);
  const content = result.structuredContent ?? JSON.parse(result.content[0].text);
  expect(JSON.parse(result.content[0].text)).toEqual(content);
  return content;
}
function run(args: string[], session?: { id: string; token: string }) {
  return spawnSync(process.execPath, [cli, '--repo', root, ...args], { cwd: root, encoding: 'utf8', input: '',
    env: { ...env, ...(session ? { KITH_AGENT_ID: session.id, KITH_SESSION_TOKEN: session.token } : {}) } });
}
function git(...args: string[]) { return execFileSync('git', args, { cwd: root, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }); }
function seed() {
  git('init'); git('config', 'user.email', 'test@example.test'); git('config', 'user.name', 'Test');
  fs.writeFileSync(path.join(root, '.gitignore'), '.coord/\n.codex/\n.claude/\n.cursor/\n.mcp.json\nAGENTS.md\n.agent/\n');
  fs.mkdirSync(path.join(root, 'src')); fs.writeFileSync(path.join(root, 'src/base.mjs'), 'export const base = 1;\n');
  git('add', '.'); git('commit', '-m', 'seed');
}

it('uses real MCP initialize/list/call flows and isolates two client session owners', async () => {
  const one = await connect(); const two = await connect();
  expect((await one.client.listTools()).tools.map((t) => t.name)).toContain('kith_heartbeat');
  const begun = data(await tool(one.client, 'kith_begin_work', { agentId: 'owner', title: 'Auth work', scopeGlobs: ['src/auth/**'] }));
  expect(begun.sessionToken).toHaveLength(43);
  expect((await tool(two.client, 'kith_begin_work', { agentId: 'owner', title: 'Take over', scopeGlobs: ['src/auth/**'] })).isError).toBe(true);
  expect((await tool(two.client, 'kith_complete_work', { agentId: 'owner' })).isError).toBe(true);
  const conflict = await tool(two.client, 'kith_begin_work', { agentId: 'peer', title: 'Billing integration', scopeGlobs: ['src/auth/a.ts'], force: true });
  expect(conflict.isError).toBe(true);
  const status = data(await tool(two.client, 'kith_get_status', {}));
  expect(status.locks[0].owner_agent_id).toBe('owner');
  expect(JSON.stringify(status)).not.toContain(begun.sessionToken);
  const resumed = data(await tool(two.client, 'kith_heartbeat', { agentId: 'owner', sessionToken: begun.sessionToken }));
  expect(resumed.agent.pid).toBe(one.transport.pid);
});

it('rejects stale tokens after expiry and requeues work when an MCP process disconnects', async () => {
  const one = await connect();
  const session = data(await tool(one.client, 'kith_start_session', { agentId: 'short', leaseDurationMs: 500 }));
  await new Promise((resolve) => setTimeout(resolve, 700));
  expect((await tool(one.client, 'kith_heartbeat', { agentId: 'short', sessionToken: session.sessionToken })).isError).toBe(true);
  data(await tool(one.client, 'kith_add_task', { id: 'job', title: 'Pending task', scopeGlobs: ['src/**'] }));
  data(await tool(one.client, 'kith_claim_next_task', { agentId: 'worker' }));
  await one.client.close();
  const engine = new KithEngine(root);
  try {
    engine.fencing.reapDeadAgents();
    expect(engine.intents.getTask('job')?.status).toBe('queued');
    expect(engine.locks.listLocks()).toEqual([]);
  } finally { engine.close(); }
});

it('runs generated client hooks, worktree edit reports, verification and completion with one session capability', async () => {
  seed();
  initializeKithRepository(root, `${quote(process.execPath)} ${quote(cli)}`);
  // Start the server using the actual generated project MCP command/arguments.
  const config = JSON.parse(fs.readFileSync(path.join(root, '.mcp.json'), 'utf8')).mcpServers.kith;
  const transport = new StdioClientTransport({ ...config, cwd: root, env, stderr: 'pipe' });
  transport.stderr?.on('data', () => {});
  const client = new Client({ name: 'generated-config-client', version: '1.0.0' }); clients.push(client);
  await client.connect(transport);
  const work = data(await tool(client, 'kith_begin_work', { agentId: 'worker', title: 'Add feature module', scopeGlobs: ['src/**'], isolateWorktree: true }));
  const session = { id: 'worker', token: work.sessionToken };
  const hookEnv = { ...env, KITH_AGENT_ID: session.id, KITH_SESSION_TOKEN: session.token };
  const file = path.join(work.worktree.worktreePath, 'src/feature.mjs');
  const hooks = JSON.parse(fs.readFileSync(path.join(root, '.claude/settings.json'), 'utf8')).hooks;
  const input = JSON.stringify({ session_id: 'client-session', tool_name: 'Write', tool_input: { file_path: file } });
  const nested = path.join(root, 'src');
  const pre = spawnSync('sh', ['-c', hooks.PreToolUse[0].hooks[0].command], { cwd: nested, env: hookEnv, input, encoding: 'utf8' });
  expect(pre.status, pre.stderr).toBe(0);
  fs.writeFileSync(file, 'export const feature = 42;\n');
  const post = spawnSync('sh', ['-c', hooks.PostToolUse[0].hooks[0].command], { cwd: nested, env: hookEnv, input, encoding: 'utf8' });
  expect(post.status, post.stderr).toBe(0);
  const status = data(await tool(client, 'kith_get_status', { agentId: 'worker' }));
  expect(status.contracts.some((c: any) => c.file_path === 'src/feature.mjs' && c.symbol_name === 'feature')).toBe(true);
  expect(fs.existsSync(path.join(root, 'src/feature.mjs'))).toBe(false);
  const completed = data(await tool(client, 'kith_complete_work', { agentId: 'worker', verificationCmd: 'node --check src/feature.mjs' }));
  expect(completed.ok).toBe(true);
  expect(fs.readFileSync(path.join(root, 'src/feature.mjs'), 'utf8')).toContain('feature = 42');
  expect(fs.existsSync(work.worktree.worktreePath)).toBe(true);
  const reopened = run(['session', 'start', '--agent', 'worker', '--new'], session);
  expect(reopened.status, reopened.stderr).toBe(0);
  const maintenance = JSON.parse(reopened.stdout);
  const removed = run(['worktree', 'remove'], { id: 'worker', token: maintenance.sessionToken });
  expect(removed.status, removed.stderr).toBe(0);
});

it('blocks generated edit hooks with missing, forged or completed session credentials', () => {
  initializeKithRepository(root, `${quote(process.execPath)} ${quote(cli)}`, { integrations: ['claude'] });
  const start = run(['session', 'start', '--agent', 'worker']);
  const session = { id: 'worker', token: JSON.parse(start.stdout).sessionToken };
  expect(run(['hook', 'pre', '--tool', 'Edit', '--file', 'file.ts']).status).toBe(2);
  expect(run(['hook', 'pre', '--tool', 'Edit', '--file', 'file.ts'], { ...session, token: 'forged' }).status).toBe(2);
  expect(run(['hook', 'pre', '--tool', 'Edit', '--file', 'file.ts'], session).status).toBe(0);
  expect(run(['complete'], session).status).toBe(0);
  expect(run(['hook', 'pre', '--tool', 'Edit', '--file', 'file.ts'], session).status).toBe(2);
});


it('stops a shared CLI mutex command when its owning MCP connection goes away', async () => {
  const { client } = await connect();
  const session = data(await tool(client, 'kith_start_session', { agentId: 'shared' }));
  const pidFile = path.join(root, 'shared-command');
  const script = `require('node:fs').writeFileSync(${JSON.stringify(pidFile)},String(process.pid));setInterval(()=>{},1000);`;
  const child = spawn(process.execPath, [cli, '--repo', root, 'mutex', '--lease-ms', '1200', '--', process.execPath, '-e', script], {
    cwd: root, env: { ...env, KITH_AGENT_ID: 'shared', KITH_SESSION_TOKEN: session.sessionToken }, stdio: 'ignore',
  });
  const exited = once(child, 'exit');
  try {
    const deadline = Date.now() + 10000;
    while (!fs.existsSync(pidFile)) {
      if (child.exitCode !== null || Date.now() > deadline) throw new Error('Shared command did not start');
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    const pid = Number(fs.readFileSync(pidFile, 'utf8'));
    await client.close();
    const [code] = await exited;
    expect(code).not.toBe(0);
    expect(() => process.kill(pid, 0)).toThrow();
    const engine = new KithEngine(root);
    try {
      engine.fencing.registerAgent({ id: 'replacement' });
      expect(engine.broker.tryAcquireMutex({ agentId: 'replacement', mutexName: 'default-mutex' }).acquired).toBe(true);
    } finally { engine.close(); }
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  }
});


it('runs a package manager shim inside an already guarded install without reacquiring its own mutex', () => {
  initializeKithRepository(root, `${quote(process.execPath)} ${quote(cli)}`, { integrations: ['shims'] });
  fs.writeFileSync(path.join(bin, 'npm'), '#!/usr/bin/env node\nprocess.stdout.write(JSON.stringify(process.argv.slice(2)));\n', { mode: 0o755 });
  const result = spawnSync(process.execPath, [cli, '--repo', root, 'mutex', '--name', 'package-install', '--', 'npm', 'install', 'literal package'], {
    cwd: root, env: { ...env, PATH: `${path.join(root, '.coord/bin')}:${env.PATH}` }, encoding: 'utf8', timeout: 8000,
  });
  expect(result.status, result.stderr).toBe(0);
  expect(JSON.parse(result.stdout)).toEqual(['install', 'literal package']);
});


it('bootstraps capabilities portably through real shell command substitution', () => {
  const shells = ['/bin/sh', '/bin/bash', '/bin/zsh'].filter((shell) => fs.existsSync(shell));
  for (let i = 0; i < shells.length; i++) {
    const command = `${quote(process.execPath)} ${quote(cli)} --repo ${quote(root)}`;
    const script = `set -e\neval "$(${command} session start --agent shell-${i} --owner-pid "$$" --shell)"\n${command} heartbeat >/dev/null\n${command} session end >/dev/null\n`;
    const result = spawnSync(shells[i], ['-c', script], { env, cwd: root, encoding: 'utf8', timeout: 10000 });
    expect(result.status, `${shells[i]}: ${result.stderr}`).toBe(0);
  }
  expect(run(['session', 'start', '--agent', 'missing-owner', '--shell']).stderr).toContain('--owner-pid');
});

it('runs literal commands through MCP with renewable mutex leases and owned worktree cwd', async () => {
  seed();
  const one = await connect(); const two = await connect();
  data(await tool(one.client, 'kith_begin_work', { agentId: 'command-owner', title: 'Command verification', scopeGlobs: ['src/native.mjs'], isolateWorktree: true }));
  expect((await tool(two.client, 'kith_run_with_mutex', { agentId: 'command-owner', mutexName: 'native', command: [process.execPath, '-v'] })).isError).toBe(true);
  const command = [process.execPath, '-e', 'setTimeout(()=>process.stdout.write(JSON.stringify({cwd:process.cwd(),arg:process.argv[1]})),900)', 'literal $value; words'];
  const pending = tool(one.client, 'kith_run_with_mutex', { agentId: 'command-owner', mutexName: 'native', command, leaseDurationMs: 250 });
  await new Promise((resolve) => setTimeout(resolve, 450));
  const engine = new KithEngine(root);
  try {
    engine.fencing.registerAgent({ id: 'peer' });
    expect(engine.broker.tryAcquireMutex({ agentId: 'peer', mutexName: 'native' }).acquired).toBe(false);
    const result = data(await pending);
    const output = JSON.parse(result.stdout);
    expect(fs.realpathSync(output.cwd)).toBe(fs.realpathSync(engine.fencing.getAgent('command-owner')!.worktree_path!));
    expect(output.arg).toBe('literal $value; words');
    const grant = engine.broker.tryAcquireMutex({ agentId: 'peer', mutexName: 'native' });
    expect(grant.acquired).toBe(true);
    engine.broker.releaseMutex({ agentId: 'peer', mutexName: 'native', fencingToken: grant.fencingToken });
  } finally { engine.close(); }
  const failed = await tool(one.client, 'kith_run_with_mutex', { agentId: 'command-owner', mutexName: 'native', command: [process.execPath, '-e', 'process.exit(7)'] });
  expect(failed.isError).toBe(true);
  expect((failed.structuredContent as any).exitCode).toBe(7);
  expect((await tool(one.client, 'kith_run_with_mutex', { agentId: 'command-owner', mutexName: 'native', command: [process.execPath, '-v'], cwd: path.parse(root).root })).isError).toBe(true);
});

it('cancels an MCP mutex command on request cancellation and connection loss before handoff', async () => {
  for (const disconnect of [false, true]) {
    const { client } = await connect();
    const id = `cancel-${disconnect}`;
    data(await tool(client, 'kith_start_session', { agentId: id }));
    const pidFile = path.join(root, `pid-${disconnect}`);
    const controller = new AbortController();
    const pending = client.callTool({ name: 'kith_run_with_mutex', arguments: { agentId: id, mutexName: 'cancel', leaseDurationMs: 300,
      command: [process.execPath, '-e', `require('node:fs').writeFileSync(${JSON.stringify(pidFile)},String(process.pid));setInterval(()=>{},1000)`] } }, undefined, { signal: controller.signal })
      .then((value) => ({ value }), (error) => ({ error }));
    const deadline = Date.now() + 10000;
    while (!fs.existsSync(pidFile) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
    expect(fs.existsSync(pidFile)).toBe(true);
    const pid = Number(fs.readFileSync(pidFile, 'utf8'));
    if (disconnect) await client.close(); else controller.abort();
    expect(await pending).toHaveProperty('error');
    const stopped = () => { try { process.kill(pid, 0); return false; } catch { return true; } };
    while (!stopped() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
    expect(stopped()).toBe(true);
    const engine = new KithEngine(root);
    try {
      engine.fencing.registerAgent({ id: `peer-${disconnect}` });
      const grant = engine.broker.tryAcquireMutex({ agentId: `peer-${disconnect}`, mutexName: 'cancel' });
      expect(grant.acquired).toBe(true);
      engine.broker.releaseMutex({ agentId: `peer-${disconnect}`, mutexName: 'cancel', fencingToken: grant.fencingToken });
    } finally { engine.close(); }
  }
});

it('stops a disconnected borrowed-session MCP command while preserving the original owner', async () => {
  const engine = new KithEngine(root);
  const session = engine.fencing.registerAgent({ id: 'borrowed' });
  env.KITH_AGENT_ID = 'borrowed'; env.KITH_SESSION_TOKEN = session.sessionToken;
  const { client } = await connect();
  const pidFile = path.join(root, 'borrowed-command');
  const pending = tool(client, 'kith_run_with_mutex', { agentId: 'borrowed', mutexName: 'borrowed-command', leaseDurationMs: 300,
    command: [process.execPath, '-e', `require('node:fs').writeFileSync(${JSON.stringify(pidFile)},String(process.pid));setInterval(()=>{},1000)`] }).catch(() => undefined);
  try {
    const deadline = Date.now() + 10000;
    while (!fs.existsSync(pidFile) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
    expect(fs.existsSync(pidFile)).toBe(true);
    const pid = Number(fs.readFileSync(pidFile, 'utf8'));
    await client.close(); await pending;
    const alive = () => { try { process.kill(pid, 0); return true; } catch { return false; } };
    while (alive() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
    expect(alive()).toBe(false);
    expect(engine.fencing.getAgent('borrowed')?.status).toBe('active');
    expect(engine.fencing.getAgent('borrowed')?.pid).toBe(process.pid);
    expect(engine.broker.listResources().filter((r) => r.type === 'mutex')).toEqual([]);
  } finally { engine.close(); }
});


it('shares real MCP clients across linked checkout/subdirectory discovery and guards that checkout index', async () => {
  seed();
  const linked = path.join(root, '.coord/worktrees/manual');
  git('worktree', 'add', '-b', 'manual-linked', linked);
  const one = await connect(path.join(root, 'src'), true);
  const two = await connect(path.join(linked, 'src'), true);
  data(await tool(one.client, 'kith_begin_work', { agentId: 'owner', title: 'Protected base module', scopeGlobs: ['src/base.mjs'] }));
  expect((await tool(two.client, 'kith_begin_work', { agentId: 'peer', title: 'Try conflicting scope', scopeGlobs: ['src/base.mjs'], force: true })).isError).toBe(true);
  const begun = data(await tool(two.client, 'kith_begin_work', { agentId: 'peer', title: 'Linked route implementation', scopeGlobs: ['src/routes/**'], force: true }));
  const file = path.join(linked, 'src/routes/[id]/route.mjs');
  fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, 'export function route() { return 1; }\n');
  const tokenEnv = { ...env, KITH_AGENT_ID: 'peer', KITH_SESSION_TOKEN: begun.sessionToken };
  const pre = spawnSync(process.execPath, [cli, 'hook', 'pre'], { cwd: path.join(linked, 'src'), env: tokenEnv, encoding: 'utf8',
    input: JSON.stringify({ tool_name: 'Write', tool_input: { file_path: file } }) });
  expect(pre.status, pre.stderr).toBe(0);
  const post = spawnSync(process.execPath, [cli, 'hook', 'post'], { cwd: path.join(linked, 'src'), env: tokenEnv, encoding: 'utf8',
    input: JSON.stringify({ tool_name: 'Write', tool_input: { file_path: file } }) });
  expect(post.status, post.stderr).toBe(0);
  const status = data(await tool(one.client, 'kith_get_status', {}));
  expect(status.repository.root).toBe(fs.realpathSync(root));
  expect(status.repository.coordDir).toBe(path.join(fs.realpathSync(root), '.coord'));
  expect(status.agents.find((a: any) => a.id === 'peer').worktree_path).toBe(fs.realpathSync(linked));
  expect(status.contracts.some((c: any) => c.file_path === 'src/routes/[id]/route.mjs')).toBe(true);
  // Main's index is clean. Only the linked index stages a forbidden edit.
  fs.writeFileSync(path.join(linked, 'src/base.mjs'), 'export const base = 2;\n');
  execFileSync('git', ['add', 'src/base.mjs'], { cwd: linked, env });
  const guard = spawnSync(process.execPath, [cli, '--repo', root, 'hook', 'pre-commit'], { cwd: linked, env: tokenEnv, encoding: 'utf8', input: '' });
  expect(guard.status).toBe(1);
  expect(guard.stdout + guard.stderr).toContain('owner');
  const mainStatus = spawnSync(process.execPath, [cli, 'status'], { cwd: path.join(root, 'src'), env, encoding: 'utf8' });
  expect(mainStatus.status).toBe(0);
  expect(JSON.parse(mainStatus.stdout).agents.some((a: any) => a.id === 'owner')).toBe(true);
});


it('uses generated MCP-only onboarding with no exported capability or installed edit hooks', async () => {
  seed();
  initializeKithRepository(root, 'kith', { integrations: ['claude', 'agents'], mcpOnly: true });
  expect(fs.existsSync(path.join(root, '.claude/settings.json'))).toBe(false);
  const config = JSON.parse(fs.readFileSync(path.join(root, '.mcp.json'), 'utf8')).mcpServers.kith;
  const transport = new StdioClientTransport({ ...config, cwd: root, env, stderr: 'pipe' });
  transport.stderr?.on('data', () => {});
  const client = new Client({ name: 'mcp-only-onboarding', version: '1.0.0' }); clients.push(client);
  await client.connect(transport);
  const work = data(await tool(client, 'kith_begin_work', { agentId: 'worker', title: 'Add module', scopeGlobs: ['src/feature.mjs'], isolateWorktree: true }));
  expect(work.worktree.worktreePath).not.toBe(root);
  fs.writeFileSync(path.join(work.worktree.worktreePath, 'src/feature.mjs'), 'export const feature = 42;\n');
  data(await tool(client, 'kith_record_file_edit', { agentId: 'worker', filePath: 'src/feature.mjs' }));
  const command = data(await tool(client, 'kith_run_with_mutex', { agentId: 'worker', mutexName: 'checks', command: [process.execPath, '-p', 'process.cwd()'] }));
  expect(command.exitCode).toBe(0);
  expect(command.stdout.trim()).toBe(work.worktree.worktreePath);
  data(await tool(client, 'kith_heartbeat', { agentId: 'worker' }));
  const completed = data(await tool(client, 'kith_complete_work', { agentId: 'worker', verificationCmd: 'node --check src/feature.mjs' }));
  expect(completed.ok).toBe(true);
  expect(fs.readFileSync(path.join(root, 'src/feature.mjs'), 'utf8')).toContain('feature = 42');
});

it('rejects a check that repairs only the staging tree, preserves work, and completes after source repair', async () => {
  seed();
  const { client } = await connect();
  const before = git('rev-parse', 'HEAD');
  const work = data(await tool(client, 'kith_begin_work', { agentId: 'repair', title: 'Repair module', scopeGlobs: ['src/feature.mjs'], isolateWorktree: true }));
  const file = path.join(work.worktree.worktreePath, 'src/feature.mjs');
  const broken = 'export const feature = ;\n', fixed = 'export const feature = 42;\n';
  fs.writeFileSync(file, broken);
  const script = `require('node:fs').writeFileSync('src/feature.mjs',${JSON.stringify(fixed)});require('node:child_process').execFileSync(process.execPath,['--check','src/feature.mjs'])`;
  const failed = await tool(client, 'kith_complete_work', { agentId: 'repair', verificationCmd: `node -e ${quote(script)}` });
  expect(failed.isError).toBe(true);
  expect(git('rev-parse', 'HEAD')).toBe(before);
  expect(fs.existsSync(path.join(root, 'src/feature.mjs'))).toBe(false);
  expect(fs.readFileSync(file, 'utf8')).toBe(broken);
  const status = data(await tool(client, 'kith_get_status', {}));
  expect(status.tasks.some((t: any) => t.owner_agent_id === 'repair' && t.status === 'active')).toBe(true);
  expect(status.locks.some((l: any) => l.owner_agent_id === 'repair')).toBe(true);
  expect(status.mergeQueue[0].diagnostics_output).toContain('staging checkout');
  fs.writeFileSync(file, fixed);
  data(await tool(client, 'kith_record_file_edit', { agentId: 'repair', filePath: file }));
  data(await tool(client, 'kith_complete_work', { agentId: 'repair', verificationCmd: 'node --check src/feature.mjs' }));
  expect(fs.readFileSync(path.join(root, 'src/feature.mjs'), 'utf8')).toBe(fixed);
  expect(fs.existsSync(work.worktree.worktreePath)).toBe(true);
  expect(data(await tool(client, 'kith_get_status', {})).locks).toEqual([]);
});

it('recovers a killed MCP owner from a stopped WAL backup and resumes its preserved worktree with a new capability', async () => {
  seed();
  const one = await connect();
  const work = data(await tool(one.client, 'kith_begin_work', { agentId: 'recover', title: 'Recover interrupted work', scopeGlobs: ['src/feature.mjs'], isolateWorktree: true }));
  const bytes = 'export const recovered = 42;\n';
  fs.writeFileSync(path.join(work.worktree.worktreePath, 'src/feature.mjs'), bytes);
  data(await tool(one.client, 'kith_record_file_edit', { agentId: 'recover', filePath: 'src/feature.mjs' }));
  const disconnected = new Promise<void>(resolve => { one.client.onclose = resolve; });
  process.kill(one.transport.pid!, 'SIGKILL');
  await disconnected;
  const coord = path.join(root, '.coord');
  const saved = path.join(coord, 'stopped-backup'); fs.mkdirSync(saved);
  expect(fs.statSync(path.join(coord, 'state.db-wal')).size).toBeGreaterThan(0);
  for (const suffix of ['', '-wal', '-shm']) {
    const name = `state.db${suffix}`;
    if (fs.existsSync(path.join(coord, name))) fs.copyFileSync(path.join(coord, name), path.join(saved, name));
  }
  // Opening/checkpointing the original after the crash must not be required to use the backup.
  const checkpoint = new KithEngine(root); checkpoint.close();
  for (const suffix of ['', '-wal', '-shm']) {
    const name = `state.db${suffix}`;
    fs.rmSync(path.join(coord, name), { force: true });
    if (fs.existsSync(path.join(saved, name))) fs.copyFileSync(path.join(saved, name), path.join(coord, name));
  }
  const two = await connect();
  expect((await tool(two.client, 'kith_heartbeat', { agentId: 'recover', sessionToken: work.sessionToken })).isError).toBe(true);
  const claimed = data(await tool(two.client, 'kith_claim_next_task', { agentId: 'recover' }));
  expect(claimed.claimed).toBe(true);
  expect(claimed.task.id).toBe(work.task.id);
  expect(claimed.sessionToken).not.toBe(work.sessionToken);
  const status = data(await tool(two.client, 'kith_get_status', {}));
  expect(status.agents.find((a: any) => a.id === 'recover').worktree_path).toBe(work.worktree.worktreePath);
  data(await tool(two.client, 'kith_complete_work', { agentId: 'recover', verificationCmd: 'node --check src/feature.mjs' }));
  expect(fs.readFileSync(path.join(root, 'src/feature.mjs'), 'utf8')).toBe(bytes);
  expect(fs.existsSync(work.worktree.worktreePath)).toBe(true);
  expect(data(await tool(two.client, 'kith_get_status', {})).locks).toEqual([]);
});
