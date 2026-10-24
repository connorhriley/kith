import { KITH_PROTOCOL_VERSION } from '../version.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import type { DatabaseSync as Database } from 'node:sqlite';
import { CoordDatabase } from './db.js';
import { discoverRepository, isWithin, physicalPath } from './repository.js';
import type { AgentRecord } from './fencing.js';
import { observeWorkspaces } from './workspace-observation.js';
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as { DatabaseSync: typeof Database };

/** Copies a consistent stopped-state set before opening SQLite, so even SHM reconstruction cannot touch original recovery files. */
export function readCoordinationState(directory = process.cwd(), options: { ownersOnly?: boolean; coordinationOnly?: boolean } = {}) {
  const layout = discoverRepository(directory), observedAt = Date.now();
  const empty = { protocolVersion: KITH_PROTOCOL_VERSION, observedAt, repository: { root: layout.checkoutRoot, commonGitDir: layout.commonGitDir, coordDir: layout.coordDir },
    runtime: { node: process.version }, state: 'missing' as 'ready'|'missing'|'unavailable', error: undefined as string|undefined,
    sessionEpochs: {} as Record<string, number>, truncated: false, schemaVersion: 0, fencingEpoch: 0, agents: [] as AgentRecord[], tasks: [] as Record<string,unknown>[], locks: [] as Record<string,unknown>[],
    conflicts: [] as Record<string,unknown>[], contracts: [] as Record<string,unknown>[], resources: [] as Record<string,unknown>[],
    mergeQueue: [] as Record<string,unknown>[], quarantined: [] as Record<string,unknown>[], mutexWaiters: [] as Record<string,unknown>[],
    commandGuards: [] as Record<string,unknown>[], events: [] as Record<string,unknown>[], workspaces: [] as ReturnType<typeof observeWorkspaces> };
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
    db = new DatabaseSync(path.join(scratch,'state.db'), {readOnly:true});
    db.exec('PRAGMA query_only=ON; PRAGMA busy_timeout=1000; BEGIN');
    const schemaVersion = CoordDatabase.inspectSchema(db);
    if (schemaVersion<2) throw new Error('Offline observation requires schema 2 or newer; preserve state and upgrade with clients stopped');
    const all = <T=Record<string,unknown>>(sql:string) => db!.prepare(sql).all() as unknown as T[];
    const agents=all<AgentRecord>('SELECT * FROM agents ORDER BY registered_at DESC' + (options.coordinationOnly ? ' LIMIT 201' : ''));
    if (options.coordinationOnly) {
      const tasks = all("SELECT * FROM tasks WHERE status IN ('active','blocked') ORDER BY updated_at DESC LIMIT 201").map(({depends_on_json,scope_globs_json,...r})=>({...r,depends_on:JSON.parse(String(depends_on_json)),scope_globs:JSON.parse(String(scope_globs_json))}));
      const locks = all('SELECT * FROM locks WHERE expires_at > '+observedAt+' ORDER BY acquired_at DESC LIMIT 501');
      const resources = all('SELECT * FROM resources ORDER BY acquired_at DESC LIMIT 201');
      const mutexWaiters = all('SELECT ticket,mutex_name,owner_agent_id,session_epoch,expires_at FROM mutex_waiters ORDER BY ticket LIMIT 201');
      const commandGuards = all('SELECT mutex_name,owner_agent_id,session_epoch,fencing_token FROM mutex_runs LIMIT 201');
      const mergeQueue = all('SELECT agent_id,branch,worktree_path,status,fencing_token,created_at,updated_at FROM merge_queue WHERE rowid IN (SELECT MAX(rowid) FROM merge_queue GROUP BY agent_id,branch) ORDER BY created_at DESC LIMIT 201');
      const sessionEpochs = Object.fromEntries(all<{agent_id:string;epoch:number}>('SELECT s.agent_id,s.epoch FROM agent_sessions s JOIN agents a ON s.agent_id=a.id ORDER BY a.registered_at DESC LIMIT 201').map(r=>[r.agent_id,r.epoch]));
      db.exec('COMMIT');
      return {...empty,state:'ready' as const,schemaVersion,agents,sessionEpochs,tasks,locks,resources,mutexWaiters,commandGuards,mergeQueue,
        truncated:[agents,tasks,resources,mutexWaiters,commandGuards,mergeQueue].some(rows=>rows.length>200)||locks.length>500};
    }
    if (options.ownersOnly) { db.exec('COMMIT'); return { ...empty, state: 'ready' as const, schemaVersion, agents }; }
    const state = { ...empty, state:'ready' as const, schemaVersion,
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
