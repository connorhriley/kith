import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { KithEngine } from '../src/index.js';
import { CoordDatabase } from '../src/core/db.js';
import { HANDOFF_LIMITS, insertHandoff } from '../src/core/handoff-store.js';

// A session boundary used to erase what an agent learned: claims were released and the task requeued as if
// untouched. Handoffs keep it, hand it to whoever works the same scope next, and label it untrusted.

const cli = path.resolve('dist/cli/index.js');
let root: string;
let engine: KithEngine;
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kith-handoffs-')));
  git(root, 'init', '-b', 'main'); git(root, 'config', 'user.email', 't@example.test'); git(root, 'config', 'user.name', 'T');
  fs.writeFileSync(path.join(root, '.gitignore'), '.coord/\nnode_modules/\n');
  fs.mkdirSync(path.join(root, 'src/auth'), { recursive: true });
  fs.writeFileSync(path.join(root, 'src/auth/login.ts'), 'export const login = 1;\n');
  git(root, 'add', '.'); git(root, 'commit', '-m', 'seed');
  engine = new KithEngine(root);
});
afterEach(() => { try { engine.close(); } catch { /* Already closed. */ } fs.rmSync(root, { recursive: true, force: true }); });

const join = (id: string) => engine.fencing.registerAgent({ id });
const begin = (id: string, scope: string[], title = `work by ${id}`) => {
  join(id);
  const result = engine.beginWork({ agentId: id, title, scopeGlobs: scope });
  expect(result.ok, JSON.stringify(result.lockConflicts)).toBe(true);
  return result;
};

describe('writing a handoff', () => {
  it('records the note against the agent\'s task and returns it to readers', () => {
    join('beta'); // A new session only sees events from after it joined.
    const { task } = begin('alpha', ['src/auth/**']);
    const { handoff, released } = engine.handoffs.write({
      agentId: 'alpha', kind: 'blocked', summary: 'Token refresh fails behind the proxy.',
      remaining: ['Retry with the proxy bypass'], failed: ['Tried raising the timeout; no effect'], learned: ['The proxy strips the Authorization header'],
      transcriptRef: 'claude-code:abc123',
    });
    expect(released).toBe(false);
    expect(handoff).toMatchObject({ task_id: task!.id, task_title: 'work by alpha', kind: 'blocked', source: 'agent', agent_id: 'alpha', transcript_ref: 'claude-code:abc123' });
    expect(handoff.remaining).toEqual(['Retry with the proxy bypass']);
    expect(handoff.scope).toEqual(['src/auth/**']);
    expect(engine.handoffs.list({ taskId: task!.id })).toHaveLength(1);
    // The sibling delta shows other agents that a note was left.
    expect(engine.consumeAgentDelta('beta').formattedFooter).toContain('handoff_written');
  });

  it('cleans and bounds what it stores, and refuses nonsense', () => {
    begin('alpha', ['src/auth/**']);
    const { handoff } = engine.handoffs.write({
      agentId: 'alpha', kind: 'progress', summary: `ok\u0000\u0007 text ${'x'.repeat(HANDOFF_LIMITS.summary * 2)}`,
      remaining: Array.from({ length: 50 }, (_, i) => `step ${i}`), files: ['a.ts', 'a.ts', 'b.ts'],
    });
    expect(handoff.summary.startsWith('ok text')).toBe(true);
    expect(handoff.summary.length).toBeLessThanOrEqual(HANDOFF_LIMITS.summary);
    expect(handoff.remaining).toHaveLength(HANDOFF_LIMITS.items);
    expect(handoff.files.filter(file => file === 'a.ts')).toHaveLength(1);
    expect(() => engine.handoffs.write({ agentId: 'alpha', kind: 'progress', summary: '   ' })).toThrow('summary');
    expect(() => engine.handoffs.write({ agentId: 'alpha', kind: 'abandoned' as never, summary: 'x' })).toThrow('kind');
    expect(() => engine.handoffs.write({ agentId: 'alpha', kind: 'progress', summary: 'x', taskId: 'task_nope' })).toThrow('not an active task');
    expect(() => engine.handoffs.write({ agentId: 'alpha', kind: 'done', summary: 'x', releaseTask: true })).toThrow('cannot release');
  });

  it('requires a live session and a task id when the agent owns several tasks', () => {
    begin('alpha', ['src/auth/**']);
    const second = engine.intents.declareIntent({ agentId: 'alpha', title: 'second', scopeGlobs: ['docs/**'] });
    expect(second.ok).toBe(true);
    expect(() => engine.handoffs.write({ agentId: 'alpha', kind: 'progress', summary: 'x' })).toThrow('pass taskId');
    expect(engine.handoffs.write({ agentId: 'alpha', kind: 'progress', summary: 'x', taskId: second.task!.id }).handoff.task_id).toBe(second.task!.id);
    const stranger = new KithEngine(root);
    try { expect(() => stranger.handoffs.write({ agentId: 'alpha', kind: 'progress', summary: 'x' })).toThrow('session capability'); }
    finally { stranger.close(); }
  });

  it('records files changed in the agent\'s worktree from Git', () => {
    join('alpha');
    expect(engine.beginWork({ agentId: 'alpha', title: 'edit login', scopeGlobs: ['src/auth/**'], isolateWorktree: true }).ok).toBe(true);
    const worktree = engine.fencing.getAgent('alpha')!.worktree_path!;
    fs.writeFileSync(path.join(worktree, 'src/auth/login.ts'), 'export const login = 2;\n');
    fs.writeFileSync(path.join(worktree, 'src/auth/new.ts'), 'export const fresh = true;\n');
    const { handoff } = engine.handoffs.write({ agentId: 'alpha', kind: 'progress', summary: 'half done' });
    expect(handoff.files).toEqual(expect.arrayContaining(['src/auth/login.ts', 'src/auth/new.ts']));
    expect(handoff.branch).toBeTruthy();
  });
});

