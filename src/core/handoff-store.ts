import crypto from 'node:crypto';
import type { CoordDatabase } from './db.js';

/**
 * Handoffs carry what an agent learned across a session boundary. Coordination state alone loses it: when a
 * session ends, its claims are released and its task is requeued as if untouched. This module is storage only,
 * with no Git or filesystem access, so it is safe to call inside a write transaction (session reclaim, task
 * completion). Everything an agent writes into a handoff is untrusted text for the next reader.
 */

export const HANDOFF_KINDS = ['progress', 'blocked', 'done', 'abandoned'] as const;
export type HandoffKind = (typeof HANDOFF_KINDS)[number];
/** Kinds an agent may write itself. `abandoned` is recorded by Kith when a session ends without a note. */
export const AGENT_HANDOFF_KINDS = ['progress', 'blocked', 'done'] as const;

export const HANDOFF_LIMITS = {
  summary: 4000, item: 500, items: 20, files: 100, file: 300, ref: 500, scopes: 50,
  keepRows: 500, keepMs: 30 * 24 * 3600 * 1000,
} as const;

export interface HandoffRecord {
  id: string;
  task_id: string | null;
  task_title: string | null;
  task_status: string | null;
  agent_id: string;
  client: string;
  kind: HandoffKind;
  source: 'agent' | 'auto';
  summary: string;
  done: string[];
  remaining: string[];
  learned: string[];
  failed: string[];
  files: string[];
  scope: string[];
  branch: string | null;
  worktree_path: string | null;
  transcript_ref: string | null;
  created_at: number;
}

export interface NewHandoff {
  taskId: string | null;
  agentId: string;
  client?: string;
  kind: HandoffKind;
  source: 'agent' | 'auto';
  summary: string;
  done?: string[];
  remaining?: string[];
  learned?: string[];
  failed?: string[];
  files?: string[];
  scope?: string[];
  branch?: string | null;
  worktreePath?: string | null;
  transcriptRef?: string | null;
}

/** Drop control characters other than newline/tab, trim, and cap length. */
export function cleanText(value: unknown, max: number): string {
  const text = String(value ?? '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').trim();
  return text.length > max ? text.slice(0, max - 1) + '…' : text;
}

export function cleanList(values: unknown, maxItems: number, maxLength: number): string[] {
  if (!Array.isArray(values)) return [];
  const out: string[] = [];
  for (const value of values) {
    const text = cleanText(value, maxLength);
    if (text && !out.includes(text)) out.push(text);
    if (out.length >= maxItems) break;
  }
  return out;
}

