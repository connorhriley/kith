import crypto from 'node:crypto';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { CoordDatabase } from '../core/db.js';
import { FencingAndAgentManager, SessionOwnershipError, StaleFencingTokenError } from '../core/fencing.js';

type Data = Record<string, unknown>;
export class RetryError extends Error {
  constructor(public readonly code: string, message: string, public readonly retryable = false) { super(message); }
}

/** Preserve legacy fields; classify operational failures additively. Unknown failures never invite blind retries. */
export function failureData(error: unknown): Data {
  const message = error instanceof Error ? error.message : String(error);
  let code = 'OPERATION_FAILED', retryable = false;
  if (error instanceof RetryError) { code = error.code; retryable = error.retryable; }
  else if (error instanceof SessionOwnershipError) code = 'SESSION_OWNERSHIP';
  else if (error instanceof StaleFencingTokenError) code = 'STALE_FENCING_TOKEN';
  else if (error instanceof Error && error.name === 'AbortError') code = 'CANCELLED';
  else if (message.startsWith('Timed out waiting for mutex ')) { code = 'MUTEX_WAIT_TIMEOUT'; retryable = true; }
  else if (message === 'Mutex command execution timed out') code = 'COMMAND_TIMEOUT';
  else if (message === 'Mutex command output limit exceeded') code = 'COMMAND_OUTPUT_LIMIT';
  else if (/SQLITE_BUSY|database is locked/.test(message)) code = 'DATABASE_BUSY';
  else if (/schema|coordination database|fencing counter|recovery state/i.test(message)) code = 'STATE_UNAVAILABLE';
  else if (/repository|checkout path|project selected|connection is pinned|Command cwd|Invalid agent ID|Lease duration|Unsupported.*pattern/i.test(message)) code = 'INVALID_REQUEST';
  const details = error as { stdout?: string; stderr?: string } | null;
  return { ok: false, error: message, failure: { code, message, retryable,
    ...(retryable ? { retryAfterMs: 100 } : {}) },
    ...(typeof details?.stdout === 'string' ? { stdout: details.stdout } : {}),
    ...(typeof details?.stderr === 'string' ? { stderr: details.stderr } : {}) };
}

export function classifyResult(data: Data): Data {
  if (data.ok !== false || data.failure) return data;
  if (data.mergeResult) return { ...data, failure: { code: 'INTEGRATION_FAILED', retryable: false,
    message: 'Inspect mergeResult.diagnostics and repair or preserve the source worktree before a new completion attempt.' } };
  if (Array.isArray(data.lockConflicts) || Array.isArray(data.conflicts)) return { ...data, failure: {
    code: data.waitTimedOut ? 'CLAIM_WAIT_TIMEOUT' : 'CLAIM_CONFLICT', retryable: true, retryAfterMs: 100,
    message: 'Scope is owned by another session. Back off before a new attempt (with a new operationKey if used).' } };
  if (typeof data.exitCode === 'number') return { ...data, failure: { code: 'COMMAND_FAILED', retryable: false,
    message: 'Inspect stdout, stderr and exitCode; commands may have partial effects. Repair before a new attempt.' } };
  return { ...data, failure: { code: 'OPERATION_FAILED', retryable: false,
    message: typeof data.error === 'string' ? data.error : 'Inspect the result before a new attempt.' } };
}

export function toolReply(data: Data, footer: CallToolResult['content'] = []): CallToolResult {
  data = classifyResult(data);
  return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }, ...footer], structuredContent: data, isError: data.ok === false };
}

interface OperationRow {
  operation_key: string; request_hash: string; agent_id: string; session_epoch: number; capability_hash: string;
  owner_pid: number; owner_start: string; result_json: string | null;
}
interface Identity { agentId: string; sessionEpoch: number; token: string }
const hash = (text: string) => crypto.createHash('sha256').update(text).digest('hex');
function canonical(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.entries(value).filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => JSON.stringify(k) + ':' + canonical(v)).join(',') + '}';
  return JSON.stringify(value);
}

/** A committed reservation precedes side effects. Interrupted reservations are never re-executed. */
export class OperationJournal {
  private static readonly undurable = new Set<string>();
  constructor(private readonly db: CoordDatabase) {}