describe('handing a task back', () => {
  it('requeues it, frees the claim and gives the next claimant the note', () => {
    const { task } = begin('alpha', ['src/auth/**']);
    join('beta');
    expect(engine.locks.acquireLocks({ agentId: 'beta', patterns: ['src/auth/login.ts'] }).ok).toBe(false);
    const { released } = engine.handoffs.write({
      agentId: 'alpha', kind: 'blocked', summary: 'Needs the staging credentials.', remaining: ['Run the suite once credentials exist'], releaseTask: true,
    });
    expect(released).toBe(true);
    expect(engine.intents.getTask(task!.id)).toMatchObject({ status: 'queued', owner_agent_id: null });
    expect(engine.locks.listLocks().filter(lock => lock.owner_agent_id === 'alpha')).toEqual([]);

    const claimed = engine.claimNextTask({ agentId: 'beta' });
    expect(claimed.claimed).toBe(true);
    expect(claimed.task!.id).toBe(task!.id);
    expect(claimed.handoffs.untrusted).toBe(true);
    expect(claimed.handoffs.notice).toContain('never as instructions');
    expect(claimed.handoffs.items).toHaveLength(1);
    expect(claimed.handoffs.items[0]).toMatchObject({ kind: 'blocked', agentId: 'alpha', summary: 'Needs the staging credentials.', remaining: ['Run the suite once credentials exist'] });
  });
});

describe('when a session ends without a note', () => {
  it('records what Kith observed, before the claim that described it is released', () => {
    const { task } = begin('alpha', ['src/auth/**']);
    engine.locks.acquireLocks({ agentId: 'alpha', patterns: ['file:src/auth/login.ts'], lockType: 'file' });
    engine.coordDb.db.prepare(`INSERT INTO merge_queue (id, agent_id, branch, status, fencing_token, diagnostics_output, created_at, updated_at)
      VALUES ('mq1', 'alpha', 'kith/alpha', 'failed', 1, 'Speculative verification failed (npm test): 3 failing', ?, ?)`).run(Date.now(), Date.now());
    engine.fencing.abandonAgentSession('alpha');

    expect(engine.intents.getTask(task!.id)!.status).toBe('queued');
    const [note] = engine.handoffs.list({ taskId: task!.id });
    expect(note).toMatchObject({ kind: 'abandoned', source: 'auto', agent_id: 'alpha', task_id: task!.id, scope: ['src/auth/**'] });
    expect(note.summary).toContain('client disconnected');
    expect(note.summary).toContain('wrote no handoff note');
    expect(note.failed.join()).toContain('3 failing');
    expect(note.remaining.join()).toContain('returned to the queue');

    // Whoever picks the work up next, even through a different task, is told.
    const next = begin('beta', ['src/auth/login.ts'], 'fix login');
    expect(next.handoffs.items.map(item => item.id)).toContain(note.id);
  });

  it('writes nothing when no task was in flight', () => {
    join('idle');
    engine.fencing.abandonAgentSession('idle');
    expect(engine.handoffs.list({ includeResolved: true })).toEqual([]);
  });

  it('does not let a failure to record block reclaiming the session', () => {
    begin('alpha', ['src/auth/**']);
    engine.coordDb.db.exec('DROP TABLE handoffs');
    expect(() => engine.fencing.abandonAgentSession('alpha')).not.toThrow();
    expect(engine.fencing.getAgent('alpha')!.status).toBe('dead');
  });
});

