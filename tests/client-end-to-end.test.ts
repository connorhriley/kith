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
async function connect() {
  const transport = new StdioClientTransport({ command: process.execPath, args: [cli, 'mcp', '--repo', root], env, stderr: 'pipe' });
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
