import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { KithEngine } from '../src/core/engine.js';
import { readDashboardSnapshot } from '../src/tui/snapshot.js';
import { renderDashboardFrame } from '../src/tui/dashboard.js';

let root: string;
let engine: KithEngine | undefined;
beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'kith-observation-')); });
afterEach(() => { engine?.close(); engine = undefined; fs.rmSync(root, { recursive: true, force: true }); });

it('observes queues without leases, retained worktrees, expired guards and latest events without mutating state', () => {
  engine = new KithEngine(root);
  engine.fencing.registerAgent({ id: 'owner' });
  engine.fencing.registerAgent({ id: 'waiter' });
  engine.locks.acquireLocks({ agentId: 'owner', patterns: ['src/**'] });
  const lease = engine.broker.tryAcquireMutex({ agentId: 'owner', mutexName: 'install' });
  expect(lease.acquired).toBe(true);
  engine.broker.tryAcquireMutex({ agentId: 'waiter', mutexName: 'install' });
  engine.broker.releaseMutex({ agentId: 'owner', mutexName: 'install', fencingToken: lease.fencingToken });
  const db = engine.coordDb.db;
  db.prepare("UPDATE agents SET status='completed',worktree_path=?,branch='kith/owner',lease_expires_at=1 WHERE id='owner'").run(path.join(root, 'retained'));
  db.exec("UPDATE agents SET lease_expires_at=1 WHERE id='waiter'; UPDATE locks SET expires_at=1; UPDATE mutex_waiters SET expires_at=1;");
  db.exec("INSERT INTO mutex_runs VALUES('checks','run','owner',1,1001,999999,'old-start',999998,'old-start');");
  db.exec("INSERT INTO resources VALUES('checks','mutex','checks','locked','owner',1001,'[]',1,2);");
  db.prepare('INSERT INTO quarantine VALUES(?,?,?,?,?,?,?)').run('copy', 'owner', 'secret-command-argv', 'src/a.ts', '/copy/a.ts', 'reason', 1);
  for (let i = 0; i < 20; i++) db.prepare('INSERT INTO events(timestamp,agent_id,event_type,payload_json) VALUES(?,?,?,?)').run(1000+i, 'owner', `event-${i}`, '{"sensitive":"payload"}');
  const tables = ['meta', 'agents', 'agent_sessions', 'locks', 'mutex_waiters', 'mutex_runs', 'resources', 'events', 'quarantine'];
  const dump = () => JSON.stringify(tables.map(t => db.prepare(`SELECT * FROM ${t}`).all()));
  const before = dump();
  const snapshot = readDashboardSnapshot(root);
  const frame = renderDashboardFrame(snapshot);
  expect(snapshot.state).toBe('ready');
  expect(snapshot.resources.some(r => r.name === 'install')).toBe(false);
  expect(frame).toContain('install · no lease recorded');
  expect(frame).toMatch(/ticket #\d+ · waiter · expired/);
  expect(frame).toContain('checks · owner (expired)');
  expect(frame).toContain('shutdown not confirmed');
  expect(frame).toContain('owner · completed · kith/owner');
  expect(frame).toContain(path.join(root, 'retained'));
  expect(snapshot.events.map(e => e.event_type)).toEqual([19,18,17,16,15,14].map(i => `event-${i}`));
  expect(frame).toContain('workspace restoration is not recorded');
  expect(frame).not.toContain('reverted');
  expect(JSON.stringify(snapshot)).not.toMatch(/secret-command-argv|token_hash|sensitive/);
  expect(dump()).toBe(before);
  const result = spawnSync(process.execPath, [path.resolve('dist/cli/index.js'), 'top', '--once', '--repo', root], { encoding: 'utf8' });
  expect(result.status, result.stderr).toBe(0);
  expect(result.stdout).toContain('install · no lease recorded');
  expect(dump()).toBe(before);
});

it('does not initialize missing state, including through the distributed CLI', () => {
  expect(readDashboardSnapshot(root).state).toBe('missing');
  const result = spawnSync(process.execPath, [path.resolve('dist/cli/index.js'), 'top', '--once', '--repo', root], { encoding: 'utf8' });
  expect(result.status, result.stderr).toBe(0);
  expect(result.stdout).toContain('No coordination database');
  expect(fs.readdirSync(root)).toEqual([]);
});

it('refuses unsupported schemas without migrating or leaking partial observations', () => {
  engine = new KithEngine(root);
  engine.coordDb.db.exec("UPDATE meta SET value='999' WHERE key='schema_version'");
  const snapshot = readDashboardSnapshot(root);
  expect(snapshot.state).toBe('unavailable');
  expect(snapshot.error).toContain('Unsupported coordination schema');
  expect(snapshot.agents).toEqual([]);
  expect(engine.coordDb.db.prepare("SELECT value FROM meta WHERE key='schema_version'").get()).toEqual({ value: '999' });
});

it('escapes recorded terminal controls and refuses redirected coordination state', () => {
  engine = new KithEngine(root);
  engine.fencing.registerAgent({ id: 'untrusted' });
  engine.coordDb.db.prepare("UPDATE agents SET client=? WHERE id='untrusted'").run('untrusted\x1b[2J');
  const frame = renderDashboardFrame(readDashboardSnapshot(root));
  expect(frame).not.toContain('\x1b');
  expect(frame).toContain('untrusted\\x1b[2J');
  engine.close(); engine = undefined;
  fs.renameSync(path.join(root, '.coord'), path.join(root, 'saved-state'));
  fs.symlinkSync(path.join(root, 'saved-state'), path.join(root, '.coord'));
  expect(readDashboardSnapshot(root).state).toBe('unavailable');
});