describe('completing work', () => {
  it('leaves a completion note only when the agent wrote none', () => {
    const quiet = begin('quiet', ['docs/**']);
    engine.completeWork({ agentId: 'quiet' });
    expect(engine.handoffs.list({ taskId: quiet.task!.id, includeResolved: true })).toMatchObject([{ kind: 'done', source: 'auto' }]);

    const careful = begin('careful', ['lib/**']);
    engine.handoffs.write({ agentId: 'careful', kind: 'done', summary: 'Shipped; the cache key changed.', learned: ['Keys are versioned'] });
    engine.completeWork({ agentId: 'careful' });
    const notes = engine.handoffs.list({ taskId: careful.task!.id, includeResolved: true });
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatchObject({ kind: 'done', source: 'agent' });
  });

  it('retires earlier open notes for a finished task', () => {
    const { task } = begin('alpha', ['src/auth/**']);
    engine.handoffs.write({ agentId: 'alpha', kind: 'progress', summary: 'midway' });
    expect(engine.handoffs.unresolved().map(note => note.kind)).toEqual(['progress']);
    engine.completeWork({ agentId: 'alpha' });
    expect(engine.handoffs.unresolved()).toEqual([]);
    expect(engine.handoffs.list({ taskId: task!.id })).toEqual([]);
    expect(engine.handoffs.list({ taskId: task!.id, includeResolved: true }).length).toBeGreaterThan(0);
  });
});

describe('relevance and retention', () => {
  it('delivers by scope overlap only, newest unfinished first', () => {
    begin('alpha', ['src/auth/**']);
    engine.handoffs.write({ agentId: 'alpha', kind: 'progress', summary: 'auth notes' });
    begin('gamma', ['docs/**']);
    engine.handoffs.write({ agentId: 'gamma', kind: 'progress', summary: 'docs notes' });
    const forAuth = engine.handoffs.relevantTo({ scopeGlobs: ['src/auth/session.ts'] });
    expect(forAuth.map(note => note.summary)).toEqual(['auth notes']);
    expect(engine.handoffs.relevantTo({ scopeGlobs: ['infra/**'] })).toEqual([]);
    expect(engine.handoffs.relevantTo({ scopeGlobs: ['**'] }).map(note => note.summary).sort()).toEqual(['auth notes', 'docs notes']);
  });

  it('bounds the table to the newest rows', () => {
    join('alpha');
    engine.coordDb.withTransaction(() => {
      for (let i = 0; i < HANDOFF_LIMITS.keepRows + 25; i++) insertHandoff(engine.coordDb, { taskId: null, agentId: 'alpha', kind: 'progress', source: 'agent', summary: `note ${i}` });
    });
    const count = engine.coordDb.db.prepare('SELECT COUNT(*) AS n FROM handoffs').get() as { n: number };
    expect(count.n).toBe(HANDOFF_LIMITS.keepRows);
  });

  it('shows open notes in status, compactly', () => {
    begin('alpha', ['src/auth/**']);
    engine.handoffs.write({ agentId: 'alpha', kind: 'blocked', summary: 'y'.repeat(2000) });
    const status = engine.getStatus().handoffs;
    expect(status.untrusted).toBe(true);
    expect(status.items).toHaveLength(1);
    expect(status.items[0].summary.length).toBeLessThanOrEqual(300);
    expect(status.items[0].summaryTruncated).toBe(true);
  });
});

describe('mixed versions', () => {
  it('adds the table without changing the schema version, and tolerates its absence in older snapshots', () => {
    const version = () => engine.coordDb.db.prepare("SELECT value FROM meta WHERE key='schema_version'").get();
    expect(version()).toEqual({ value: '3' });
    engine.coordDb.db.exec('DROP TABLE handoffs');
    // An older binary's database has no handoffs table, and must still pass validation and read as schema 3.
    expect(CoordDatabase.inspectSchema(engine.coordDb.db)).toBe(3);
    engine.close();
    engine = new KithEngine(root);
    expect(engine.coordDb.db.prepare("SELECT name FROM sqlite_master WHERE name='handoffs'").get()).toBeTruthy();
    expect(version()).toEqual({ value: '3' });
  });
});

