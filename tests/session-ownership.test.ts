import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { KithEngine, StaleFencingTokenError } from '../src/index.js';

let root: string;
let owner: KithEngine;
let peer: KithEngine;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'kith-session-'));
  owner = new KithEngine(root); peer = new KithEngine(root);
});
afterEach(() => { owner.close(); peer.close(); fs.rmSync(root, { recursive: true, force: true }); });

it('requires a capability for an existing live identity and never rebinds its process anchor', () => {
  const session = owner.fencing.registerAgent({ id: 'worker' });
  const lock = owner.locks.acquireLocks({ agentId: 'worker', patterns: ['file.ts'] });
  expect(() => peer.fencing.registerAgent({ id: 'worker' })).toThrow('capability');
  expect(() => peer.fencing.resumeSession('worker', 'wrong')).toThrow('capability');
  expect(() => peer.fencing.heartbeat('worker')).toThrow('capability');
  expect(() => peer.locks.releaseLocks({ agentId: 'worker' })).toThrow('capability');
  expect(() => peer.fencing.completeAgentSession('worker')).toThrow('capability');
  expect(owner.locks.listLocks()[0].fencing_token).toBe(lock.fencingToken);
  peer.fencing.resumeSession('worker', session.sessionToken);
  const resumed = peer.fencing.registerAgent({ id: 'worker', pid: 999999 });
  expect(resumed.agent.pid).toBe(session.agent.pid);
  expect(resumed.sessionEpoch).toBe(session.sessionEpoch);
});

it('invalidates old capabilities on ID reuse and protects the new owner from stale cleanup', () => {
  const original = owner.fencing.registerAgent({ id: 'worker' });
  owner.fencing.completeAgentSession('worker');
  const replacement = peer.fencing.registerAgent({ id: 'worker' });
  peer.locks.acquireLocks({ agentId: 'worker', patterns: ['new.ts'] });
  expect(replacement.sessionToken).not.toBe(original.sessionToken);
  expect(replacement.sessionEpoch).toBeGreaterThan(original.sessionEpoch);
  expect(() => owner.fencing.resumeSession('worker', original.sessionToken)).toThrow('capability');
  expect(() => owner.intents.completeTask({ agentId: 'worker' })).toThrow('capability');
  expect(() => owner.fencing.completeAgentSession('worker')).toThrow('capability');
  expect(peer.locks.listLocks().map((l) => l.pattern)).toEqual(['new.ts']);
});

it('cannot revive expired sessions or expired locks with a heartbeat', () => {
  const session = owner.fencing.registerAgent({ id: 'worker' });
  owner.locks.acquireLocks({ agentId: 'worker', patterns: ['file.ts'] });
  owner.coordDb.db.prepare('UPDATE locks SET expires_at=?').run(Date.now() - 1);
  owner.fencing.heartbeat('worker');
  expect(owner.locks.listLocks()).toEqual([]);
  owner.coordDb.db.prepare('UPDATE agents SET lease_expires_at=? WHERE id=?').run(Date.now() - 1, 'worker');
  expect(() => owner.fencing.heartbeat('worker')).toThrow('capability');
  expect(() => peer.fencing.resumeSession('worker', session.sessionToken)).toThrow('capability');
});

it('rejects forged future fencing tokens and completion of unclaimed tasks', () => {
  owner.fencing.registerAgent({ id: 'worker' });
  const lock = owner.locks.acquireLocks({ agentId: 'worker', patterns: ['file.ts'] });
  expect(() => owner.locks.checkFileWriteAccess({ agentId: 'worker', filePath: 'file.ts', fencingToken: lock.fencingToken + 1 })).toThrow(StaleFencingTokenError);
  owner.intents.addTask({ id: 'queued', title: 'Queued' });
  expect(() => owner.intents.completeTask({ agentId: 'worker', taskId: 'queued' })).toThrow('owned');
  expect(owner.intents.getTask('queued')?.status).toBe('queued');
});

it('never exposes raw session capabilities through public status or the event log', () => {
  const session = owner.fencing.registerAgent({ id: 'worker' });
  const publicData = JSON.stringify({ agents: owner.fencing.listAgents(), events: owner.coordDb.getEventsSince(0), resources: owner.broker.listResources() });
  expect(publicData).not.toContain(session.sessionToken);
  expect(publicData).not.toContain('token_hash');
});

it('migrates legacy ownership transactionally, requeues work, and preserves workspace files', () => {
  owner.fencing.registerAgent({ id: 'legacy' });
  owner.intents.addTask({ id: 'task', title: 'Pending work', scopeGlobs: ['file.ts'] });
  owner.intents.claimNextTask('legacy');
  fs.writeFileSync(path.join(root, 'precious.txt'), 'preserve');
  owner.coordDb.db.exec("DELETE FROM agent_sessions; UPDATE meta SET value='1' WHERE key='schema_version'");
  peer.close(); peer = new KithEngine(root);
  expect(peer.fencing.getAgent('legacy')?.status).toBe('dead');
  expect(peer.intents.getTask('task')?.status).toBe('queued');
  expect(peer.locks.listLocks()).toEqual([]);
  expect(fs.readFileSync(path.join(root, 'precious.txt'), 'utf8')).toBe('preserve');
});


it('never carries an earlier session generation’s dirty shadow index into a reused ID', () => {
  const git = (...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git('init'); git('config', 'user.email', 'test@example.test'); git('config', 'user.name', 'Test');
  fs.writeFileSync(path.join(root, '.gitignore'), '.coord/\n');
  fs.writeFileSync(path.join(root, 'a.mjs'), 'export const a = 1;\n');
  fs.writeFileSync(path.join(root, 'b.mjs'), 'export const b = 1;\n');
  git('add', '.'); git('commit', '-m', 'seed');
  owner.fencing.registerAgent({ id: 'worker' });
  owner.shadowGit.updateAgentShadowTree({ agentId: 'worker', modifiedFiles: [{ filePath: 'a.mjs', content: 'export const a = 99;' }] });
  owner.fencing.completeAgentSession('worker');
  peer.fencing.registerAgent({ id: 'worker' });
  const commit = peer.shadowGit.updateAgentShadowTree({ agentId: 'worker', modifiedFiles: [{ filePath: 'b.mjs', content: 'export const b = 2;' }] });
  expect(git('show', `${commit}:a.mjs`)).toBe('export const a = 1;');
});
