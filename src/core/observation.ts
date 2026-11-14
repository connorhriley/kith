import { KITH_PROTOCOL_VERSION } from '../version.js';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { DatabaseSync as Database } from 'node:sqlite';
import { listRepoPresence } from '../cli/auto-session.js';
import { CoordDatabase, sqliteDatabase } from './db.js';
import { discoverRepository, isWithin, physicalPath } from './repository.js';
import { FencingAndAgentManager, type AgentRecord } from './fencing.js';
import { observeWorkspaces } from './workspace-observation.js';
import { LockEngine } from './locks.js';
import { HANDOFF_SELECT, rowToHandoff, type HandoffRecord } from './handoff-store.js';
import { workflowModeFrom, type WorkflowMode } from './mode.js';
import { buildBrief, type Brief } from './brief.js';

/** Copies a consistent stopped-state set before opening SQLite, so even SHM reconstruction cannot touch original recovery files. */
export function readCoordinationState(directory = process.cwd(), options: { ownersOnly?: boolean; coordinationOnly?: boolean } = {}) {
  const layout = discoverRepository(directory), observedAt = Date.now();
  const empty = { protocolVersion: KITH_PROTOCOL_VERSION, observedAt, repository: { root: layout.checkoutRoot, commonGitDir: layout.commonGitDir, coordDir: layout.coordDir },
    runtime: { node: process.version }, state: 'missing' as 'ready'|'missing'|'unavailable', error: undefined as string|undefined,
    sessionEpochs: {} as Record<string, number>, truncated: false, schemaVersion: 0, fencingEpoch: 0, agents: [] as AgentRecord[], tasks: [] as Record<string,unknown>[], locks: [] as Record<string,unknown>[],
    conflicts: [] as Record<string,unknown>[], contracts: [] as Record<string,unknown>[], resources: [] as Record<string,unknown>[],
    mergeQueue: [] as Record<string,unknown>[], quarantined: [] as Record<string,unknown>[], mutexWaiters: [] as Record<string,unknown>[],
    commandGuards: [] as Record<string,unknown>[], events: [] as Record<string,unknown>[], workspaces: [] as ReturnType<typeof observeWorkspaces>,
    handoffs: [] as HandoffRecord[], workflowMode: 'worktrees' as WorkflowMode, workflowModeConfigured: false };
  let scratch: string | undefined, db: Database | undefined;
  try {
    const file = path.join(layout.coordDir,'state.db');
    if (physicalPath(layout.coordDir) !== layout.coordDir || physicalPath(file) !== file) throw new Error('Coordination state must not be a symlink');
    for (let current = fs.realpathSync.native(directory); isWithin(layout.checkoutRoot, current); current = path.dirname(current)) {
      const local = path.join(current,'.coord');
      if (local !== layout.coordDir && fs.existsSync(path.join(local,'state.db'))) throw new Error(`Legacy independent state at ${local}; preserve it before consolidation`);
      if (current === layout.checkoutRoot) break;
    }
    if (!fs.existsSync(file)) {
      if (['setup.lock', 'merge-train.lock'].some(name => fs.existsSync(path.join(layout.coordDir, name))) || ['-wal','-shm','-journal'].some(s => fs.existsSync(file+s)) || ['worktrees','quarantine','snapshots','shadow-index','setup'].some(name => { const p=path.join(layout.coordDir,name); return fs.existsSync(p) && (!fs.lstatSync(p).isDirectory() || fs.readdirSync(p).length>0); })) throw new Error('Missing database with retained sidecars; preserve the recovery set');
      return empty;
    }
    const files = ['', '-wal', '-shm', '-journal'].map(s => file+s);
    const identity = (f: string) => {
      if (!fs.existsSync(f)) return null;
      if (physicalPath(f) !== f || !fs.lstatSync(f).isFile()) throw new Error('Database or sidecar is redirected or not a regular file');
      const s=fs.statSync(f,{bigint:true}); return [s.dev,s.ino,s.size,s.mtimeNs,s.ctimeNs].join(':');
    };
    const before = files.map(identity);
    scratch = fs.mkdtempSync(path.join(os.tmpdir(),'kith-observe-'));
    for (let i=0;i<files.length;i++) if (before[i]) {
      const target = path.join(scratch,path.basename(files[i])); fs.copyFileSync(files[i],target); fs.chmodSync(target,0o600);
    }
    if (JSON.stringify(before)!==JSON.stringify(files.map(identity))) throw new Error('Coordination state changed during snapshot; stop writers or retry');
    db = new (sqliteDatabase())(path.join(scratch,'state.db'), {readOnly:true});
    db.exec('PRAGMA query_only=ON; PRAGMA busy_timeout=1000; BEGIN');
    const schemaVersion = CoordDatabase.inspectSchema(db);
    if (schemaVersion<2) throw new Error('Offline observation requires schema 2 or newer; preserve state and upgrade with clients stopped');
    const all = <T=Record<string,unknown>>(sql:string) => db!.prepare(sql).all() as unknown as T[];
    // The handoffs table is optional (older binaries never created it), and the mode may never have been set.
    const hasTable = (name: string) => Boolean(db!.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name));
    const handoffs = hasTable('handoffs')
      ? all(`${HANDOFF_SELECT} WHERE h.created_at > ${observedAt - 30 * 24 * 3600 * 1000} ORDER BY h.created_at DESC, h.id DESC LIMIT 300`).map(rowToHandoff) : [];
    const rawMode = (db.prepare("SELECT value FROM meta WHERE key='workflow_mode'").get() as { value: string } | undefined)?.value;
    const workflowModeConfigured = rawMode === 'main' || rawMode === 'worktrees';
    const workflowMode = workflowModeFrom(rawMode);
    const agents=all<AgentRecord>('SELECT * FROM agents ORDER BY registered_at DESC' + (options.coordinationOnly ? ' LIMIT 201' : ''));
    if (options.coordinationOnly) {
      const tasks = all("SELECT * FROM tasks WHERE status IN ('active','blocked','queued') ORDER BY priority DESC, updated_at DESC LIMIT 201").map(({depends_on_json,scope_globs_json,...r})=>({...r,depends_on:JSON.parse(String(depends_on_json)),scope_globs:JSON.parse(String(scope_globs_json))}));
      const locks = all('SELECT * FROM locks WHERE expires_at > '+observedAt+' ORDER BY acquired_at DESC LIMIT 501');
      const resources = all('SELECT * FROM resources ORDER BY acquired_at DESC LIMIT 201');
      const mutexWaiters = all('SELECT ticket,mutex_name,owner_agent_id,session_epoch,expires_at FROM mutex_waiters ORDER BY ticket LIMIT 201');
      const commandGuards = all('SELECT mutex_name,owner_agent_id,session_epoch,fencing_token FROM mutex_runs LIMIT 201');
      const mergeQueue = all('SELECT agent_id,branch,worktree_path,status,fencing_token,created_at,updated_at FROM merge_queue WHERE rowid IN (SELECT MAX(rowid) FROM merge_queue GROUP BY agent_id,branch) ORDER BY created_at DESC LIMIT 201');
      const sessionEpochs = Object.fromEntries(all<{agent_id:string;epoch:number}>('SELECT s.agent_id,s.epoch FROM agent_sessions s JOIN agents a ON s.agent_id=a.id ORDER BY a.registered_at DESC LIMIT 201').map(r=>[r.agent_id,r.epoch]));
      const conflicts = all('SELECT * FROM conflicts ORDER BY detected_at DESC LIMIT 51').map(({details_json,...r})=>({...r,details:JSON.parse(String(details_json))}));
      db.exec('COMMIT');
      return {...empty,state:'ready' as const,schemaVersion,agents,sessionEpochs,tasks,locks,conflicts,handoffs,workflowMode,workflowModeConfigured,resources,mutexWaiters,commandGuards,mergeQueue,
        truncated:[agents,tasks,resources,mutexWaiters,commandGuards,mergeQueue].some(rows=>rows.length>200)||locks.length>500};
    }
    if (options.ownersOnly) { db.exec('COMMIT'); return { ...empty, state: 'ready' as const, schemaVersion, agents }; }
    const state = { ...empty, state:'ready' as const, schemaVersion, handoffs, workflowMode, workflowModeConfigured,
      fencingEpoch:Number((db.prepare("SELECT value FROM meta WHERE key='fencing_epoch'").get() as {value:string}).value), agents,
      tasks:all('SELECT * FROM tasks ORDER BY priority DESC,created_at').map(({depends_on_json,scope_globs_json,...r})=>({...r,depends_on:JSON.parse(String(depends_on_json)),scope_globs:JSON.parse(String(scope_globs_json))})),
      locks:all('SELECT * FROM locks ORDER BY acquired_at'),
      conflicts:all('SELECT * FROM conflicts ORDER BY detected_at DESC').map(({details_json,...r})=>({...r,details:JSON.parse(String(details_json))})),
      contracts:all('SELECT * FROM contracts ORDER BY updated_at DESC').map(r=>({...r,is_breaking:Boolean(r.is_breaking)})),
      resources:all('SELECT * FROM resources ORDER BY acquired_at'), mergeQueue:all('SELECT * FROM merge_queue ORDER BY created_at DESC'),
      quarantined:all('SELECT * FROM quarantine ORDER BY created_at DESC'),
      mutexWaiters:all('SELECT ticket,mutex_name,owner_agent_id,session_epoch,expires_at FROM mutex_waiters ORDER BY ticket'),
      commandGuards:all('SELECT mutex_name,owner_agent_id,worker_pid,supervisor_pid FROM mutex_runs ORDER BY mutex_name'),
      events:all('SELECT * FROM events ORDER BY id DESC LIMIT 100').map(({payload_json,...r})=>({...r,payload:JSON.parse(String(payload_json))})),
      workspaces:options.coordinationOnly ? [] : observeWorkspaces(layout.checkoutRoot,agents,observedAt),
    };
    db.exec('COMMIT'); return state;
  } catch(error) { return {...empty,state:'unavailable' as const,error:error instanceof Error ? error.message : String(error)}; }
  finally { db?.close(); if(scratch) fs.rmSync(scratch,{recursive:true,force:true}); }
}