const parseList = (value: unknown): string[] => {
  try {
    const parsed = JSON.parse(String(value ?? '[]'));
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch { return []; }
};

export function rowToHandoff(row: Record<string, unknown>): HandoffRecord {
  return {
    id: String(row.id), task_id: (row.task_id as string | null) ?? null,
    task_title: (row.task_title as string | null) ?? null, task_status: (row.task_status as string | null) ?? null,
    agent_id: String(row.agent_id), client: String(row.client ?? ''),
    kind: row.kind as HandoffKind, source: row.source as 'agent' | 'auto', summary: String(row.summary ?? ''),
    done: parseList(row.done_json), remaining: parseList(row.remaining_json), learned: parseList(row.learned_json),
    failed: parseList(row.failed_json), files: parseList(row.files_json), scope: parseList(row.scope_json),
    branch: (row.branch as string | null) ?? null, worktree_path: (row.worktree_path as string | null) ?? null,
    transcript_ref: (row.transcript_ref as string | null) ?? null, created_at: Number(row.created_at),
  };
}

export const HANDOFF_SELECT = `
  SELECT h.*, t.title AS task_title, t.status AS task_status
  FROM handoffs AS h LEFT JOIN tasks AS t ON t.id = h.task_id`;

export function getHandoff(coordDb: CoordDatabase, id: string): HandoffRecord | null {
  const row = coordDb.db.prepare(`${HANDOFF_SELECT} WHERE h.id = ?`).get(id) as Record<string, unknown> | undefined;
  return row ? rowToHandoff(row) : null;
}

/** Insert, prune and announce. The caller owns the surrounding transaction. */
export function insertHandoff(coordDb: CoordDatabase, input: NewHandoff): HandoffRecord {
  const id = `handoff_${crypto.randomBytes(6).toString('hex')}`;
  const now = Date.now();
  const summary = cleanText(input.summary, HANDOFF_LIMITS.summary);
  const files = cleanList(input.files, HANDOFF_LIMITS.files, HANDOFF_LIMITS.file);
  coordDb.db.prepare(`
    INSERT INTO handoffs (id, task_id, agent_id, client, kind, source, summary, done_json, remaining_json,
      learned_json, failed_json, files_json, scope_json, branch, worktree_path, transcript_ref, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id, input.taskId, input.agentId, cleanText(input.client ?? '', 64), input.kind, input.source, summary,
    JSON.stringify(cleanList(input.done, HANDOFF_LIMITS.items, HANDOFF_LIMITS.item)),
    JSON.stringify(cleanList(input.remaining, HANDOFF_LIMITS.items, HANDOFF_LIMITS.item)),
    JSON.stringify(cleanList(input.learned, HANDOFF_LIMITS.items, HANDOFF_LIMITS.item)),
    JSON.stringify(cleanList(input.failed, HANDOFF_LIMITS.items, HANDOFF_LIMITS.item)),
    JSON.stringify(files),
    JSON.stringify(cleanList(input.scope, HANDOFF_LIMITS.scopes, HANDOFF_LIMITS.file)),
    input.branch ?? null, input.worktreePath ?? null,
    input.transcriptRef ? cleanText(input.transcriptRef, HANDOFF_LIMITS.ref) : null, now,
  );
  // Bound the table: nothing older than the retention window, and never more than the newest N rows.
  coordDb.db.prepare(`
    DELETE FROM handoffs WHERE created_at < ?
      OR id NOT IN (SELECT id FROM handoffs ORDER BY created_at DESC, id DESC LIMIT ?)
  `).run(now - HANDOFF_LIMITS.keepMs, HANDOFF_LIMITS.keepRows);
  coordDb.logEvent(input.agentId, 'handoff_written', {
    handoffId: id, taskId: input.taskId, kind: input.kind, source: input.source,
    summary: summary.length > 160 ? summary.slice(0, 159) + '…' : summary, fileCount: files.length,
  });
  return getHandoff(coordDb, id)!;
}

/** Files an agent is known to have touched, from coordination state alone. */
export function observedFiles(coordDb: CoordDatabase, agentId: string): string[] {
  const contracts = coordDb.db.prepare(
    'SELECT DISTINCT file_path AS file FROM contracts WHERE owner_agent_id = ? ORDER BY file_path LIMIT 50'
  ).all(agentId) as Array<{ file: string }>;
  const locks = coordDb.db.prepare(
    "SELECT DISTINCT pattern AS file FROM locks WHERE owner_agent_id = ? AND lock_type = 'file' ORDER BY pattern LIMIT 50"
  ).all(agentId) as Array<{ file: string }>;
  return cleanList([...locks, ...contracts].map(row => row.file), HANDOFF_LIMITS.files, HANDOFF_LIMITS.file);
}

const REASONS: Record<string, string> = {
  process_died_or_lease_expired: 'its process died or its lease expired',
  client_disconnected: 'its client disconnected',
};

/**
 * Called as a session is reclaimed, before its claims are released: record what Kith observed about each
 * unfinished task so the next agent does not start from nothing. Writes nothing when no task was in flight.
 */
export function captureAbandoned(coordDb: CoordDatabase, agentId: string, reason: string): void {
  const tasks = coordDb.db.prepare(
    "SELECT id, title, scope_globs_json FROM tasks WHERE owner_agent_id = ? AND status = 'active' ORDER BY created_at LIMIT 5"
  ).all(agentId) as Array<{ id: string; title: string; scope_globs_json: string }>;
  if (!tasks.length) return;
  const agent = coordDb.db.prepare('SELECT client, branch, worktree_path FROM agents WHERE id = ?')
    .get(agentId) as { client: string; branch: string | null; worktree_path: string | null } | undefined;
  const files = observedFiles(coordDb, agentId);
  const failure = coordDb.db.prepare(
    "SELECT diagnostics_output FROM merge_queue WHERE agent_id = ? AND status = 'failed' ORDER BY updated_at DESC LIMIT 1"
  ).get(agentId) as { diagnostics_output: string | null } | undefined;
  const quarantined = (coordDb.db.prepare(
    'SELECT DISTINCT file_path FROM quarantine WHERE agent_id = ? ORDER BY created_at DESC LIMIT 10'
  ).all(agentId) as Array<{ file_path: string }>).map(row => row.file_path);
  const failed: string[] = [];
  if (failure?.diagnostics_output) failed.push('Last failed integration: ' + cleanText(failure.diagnostics_output, 1500));
  if (quarantined.length) failed.push('Changes to locked files were quarantined: ' + quarantined.join(', '));
  for (const task of tasks) {
    insertHandoff(coordDb, {
      taskId: task.id, agentId, client: agent?.client, kind: 'abandoned', source: 'auto',
      summary: `Session '${agentId}' ended because ${REASONS[reason] ?? reason} while working on "${task.title}". It wrote no handoff note; this record lists only what Kith observed.`,
      remaining: [
        'The task was returned to the queue and is unfinished.',
        ...(agent?.worktree_path ? [`Inspect the previous worktree (branch ${agent.branch ?? 'unknown'}) for uncommitted or unintegrated work before starting over.`] : []),
      ],
      failed, files, scope: parseList(task.scope_globs_json),
      branch: agent?.branch, worktreePath: agent?.worktree_path,
    });
  }
}

/** Called as a task completes, while its claims still exist: leave a trace when the agent wrote no note. */
export function captureCompletion(coordDb: CoordDatabase, agentId: string, task: { id: string; title: string; scope_globs: string[] }): void {
  const noted = coordDb.db.prepare("SELECT 1 FROM handoffs WHERE task_id = ? AND kind = 'done' LIMIT 1").get(task.id);
  if (noted) return;
  const agent = coordDb.db.prepare('SELECT client, branch, worktree_path FROM agents WHERE id = ?')
    .get(agentId) as { client: string; branch: string | null; worktree_path: string | null } | undefined;
  const merged = coordDb.db.prepare(
    "SELECT diagnostics_output FROM merge_queue WHERE agent_id = ? AND status = 'merged' ORDER BY updated_at DESC LIMIT 1"
  ).get(agentId) as { diagnostics_output: string | null } | undefined;
  insertHandoff(coordDb, {
    taskId: task.id, agentId, client: agent?.client, kind: 'done', source: 'auto',
    summary: `Completed "${task.title}". The agent wrote no handoff note; this record lists only what Kith observed.`,
    done: merged?.diagnostics_output ? [cleanText(merged.diagnostics_output, 300)] : [],
    files: observedFiles(coordDb, agentId), scope: task.scope_globs,
    branch: agent?.branch, worktreePath: agent?.worktree_path,
  });
}