  async execute(params: {
    key: string; tool: string; input: Data; agentId?: string; token: () => string | undefined;
    authorize: () => Identity; run: () => Promise<CallToolResult>;
  }): Promise<CallToolResult> {
    const { operationKey: _key, sessionToken: _token, ...input } = params.input;
    const localKey = this.db.dbPath + ':' + params.key;
    const requestHash = hash(canonical({ tool: params.tool, checkout: this.db.repoRoot, input }));
    const operation = (state: string, replayed: boolean) => ({ key: params.key, state, replayed });
    const previous = this.db.withTransaction(() => {
      const row = this.db.db.prepare('SELECT * FROM mcp_operations WHERE operation_key=?').get(params.key) as OperationRow | undefined;
      if (row) {
        // Historical result access only. Never resume, renew or re-register ownership on replay.
        const token = params.token();
        if (!token || row.agent_id !== params.agentId || hash(token) !== row.capability_hash) throw new SessionOwnershipError(params.agentId ?? '');
        if (row.request_hash !== requestHash) throw new RetryError('OPERATION_KEY_REUSED', 'operationKey already identifies a different tool, checkout or input. Use a new key for new work.');
        return row;
      }
      const identity = params.authorize();
      const start = FencingAndAgentManager.getProcessStartTime(process.pid);
      if (!start) throw new RetryError('STATE_UNAVAILABLE', 'Cannot identify operation owner; no operation was started.');
      this.db.db.prepare(`INSERT INTO mcp_operations
        (operation_key,request_hash,agent_id,session_epoch,capability_hash,owner_pid,owner_start,result_json,created_at)
        VALUES (?,?,?,?,?,?,?,NULL,?)`).run(params.key, requestHash, identity.agentId, identity.sessionEpoch,
          hash(identity.token), process.pid, start, Date.now());
      return undefined;
    });
    if (previous) {
      if (previous.result_json !== null) {
        let saved: { data: Data; grantsToken: boolean };
        try {
          saved = JSON.parse(previous.result_json);
          if (!saved.data || typeof saved.data !== 'object' || Array.isArray(saved.data) || typeof saved.grantsToken !== 'boolean') throw new Error();
        } catch { throw new RetryError('STATE_UNAVAILABLE', 'Unreadable operation result. Preserve coordination state before repair.'); }
        return toolReply({ ...saved.data, ...(saved.grantsToken ? { sessionToken: params.token() } : {}), operation: operation('completed', true) });
      }
      const alive = !OperationJournal.undurable.has(localKey) && FencingAndAgentManager.isProcessAlive(previous.owner_pid, previous.owner_start);
      return toolReply({ ...failureData(new RetryError(alive ? 'OPERATION_IN_PROGRESS' : 'OPERATION_OUTCOME_UNKNOWN',
        alive ? 'Operation has not returned a durable result. Retry this same key after backoff; do not start a duplicate.'
          : 'Operation result was not recorded after its owner stopped or persistence failed. Inspect status, worktrees and external effects before deliberately starting new work with a new key.', alive)),
        operation: operation(alive ? 'running' : 'unknown', true) });
    }
    let reply: CallToolResult;
    try { reply = await params.run(); }
    catch (error) { reply = toolReply(failureData(error)); }
    const data = reply.structuredContent as Data;
    const { sessionToken, ...saved } = data;
    try {
      const result = this.db.db.prepare('UPDATE mcp_operations SET result_json=? WHERE operation_key=? AND result_json IS NULL')
        .run(JSON.stringify({ data: saved, grantsToken: typeof sessionToken === 'string' }), params.key);
      if (Number(result.changes) !== 1) throw new Error('Operation result was not recorded');
    } catch {
      OperationJournal.undurable.add(localKey);
      return toolReply({ ...failureData(new RetryError('OPERATION_OUTCOME_UNKNOWN',
        'The operation may have completed but its result could not be recorded. Preserve state and inspect effects; do not repeat it automatically.')),
        operation: operation('unknown', false) });
    }
    // Keep the first response's event footer; replays contain the operation snapshot only.
    return toolReply({ ...data, operation: operation('completed', false) }, reply.content.slice(1));
  }
}
