import { spawn, ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { KithEngine } from '../src/index.js';

let root: string;
let a: KithEngine;
let b: KithEngine;
const children: ChildProcess[] = [];
const cli = path.resolve('dist/cli/index.js');
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(check: () => boolean, ms = 10000) {
  const deadline = Date.now() + ms;
  while (!check()) { if (Date.now() > deadline) throw new Error('Condition timed out'); await delay(20); }
}
function command(id: string, duration: number) {
  return [process.execPath, '-e', `const fs=require('node:fs');const file=${JSON.stringify(path.join(root, 'events'))};fs.appendFileSync(file, '${id}:start\\n');setTimeout(()=>{fs.appendFileSync(file,'${id}:end\\n')},${duration});`];
}
function events() { try { return fs.readFileSync(path.join(root, 'events'), 'utf8').trim().split('\n'); } catch { return []; } }
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'kith-mutex-'));
  a = new KithEngine(root); b = new KithEngine(root);
  a.fencing.registerAgent({ id: 'a' }); b.fencing.registerAgent({ id: 'b' });
});
afterEach(async () => {
  vi.restoreAllMocks();
  for (const child of children.splice(0)) if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  for (const row of a.coordDb.db.prepare('SELECT worker_pid FROM mutex_runs').all() as Array<{ worker_pid: number | null }>) {
    if (row.worker_pid) { try { process.kill(-row.worker_pid, 'SIGKILL'); } catch {} }
  }
  a.close(); b.close(); fs.rmSync(root, { recursive: true, force: true });
});

it('renews across multiple lease periods and prevents a competing command from overlapping', async () => {
  const first = a.broker.executeWithMutex({ agentId: 'a', mutexName: 'install', leaseDurationMs: 1200, command: command('a', 3600) });
  void first.catch(() => {});
  await until(() => events().includes('a:start'));
  const initialExpiry = a.broker.getResource('mutex', 'install')!.expires_at;
  const second = b.broker.executeWithMutex({ agentId: 'b', mutexName: 'install', leaseDurationMs: 1200, command: command('b', 20) });
  await delay(1600);
  expect(events()).toEqual(['a:start']);
  expect(a.broker.getResource('mutex', 'install')!.expires_at).toBeGreaterThan(initialExpiry);
  const results = await Promise.all([first, second]);
  expect(results.map((r) => r.exitCode)).toEqual([0, 0]);
  expect(events()).toEqual(['a:start', 'a:end', 'b:start', 'b:end']);
  expect(a.broker.getResource('mutex', 'install')).toBeNull();
}, 20000);

it('preserves FIFO order across release and prevents a late newcomer from barging in', () => {
  a.fencing.registerAgent({ id: 'c' }); a.fencing.registerAgent({ id: 'late' });
  const first = a.broker.tryAcquireMutex({ agentId: 'a', mutexName: 'fifo' });
  expect(b.broker.tryAcquireMutex({ agentId: 'b', mutexName: 'fifo' }).queuePosition).toBe(1);
  expect(a.broker.tryAcquireMutex({ agentId: 'c', mutexName: 'fifo' }).queuePosition).toBe(2);
  a.broker.releaseMutex({ agentId: 'a', mutexName: 'fifo', fencingToken: first.fencingToken });
  expect(a.broker.tryAcquireMutex({ agentId: 'late', mutexName: 'fifo' }).acquired).toBe(false);
  expect(a.broker.tryAcquireMutex({ agentId: 'c', mutexName: 'fifo' }).acquired).toBe(false);
  const next = b.broker.tryAcquireMutex({ agentId: 'b', mutexName: 'fifo' });
  expect(next.acquired).toBe(true);
  b.broker.releaseMutex({ agentId: 'b', mutexName: 'fifo', fencingToken: next.fencingToken });
  expect(a.broker.tryAcquireMutex({ agentId: 'c', mutexName: 'fifo' }).acquired).toBe(true);
});

it('removes cancelled waiters and releases no other owner’s lease', async () => {
  const held = a.broker.tryAcquireMutex({ agentId: 'a', mutexName: 'queue' });
  const controller = new AbortController();
  const waiting = b.broker.executeWithMutex({ agentId: 'b', mutexName: 'queue', command: command('b', 0), signal: controller.signal });
  const rejected = expect(waiting).rejects.toMatchObject({ name: 'AbortError' });
  await until(() => a.broker.getResource('mutex', 'queue')!.queue.includes('b'));
  controller.abort(); await rejected;
  expect(a.broker.getResource('mutex', 'queue')!.owner_agent_id).toBe('a');
  expect(a.broker.getResource('mutex', 'queue')!.queue).toEqual([]);
  a.broker.releaseMutex({ agentId: 'a', mutexName: 'queue', fencingToken: held.fencingToken });
  expect(b.broker.tryAcquireMutex({ agentId: 'b', mutexName: 'queue' }).acquired).toBe(true);
});

