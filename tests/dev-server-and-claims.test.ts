import { spawn, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { beforeEach, afterEach, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { KithEngine } from '../src/index.js';

let root: string;
let a: KithEngine;
let b: KithEngine;
const cleanup: Array<() => Promise<unknown> | unknown> = [];
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const cli = path.resolve('dist/cli/index.js');
const env = Object.fromEntries(Object.entries(process.env).filter(([k, v]) => v !== undefined && !k.startsWith('KITH_')));
async function until(check: () => boolean, timeout = 10000) {
  const deadline = Date.now() + timeout;
  while (!check()) { if (Date.now() > deadline) throw new Error('Timed out waiting for fixture'); await delay(25); }
}
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "kith dev ' "));
  a = new KithEngine(root); b = new KithEngine(root);
  a.fencing.registerAgent({ id: 'a' }); b.fencing.registerAgent({ id: 'b' });
});
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
  a.close(); b.close(); fs.rmSync(root, { recursive: true, force: true });
});
function serverArgs(id: string) {
  const script = path.join(root, 'server.cjs');
  fs.writeFileSync(script, `const fs=require('node:fs'),http=require('node:http');
const server=http.createServer((q,r)=>r.end(process.argv[2]));
server.on('error',e=>{console.error(e.code);process.exit(9)});
server.listen(Number(process.env.PORT),'127.0.0.1',()=>fs.writeFileSync(process.argv[3],JSON.stringify({port:server.address().port,env:process.env.PORT,kith:process.env.KITH_PORT,arg:process.argv[2],literal:process.argv[4]})));`);
  return [process.execPath, script, '{port}', path.join(root, `${id}.json`), 'literal ; $(not-shell)'];
}
function read(id: string) { return JSON.parse(fs.readFileSync(path.join(root, `${id}.json`), 'utf8')); }
function start(engine: KithEngine, id: string, basePort: number) {
  const controller = new AbortController();
  const execution = engine.broker.executeWithPort({ agentId: id, serviceName: 'web', basePort,
    command: serverArgs(id), signal: controller.signal, leaseDurationMs: 1200, killGraceMs: 50 });
  void execution.catch(() => {});
  cleanup.push(async () => { controller.abort(); await execution.catch(() => {}); });
  return { controller, execution };
}

it.skipIf(process.platform === 'win32')('runs two HTTP servers on distinct allocated ports, passes argv/env, and renews reservations', async () => {
  const external = net.createServer(); external.listen(0, '127.0.0.1'); await once(external, 'listening');
  cleanup.push(() => new Promise<void>(resolve => external.close(() => resolve())));
  const base = (external.address() as net.AddressInfo).port;
  start(a, 'a', base); start(b, 'b', base);
  await until(() => fs.existsSync(path.join(root, 'a.json')) && fs.existsSync(path.join(root, 'b.json')));
  const first = read('a'), second = read('b');
  expect(first.port).not.toBe(base); expect(second.port).not.toBe(first.port);
  for (const result of [first, second]) {
    expect(result.env).toBe(String(result.port)); expect(result.kith).toBe(result.env);
    expect(result.arg).toBe(result.env); expect(result.literal).toBe('literal ; $(not-shell)');
    expect(await (await fetch(`http://127.0.0.1:${result.port}`)).text()).toBe(result.env);
  }
  const expiry = a.broker.getResource('port', 'a:web')!.expires_at;
  await until(() => a.broker.getResource('port', 'a:web')!.expires_at > expiry);
  expect(a.broker.getResource('port', 'a:web')!.value).toBe(String(first.port));
});

it.skipIf(process.platform === 'win32')('cancellation stops the server before releasing its port', async () => {
  const { controller, execution } = start(a, 'a', 24000);
  await until(() => fs.existsSync(path.join(root, 'a.json')));
  const port = read('a').port;
  controller.abort(); await expect(execution).rejects.toMatchObject({ name: 'AbortError' });
  expect(a.broker.getResource('port', 'a:web')).toBeNull();
  expect(await a.broker.acquirePort({ agentId: 'a', serviceName: 'retry', basePort: port })).toMatchObject({ port });
});

it.skipIf(process.platform === 'win32')('keeps child exit status and cleans failed starts without deleting other reservations', async () => {
  const peer = await b.broker.acquirePort({ agentId: 'b', serviceName: 'peer', basePort: 24000 });
  const result = await a.broker.executeWithPort({ agentId: 'a', serviceName: 'web', basePort: 24000,
    command: [process.execPath, '-e', 'process.stdout.write(process.env.PORT);process.exit(7)'] });
  expect(result.exitCode).toBe(7); expect(result.stdout).toBe(String(result.port));
  expect(a.broker.getResource('port', 'a:web')).toBeNull();
  await expect(a.broker.executeWithPort({ agentId: 'a', serviceName: 'bad', command: [path.join(root, 'missing')] })).rejects.toThrow();
  expect(a.broker.getResource('port', 'a:bad')).toBeNull();
  expect(b.broker.getResource('port', 'b:peer')!.fencing_token).toBe(peer.fencingToken);
});

