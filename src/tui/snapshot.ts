import type { DatabaseSync as Database } from 'node:sqlite';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { discoverRepository, isWithin, physicalPath, type RepositoryLayout } from '../core/repository.js';
import type { AgentRecord } from '../core/fencing.js';

const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as { DatabaseSync: typeof Database };
export interface DashboardTask { id: string; title: string; status: string; owner_agent_id: string | null; scope: string[] }
export interface DashboardWaiter { ticket: number; mutex_name: string; owner_agent_id: string; session_epoch: number; expires_at: number }
export interface DashboardGuard { mutex_name: string; owner_agent_id: string; worker_pid: number | null; supervisor_pid: number }
export interface DashboardResource { type: 'mutex' | 'port'; name: string; value: string; owner_agent_id: string; expires_at: number }
export interface DashboardSnapshot {
  observedAt: number; layout: RepositoryLayout; state: 'ready' | 'missing' | 'unavailable'; error?: string; epoch: number;
  agents: AgentRecord[]; tasks: DashboardTask[];
  locks: Array<{ pattern: string; owner_agent_id: string; expires_at: number; mode: string }>;
  conflicts: Array<{ file_path: string; agent_a: string; agent_b: string; severity: string }>;
  resources: DashboardResource[]; waiters: DashboardWaiter[]; guards: DashboardGuard[];
  recovery: Array<{ agent_id: string; file_path: string; patch_path: string }>;
  events: Array<{ id: number; agent_id: string | null; timestamp: number; event_type: string }>;
  integrations: Array<{ agent_id: string; status: string; updated_at: number }>;
}

/** Observation never initializes/migrates state, renews leases, reaps owners or acknowledges events. */
export function readDashboardSnapshot(directory = process.cwd(), now = Date.now()): DashboardSnapshot {
  const layout = discoverRepository(directory);
  const result: DashboardSnapshot = { observedAt: now, layout, state: 'missing', epoch: 0, agents: [], tasks: [], locks: [], conflicts: [], resources: [], waiters: [], guards: [], recovery: [], events: [], integrations: [] };
  let db: Database | undefined;
  try {
    for (let current = fs.realpathSync.native(directory); isWithin(layout.checkoutRoot, current); current = path.dirname(current)) {
      const local = path.join(current, '.coord');
      if (local !== layout.coordDir && fs.existsSync(path.join(local, 'state.db'))) throw new Error(`Legacy independent state at ${local}; preserve it before consolidating.`);
      if (current === layout.checkoutRoot) break;
    }
    const file = path.join(layout.coordDir, 'state.db');
    if (physicalPath(layout.coordDir) !== layout.coordDir || physicalPath(file) !== file) throw new Error('Coordination state is redirected through a symlink.');
    if (!fs.existsSync(file)) return result;
    db = new DatabaseSync(file, { readOnly: true });
    db.exec('PRAGMA query_only=ON; PRAGMA busy_timeout=1000; BEGIN');
    const all = <T>(sql: string) => db!.prepare(sql).all() as unknown as T[];
    const meta = all<{ key: string; value: string }>('SELECT key,value FROM meta');
    if (meta.find(r => r.key === 'schema_version')?.value !== '2') throw new Error('Unsupported coordination schema; upgrade with Kith after stopping old clients. The dashboard does not migrate it.');
    result.epoch = Number(meta.find(r => r.key === 'fencing_epoch')?.value ?? 0);
    result.agents = all<AgentRecord>('SELECT * FROM agents ORDER BY registered_at DESC,id');
    result.tasks = all<{ id: string; title: string; status: string; owner_agent_id: string | null; scope_globs_json: string }>('SELECT id,title,status,owner_agent_id,scope_globs_json FROM tasks').map(r => ({ ...r, scope: JSON.parse(r.scope_globs_json) as string[] }));
    result.locks = all('SELECT pattern,owner_agent_id,expires_at,mode FROM locks ORDER BY acquired_at');
    result.conflicts = all('SELECT file_path,agent_a,agent_b,severity FROM conflicts ORDER BY detected_at DESC');
    result.resources = all('SELECT type,name,value,owner_agent_id,expires_at FROM resources ORDER BY type,name');
    result.waiters = all('SELECT ticket,mutex_name,owner_agent_id,session_epoch,expires_at FROM mutex_waiters ORDER BY ticket');
    result.guards = all('SELECT mutex_name,owner_agent_id,worker_pid,supervisor_pid FROM mutex_runs ORDER BY mutex_name');
    result.recovery = all('SELECT agent_id,file_path,patch_path FROM quarantine ORDER BY created_at DESC LIMIT 6');
    result.events = all('SELECT id,agent_id,timestamp,event_type FROM events ORDER BY id DESC LIMIT 6');
    result.integrations = all('SELECT agent_id,status,updated_at FROM merge_queue ORDER BY updated_at DESC');
    db.exec('COMMIT');
    result.state = 'ready';
    return result;
  } catch (error) {
    // Drop partial observations rather than showing a misleading half-populated snapshot.
    return { ...result, state: 'unavailable', error: error instanceof Error ? error.message : String(error), agents: [], tasks: [], locks: [], conflicts: [], resources: [], waiters: [], guards: [], recovery: [], events: [], integrations: [] };
  } finally { db?.close(); }
}