it('keeps a live command guarded after resource expiry, then stops it before handoff', async () => {
  const first = a.broker.executeWithMutex({ agentId: 'a', mutexName: 'expired', leaseDurationMs: 1200, command: command('a', 15000), killGraceMs: 100 });
  const rejected = expect(first).rejects.toThrow('lease lost');
  await until(() => events().includes('a:start'));
  a.coordDb.db.prepare("UPDATE resources SET expires_at=? WHERE name='expired'").run(Date.now() - 1);
  expect(b.broker.tryAcquireMutex({ agentId: 'b', mutexName: 'expired' }).acquired).toBe(false);
  await rejected;
  expect(b.broker.tryAcquireMutex({ agentId: 'b', mutexName: 'expired' }).acquired).toBe(true);
  expect(events()).toEqual(['a:start']);
});

it('cancels an entire command process group, including a child that ignores SIGTERM', async () => {
  const pidFile = path.join(root, 'descendant');
  const script = `const {spawn}=require('node:child_process');spawn(process.execPath,['-e', ${JSON.stringify(`process.on('SIGTERM',()=>{});require('node:fs').writeFileSync(${JSON.stringify(pidFile)},String(process.pid));setInterval(()=>{},1000);`)}],{stdio:'ignore'});setInterval(()=>{},1000);`;
  const controller = new AbortController();
  const run = a.broker.executeWithMutex({ agentId: 'a', mutexName: 'tree', command: [process.execPath, '-e', script], signal: controller.signal, killGraceMs: 100 });
  const rejected = expect(run).rejects.toMatchObject({ name: 'AbortError' });
  await until(() => fs.existsSync(pidFile));
  const descendant = Number(fs.readFileSync(pidFile, 'utf8'));
  controller.abort(); await rejected;
  expect(() => process.kill(descendant, 0)).toThrow();
  expect(b.broker.tryAcquireMutex({ agentId: 'b', mutexName: 'tree' }).acquired).toBe(true);
});

it('cleans up failed spawns and timed-out commands and rejects stale release tokens', async () => {
  await expect(a.broker.executeWithMutex({ agentId: 'a', mutexName: 'failure', command: ['kith-nonexistent-executable-123'] })).rejects.toThrow('ENOENT');
  await expect(a.broker.executeWithMutex({ agentId: 'a', mutexName: 'failure', command: command('a', 10000), commandTimeoutMs: 1000, killGraceMs: 100 })).rejects.toThrow('timed out');
  const first = a.broker.tryAcquireMutex({ agentId: 'a', mutexName: 'failure' });
  a.broker.releaseMutex({ agentId: 'a', mutexName: 'failure', fencingToken: first.fencingToken });
  const next = a.broker.tryAcquireMutex({ agentId: 'a', mutexName: 'failure' });
  expect(() => a.broker.releaseMutex({ agentId: 'a', mutexName: 'failure', fencingToken: first.fencingToken })).toThrow('mismatch');
  expect(a.broker.getResource('mutex', 'failure')?.fencing_token).toBe(next.fencingToken);
});

it('serializes concurrent commands from the same session rather than treating them as reentrant', async () => {
  const first = a.broker.executeWithMutex({ agentId: 'a', mutexName: 'same', command: command('first', 250) });
  await until(() => events().includes('first:start'));
  const second = a.broker.executeWithMutex({ agentId: 'a', mutexName: 'same', command: command('second', 10) });
  await Promise.all([first, second]);
  expect(events()).toEqual(['first:start', 'first:end', 'second:start', 'second:end']);
});

it('recovers after the CLI supervisor is killed without leaving its command running', async () => {
  const pidFile = path.join(root, 'command-pid');
  const script = `require('node:fs').writeFileSync(${JSON.stringify(pidFile)},String(process.pid));setInterval(()=>{},1000);`;
  const env = { ...process.env }; delete env.KITH_AGENT_ID; delete env.KITH_SESSION_TOKEN;
  const supervisor = spawn(process.execPath, [cli, 'mutex', '--repo', root, '--agent', 'crashing', '--lease-ms', '1200', '--', process.execPath, '-e', script], { env, stdio: 'ignore' });
  children.push(supervisor);
  await until(() => fs.existsSync(pidFile));
  const pid = Number(fs.readFileSync(pidFile, 'utf8'));
  supervisor.kill('SIGKILL'); await once(supervisor, 'exit');
  await until(() => { try { process.kill(pid, 0); return false; } catch { return true; } });
  expect(b.broker.tryAcquireMutex({ agentId: 'b', mutexName: 'default-mutex' }).acquired).toBe(true);
});