/**
 * The brief, read from a private snapshot: it never creates state, migrates, reaps or writes, so it is safe to run from
 * any shell, hook or agent whether or not that process ever joined Kith.
 */
export function readBrief(directory = process.cwd(), options: { scopeGlobs?: string[]; handoffLimit?: number } = {}): Brief {
  const state = readCoordinationState(directory, { coordinationOnly: true });
  const scopeGlobs = options.scopeGlobs?.map(glob => { try { return LockEngine.normalizePattern(state.repository.root, glob); } catch { return glob; } });
  const tasks = (state.tasks as Array<Record<string, any>>).map(task => ({ id: String(task.id), title: String(task.title), status: String(task.status),
    owner_agent_id: (task.owner_agent_id as string | null) ?? null, scope_globs: (task.scope_globs as string[]) ?? [], priority: Number(task.priority), updated_at: Number(task.updated_at) }));
  const locks = (state.locks as Array<Record<string, any>>).map(lock => ({ owner_agent_id: String(lock.owner_agent_id), pattern: String(lock.pattern), mode: String(lock.mode), expires_at: Number(lock.expires_at) }));
  const agents: Array<Pick<AgentRecord, 'id' | 'client' | 'status' | 'lease_expires_at' | 'last_heartbeat_at'>> = [];
  const seenAgentIds = new Set<string>();
  const seenPids = new Set<number>();
  for (const agent of state.agents) {
    if (agent.status === 'active' && agent.id.startsWith('auto-')) {
      const alive = FencingAndAgentManager.isProcessAlive(agent.pid, agent.pid_start_time);
      if (alive) {
        seenAgentIds.add(agent.id);
        seenPids.add(agent.pid);
        agents.push({
          ...agent,
          lease_expires_at: Math.max(agent.lease_expires_at, state.observedAt + 60_000),
        });
        continue;
      }
      const hasTask = tasks.some(t => t.status === 'active' && t.owner_agent_id === agent.id);
      const hasLock = locks.some(l => l.owner_agent_id === agent.id && l.expires_at > state.observedAt);
      if (!hasTask && !hasLock && agent.lease_expires_at <= state.observedAt) {
        continue;
      }
    }
    if (agent.status === 'active') {
      seenAgentIds.add(agent.id);
      seenPids.add(agent.pid);
    }
    agents.push(agent);
  }
  if (state.state === 'ready' && state.repository.commonGitDir) {
    const peers = listRepoPresence(undefined, state.repository.commonGitDir);
    for (const peer of peers) {
      const cleanClient = peer.client.replace(/[^a-zA-Z0-9_-]/g, '').toLowerCase() || 'agent';
      const hash = crypto.createHash('sha1').update(peer.sessionKey).digest('hex').slice(0, 8);
      const autoId = `auto-${cleanClient}-${hash}`;
      if (seenAgentIds.has(autoId) || seenPids.has(peer.pid)) continue;
      seenAgentIds.add(autoId);
      seenPids.add(peer.pid);
      agents.push({
        id: autoId,
        client: peer.client,
        status: 'active',
        lease_expires_at: state.observedAt + 60_000,
        last_heartbeat_at: peer.lastSeenAt,
      });
    }
  }
  return buildBrief({
    repository: state.repository.root, mode: state.workflowMode, observedAt: state.observedAt,
    available: state.state === 'ready', error: state.state === 'unavailable' ? state.error : undefined,
    agents,
    tasks,
    locks,
    conflicts: (state.conflicts as Array<Record<string, any>>).map(conflict => ({ agent_a: String(conflict.agent_a), agent_b: String(conflict.agent_b), file_path: String(conflict.file_path), severity: String(conflict.severity) })),
    handoffs: state.handoffs,
  }, { ...options, scopeGlobs });
}