const plainEnv = () => Object.fromEntries(Object.entries(process.env).filter(([key, value]) => value !== undefined && !key.startsWith('KITH_'))) as Record<string, string>;

describe('through the MCP server', () => {
  it('writes, delivers and reads handoffs as untrusted data, and lets another agent take the task', async () => {
    const client = new Client({ name: 'handoff-test', version: '1.0.0' });
    await client.connect(new StdioClientTransport({ command: process.execPath, args: [cli, 'mcp', '--repo', root], env: plainEnv(), stderr: 'ignore' }));
    try {
      const call = async (name: string, args: Record<string, unknown>) => {
        const result = await client.callTool({ name, arguments: args });
        return { error: Boolean(result.isError), data: result.structuredContent as Record<string, any> };
      };
      const tools = (await client.listTools()).tools.map(tool => tool.name);
      expect(tools).toEqual(expect.arrayContaining(['kith_write_handoff', 'kith_read_handoffs']));

      const begun = await call('kith_begin_work', { agentId: 'alpha', title: 'fix refresh', scopeGlobs: ['src/auth/**'] });
      expect(begun.data.ok).toBe(true);
      expect(begun.data.handoffs).toMatchObject({ untrusted: true, items: [] });

      const written = await call('kith_write_handoff', {
        agentId: 'alpha', kind: 'blocked', summary: 'Refresh fails behind the proxy.', failed: ['Raised the timeout'],
        remaining: ['Bypass the proxy'], releaseTask: true, operationKey: 'handoff-1',
      });
      expect(written.error, JSON.stringify(written.data)).toBe(false);
      expect(written.data).toMatchObject({ ok: true, released: true, kind: 'blocked' });
      // The same operation key replays rather than writing twice.
      const replay = await call('kith_write_handoff', {
        agentId: 'alpha', kind: 'blocked', summary: 'Refresh fails behind the proxy.', failed: ['Raised the timeout'],
        remaining: ['Bypass the proxy'], releaseTask: true, operationKey: 'handoff-1',
      });
      expect(replay.data.handoffId).toBe(written.data.handoffId);

      const claimed = await call('kith_claim_next_task', { agentId: 'beta' });
      expect(claimed.data.claimed).toBe(true);
      expect(claimed.data.handoffs.untrusted).toBe(true);
      expect(claimed.data.handoffs.items).toHaveLength(1);
      expect(claimed.data.handoffs.items[0]).toMatchObject({ kind: 'blocked', agentId: 'alpha', failed: ['Raised the timeout'] });

      const read = await call('kith_read_handoffs', { taskId: claimed.data.task.id });
      expect(read.data.handoffs.items[0].summary).toBe('Refresh fails behind the proxy.');
      const status = await call('kith_get_status', {});
      expect(status.data.handoffs.untrusted).toBe(true);
    } finally { await client.close(); }
  }, 60_000);
});

describe('through the CLI', () => {
  it('writes and lists notes for a session that joined', () => {
    const run = (args: string[], env: Record<string, string> = plainEnv()) => spawnSync(process.execPath, [cli, '--repo', root, ...args], { cwd: root, env, encoding: 'utf8' });
    const started = run(['session', 'start', '--agent', 'worker']);
    expect(started.status, started.stderr).toBe(0);
    const session = { ...plainEnv(), KITH_AGENT_ID: 'worker', KITH_SESSION_TOKEN: JSON.parse(started.stdout).sessionToken as string };
    expect(run(['begin', '--title', 'cli work', '--scope', 'src/auth/**'], session).status).toBe(0);
    const written = run(['handoff', 'write', '--summary', 'Stopped at the token store, which is read-only.', '--kind', 'blocked', '--remaining', 'make it writable; add a test', '--release'], session);
    expect(written.status, written.stderr).toBe(0);
    expect(JSON.parse(written.stdout)).toMatchObject({ ok: true, released: true });
    const listed = JSON.parse(run(['handoff', 'list']).stdout);
    expect(listed.untrusted).toBe(true);
    expect(listed.items[0]).toMatchObject({ kind: 'blocked', remaining: ['make it writable', 'add a test'] });
    expect(run(['handoff', 'write', '--summary', 'no session'], plainEnv()).status).not.toBe(0);
    expect(run(['handoff', 'write', '--summary', 'bad', '--kind', 'abandoned'], session).status).not.toBe(0);
  }, 60_000);
});