it('keeps a suspended supervisor’s live command guarded even after its session is reaped', async () => {
  const pidFile = path.join(root, 'suspended-command');
  const script = `require('node:fs').writeFileSync(${JSON.stringify(pidFile)},String(process.pid));setInterval(()=>{},1000);`;
  const env = { ...process.env }; delete env.KITH_AGENT_ID; delete env.KITH_SESSION_TOKEN;
  const supervisor = spawn(process.execPath, [cli, 'mutex', '--repo', root, '--agent', 'paused', '--lease-ms', '1200', '--', process.execPath, '-e', script], { env, stdio: 'ignore' });
  children.push(supervisor);
  await until(() => fs.existsSync(pidFile));
  supervisor.kill('SIGSTOP');
  try {
    a.coordDb.db.prepare("UPDATE agents SET lease_expires_at=? WHERE id='paused'").run(Date.now() - 1);
    a.coordDb.db.prepare("UPDATE resources SET expires_at=? WHERE owner_agent_id='paused'").run(Date.now() - 1);
    expect(b.broker.tryAcquireMutex({ agentId: 'b', mutexName: 'default-mutex' }).acquired).toBe(false);
    expect(a.fencing.getAgent('paused')?.status).toBe('dead');
    expect(a.coordDb.db.prepare('SELECT * FROM mutex_runs').all()).toHaveLength(1);
  } finally { supervisor.kill('SIGCONT'); }
  await once(supervisor, 'exit');
  expect(b.broker.tryAcquireMutex({ agentId: 'b', mutexName: 'default-mutex' }).acquired).toBe(true);
});

it('handles CLI SIGTERM only after stopping its command and releasing its guard', async () => {
  const pidFile = path.join(root, 'signal-command');
  const script = `require('node:fs').writeFileSync(${JSON.stringify(pidFile)},String(process.pid));console.log('ready');setInterval(()=>{},1000);`;
  const env = { ...process.env }; delete env.KITH_AGENT_ID; delete env.KITH_SESSION_TOKEN;
  const supervisor = spawn(process.execPath, [cli, 'mutex', '--repo', root, '--agent', 'signalled', '--', process.execPath, '-e', script], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  children.push(supervisor);
  let stdout = ''; supervisor.stdout!.on('data', (chunk) => { stdout += chunk; });
  await until(() => stdout.includes('ready'));
  const pid = Number(fs.readFileSync(pidFile, 'utf8'));
  supervisor.kill('SIGTERM'); const [code, signal] = await once(supervisor, 'exit');
  expect(code).toBe(143); expect(signal).toBeNull();
  expect(() => process.kill(pid, 0)).toThrow();
  expect(a.coordDb.db.prepare('SELECT * FROM mutex_runs').all()).toEqual([]);
  expect(b.broker.tryAcquireMutex({ agentId: 'b', mutexName: 'default-mutex' }).acquired).toBe(true);
});

it('refuses to close the database while a supervised command is pending', async () => {
  const controller = new AbortController();
  const running = a.broker.executeWithMutex({ agentId: 'a', mutexName: 'close', command: command('a', 10000), signal: controller.signal });
  const rejected = expect(running).rejects.toMatchObject({ name: 'AbortError' });
  expect(() => a.close()).toThrow('Await or cancel');
  controller.abort(); await rejected;
  expect(a.broker.hasActiveCommands()).toBe(false);
});


it('preserves child signal exit statuses and enforces its output bound', async () => {
  const result = await a.broker.executeWithMutex({ agentId: 'a', mutexName: 'status', command: [process.execPath, '-e', "process.kill(process.pid, 'SIGKILL')"] });
  expect(result.exitCode).toBe(137);
  await expect(a.broker.executeWithMutex({ agentId: 'a', mutexName: 'status', command: [process.execPath, '-e', "process.stdout.write('too much output')"], maxOutputBytes: 3 })).rejects.toThrow('output limit');
  expect(b.broker.tryAcquireMutex({ agentId: 'b', mutexName: 'status' }).acquired).toBe(true);
});


it('contains signalling errors and never grants a second runner while shutdown is incomplete', async () => {
  const controller = new AbortController();
  const running = a.broker.executeWithMutex({ agentId: 'a', mutexName: 'signal-error', command: command('a', 20000), signal: controller.signal, killGraceMs: 50 });
  const rejection = expect(running).rejects.toThrow('guard retained');
  await until(() => events().includes('a:start'));
  const originalKill = process.kill.bind(process);
  vi.spyOn(process, 'kill').mockImplementation(((pid: number, signal?: NodeJS.Signals | number) => {
    if (pid < 0 && signal !== 0) throw Object.assign(new Error('kill EPERM'), { code: 'EPERM' });
    return originalKill(pid, signal);
  }) as typeof process.kill);
  controller.abort();
  await delay(150);
  expect(b.broker.tryAcquireMutex({ agentId: 'b', mutexName: 'signal-error' }).acquired).toBe(false);
  await rejection;
  vi.restoreAllMocks();
});