it.skipIf(process.platform === 'win32')('stops on a replaced port lease and does not release the replacement token', async () => {
  const { execution } = start(a, 'a', 24000);
  await until(() => fs.existsSync(path.join(root, 'a.json')));
  const resource = a.broker.getResource('port', 'a:web')!;
  a.coordDb.db.prepare('UPDATE resources SET fencing_token=? WHERE id=?').run(resource.fencing_token + 1, resource.id);
  await expect(execution).rejects.toThrow('port lease lost');
  expect(a.broker.getResource('port', 'a:web')!.fencing_token).toBe(resource.fencing_token + 1);
});

it('waits for a whole claim and creates only one task after release', async () => {
  a.beginWork({ agentId: 'a', title: 'Config owner', scopeGlobs: ['package.json'] });
  const waiting = b.beginWorkWhenAvailable({ agentId: 'b', title: 'Config follower', scopeGlobs: ['package.json', 'tsconfig.json'], waitTimeoutMs: 3000 });
  await delay(180);
  expect(b.locks.listLocks().filter(lock => lock.owner_agent_id === 'b')).toHaveLength(0);
  expect(b.intents.listTasks().filter(task => task.owner_agent_id === 'b')).toHaveLength(0);
  a.completeWork({ agentId: 'a' });
  const result = await waiting;
  expect(result.ok).toBe(true); expect(result.waitTimedOut).toBe(false); expect(result.waitedMs).toBeGreaterThan(0);
  expect(result.locks).toHaveLength(2);
  expect(b.intents.listTasks().filter(task => task.owner_agent_id === 'b')).toHaveLength(1);
});

it('timeouts, cancellation and invalid options leave no partial file claim', async () => {
  a.locks.acquireLocks({ agentId: 'a', patterns: ['package.json'] });
  const options = { agentId: 'b', patterns: ['package.json', 'free.json'] };
  expect(b.locks.acquireLocks(options).ok).toBe(false);
  const timed = await b.acquireLocksWhenAvailable({ ...options, waitTimeoutMs: 120 });
  expect(timed.ok).toBe(false); expect(timed.waitTimedOut).toBe(true);
  const controller = new AbortController();
  const waiting = b.acquireLocksWhenAvailable({ ...options, waitTimeoutMs: 5000, signal: controller.signal });
  controller.abort(); await expect(waiting).rejects.toMatchObject({ name: 'AbortError' });
  await expect(b.acquireLocksWhenAvailable({ ...options, waitTimeoutMs: -1 })).rejects.toThrow('waitTimeoutMs');
  expect(b.locks.listLocks().filter(lock => lock.owner_agent_id === 'b')).toHaveLength(0);
  expect(b.locks.listLocks().filter(lock => lock.owner_agent_id === 'a')).toHaveLength(1);
});

it('does not revive or claim using an expired waiting session', async () => {
  a.locks.acquireLocks({ agentId: 'a', patterns: ['package.json'] });
  const waiting = b.acquireLocksWhenAvailable({ agentId: 'b', patterns: ['package.json'], waitTimeoutMs: 5000 });
  void waiting.catch(() => {});
  b.coordDb.db.prepare('UPDATE agents SET lease_expires_at=? WHERE id=?').run(Date.now() - 1, 'b');
  await expect(waiting).rejects.toThrow();
  a.locks.releaseLocks({ agentId: 'a' });
  expect(b.locks.listLocks().filter(lock => lock.owner_agent_id === 'b')).toHaveLength(0);
});

it('waits without creating a worktree until it owns the requested scope', async () => {
  for (const args of [['init'], ['config', 'user.name', 'Kith fixture'], ['config', 'user.email', 'fixture@kith.local']]) execFileSync('git', args, { cwd: root, stdio: 'ignore' });
  fs.writeFileSync(path.join(root, '.gitignore'), '.coord/\n');
  execFileSync('git', ['add', '.gitignore'], { cwd: root }); execFileSync('git', ['commit', '-m', 'Fixture'], { cwd: root, stdio: 'ignore' });
  a.locks.acquireLocks({ agentId: 'a', patterns: ['shared.json'] });
  const waiting = b.beginWorkWhenAvailable({ agentId: 'b', title: 'Isolated config', scopeGlobs: ['shared.json'], isolateWorktree: true, waitTimeoutMs: 3000 });
  await delay(180); expect(b.fencing.getAgent('b')!.worktree_path).toBeNull();
  a.locks.releaseLocks({ agentId: 'a' });
  const result = await waiting;
  expect(result.ok).toBe(true); expect(result.worktree?.worktreePath).toBeTruthy();
});