/** Recovery is an inspection report: it never clears guards, expires claims, deletes worktrees or restores files. */
export function recoveryReport(directory=process.cwd()) {
  const state=readCoordinationState(directory), retainedRoot=path.join(state.repository.coordDir,'worktrees');
  const retained = physicalPath(retainedRoot) === retainedRoot && fs.existsSync(retainedRoot) && fs.lstatSync(retainedRoot).isDirectory() && !fs.lstatSync(retainedRoot).isSymbolicLink()
    ? fs.readdirSync(retainedRoot,{withFileTypes:true}).map(entry=>({path:path.join(retainedRoot,entry.name),symlink:entry.isSymbolicLink(),
      agentIds:state.agents.filter(a=>a.worktree_path===path.join(retainedRoot,entry.name)).map(a=>a.id)})) : [];
  return {...state,retainedWorktrees:retained,expiredClaims:state.locks.filter(lock=>Number(lock.expires_at)<=state.observedAt),
    unfinishedIntegrations:state.mergeQueue.filter(entry=>entry.status!=='merged'),
    setupLock:{path:path.join(state.repository.coordDir,'setup.lock'),present:fs.existsSync(path.join(state.repository.coordDir,'setup.lock'))},
    integrationLock:{path:path.join(state.repository.coordDir,'merge-train.lock'),present:fs.existsSync(path.join(state.repository.coordDir,'merge-train.lock'))}};
}