it.skipIf(process.platform === 'win32')('CLI dev launches with literal port arguments and returns command failures', async () => {
  const child = spawn(process.execPath, [cli, 'dev', '--agent', 'cli-dev', '--base', '24000', '--', process.execPath, '-e',
    'process.stdout.write(JSON.stringify({env:process.env.PORT,arg:process.argv[1]}));process.exit(7)', '{port}'], { cwd: root, env });
  let output = ''; child.stdout!.on('data', chunk => { output += chunk; });
  const [code] = await once(child, 'close'); expect(code).toBe(7);
  const result = JSON.parse(output); expect(result.env).toMatch(/^\d+$/); expect(result.arg).toBe(result.env);
});

it('CLI file wait exits with timeout or cancellation without claiming', async () => {
  a.locks.acquireLocks({ agentId: 'a', patterns: ['package.json'] });
  const run = (name: string, wait: string) => spawn(process.execPath, [cli, 'lock', 'acquire', '--agent', name, '--scope', 'package.json', '--wait', '--wait-ms', wait], { cwd: root, env });
  const timed = run('cli-timeout', '120'); let output = ''; timed.stdout!.on('data', chunk => { output += chunk; });
  expect((await once(timed, 'close'))[0]).toBe(1); expect(JSON.parse(output).waitTimedOut).toBe(true);
  if (process.platform !== 'win32') {
    const cancelled = run('cli-cancelled', '5000');
    await until(() => a.fencing.getAgent('cli-cancelled') !== null);
    cancelled.kill('SIGINT'); expect((await once(cancelled, 'close'))[0]).toBe(130);
    expect(a.fencing.getAgent('cli-cancelled')!.status).not.toBe('active');
  }
  expect(a.locks.listLocks().every(lock => lock.owner_agent_id === 'a')).toBe(true);
});

async function connect() {
  const client = new Client({ name: 'dev-claims-test', version: '1' });
  const transport = new StdioClientTransport({ command: process.execPath, args: [cli, 'mcp', '--repo', root], env, stderr: 'ignore' });
  await client.connect(transport); cleanup.push(() => client.close()); return client;
}
function data(result: any) { return result.structuredContent ?? JSON.parse(result.content[0].text); }
it('MCP waiting claims succeed after release and drain on disconnect', async () => {
  a.locks.acquireLocks({ agentId: 'a', patterns: ['shared.json'] });
  const client = await connect();
  const waiting = client.callTool({ name: 'kith_begin_work', arguments: { agentId: 'mcp-waiter', title: 'Wait for config', scopeGlobs: ['shared.json'], waitTimeoutMs: 3000 } });
  await delay(200); a.locks.releaseLocks({ agentId: 'a' });
  expect(data(await waiting).ok).toBe(true);
  a.locks.acquireLocks({ agentId: 'a', patterns: ['other.json'] });
  const blocked = client.callTool({ name: 'kith_check_and_lock_files', arguments: { agentId: 'mcp-waiter', patterns: ['other.json'], waitTimeoutMs: 5000 } });
  void blocked.catch(() => {}); await delay(150); await client.close(); await blocked.catch(() => {});
  expect(a.locks.listLocks().some(lock => lock.owner_agent_id === 'mcp-waiter' && lock.pattern.includes('other'))).toBe(false);
});

it.skipIf(process.platform === 'win32')('MCP dev execution is cancelled on disconnect and refuses an escaping cwd', async () => {
  const client = await connect();
  await client.callTool({ name: 'kith_start_session', arguments: { agentId: 'mcp-dev' } });
  const bad = await client.callTool({ name: 'kith_run_dev_server', arguments: { agentId: 'mcp-dev', serviceName: 'web', command: ['echo'], cwd: '..' } });
  expect(bad.isError).toBe(true);
  const running = client.callTool({ name: 'kith_run_dev_server', arguments: { agentId: 'mcp-dev', serviceName: 'web', command: serverArgs('mcp'), basePort: 24000 } });
  void running.catch(() => {});
  await until(() => fs.existsSync(path.join(root, 'mcp.json')));
  const port = read('mcp').port;
  await client.close(); await running.catch(() => {});
  await until(() => !a.broker.getResource('port', 'mcp-dev:web'));
  expect(await a.broker.acquirePort({ agentId: 'a', serviceName: 'after-mcp', basePort: port })).toMatchObject({ port });
});
