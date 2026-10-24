import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {afterEach, beforeEach, expect, it, vi} from 'vitest';
import {KithEngine} from '../src/core/engine.js';
import {readCoordinationState} from '../src/core/observation.js';
import {coordinationView} from '../src/core/coordination-view.js';
import {PassiveConflictWatcher} from '../src/core/watcher.js';
import {setupRuntime, verifySetupRuntime} from '../src/cli/setup-runtime.js';
import {autoConfigureAllClients} from '../src/cli/setup-auto.js';
import {uninstallKith} from '../src/cli/setup-ledger.js';

let temp: string;
const engines: KithEngine[] = [];
beforeEach(()=>{temp=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'kith-usability-')));});
afterEach(()=>{vi.restoreAllMocks();for(const e of engines.splice(0))e.close();fs.rmSync(temp,{recursive:true,force:true});});
const git=(cwd:string,...args:string[])=>execFileSync('git',args,{cwd,encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
function repo() {
  const root=path.join(temp,'project');fs.mkdirSync(root);git(root,'init','-q');git(root,'config','user.name','Fixture');git(root,'config','user.email','fixture@example.invalid');
  fs.writeFileSync(path.join(root,'.gitignore'),'.coord/\n');fs.writeFileSync(path.join(root,'a.mjs'),'export const a=0;\n');git(root,'add','.');git(root,'commit','-qm','seed');return root;
}
function engine(root:string){const e=new KithEngine(root);engines.push(e);return e;}
const view=(root:string)=>coordinationView(readCoordinationState(root,{coordinationOnly:true}));

it('one setup command survives deletion of its transient package and preserves/restores existing configuration',async()=>{
  const root=repo(), home=path.join(temp,'home'), transient=path.join(temp,'npx-cache');
  fs.mkdirSync(path.join(home,'.claude'),{recursive:true});fs.mkdirSync(transient);
  fs.cpSync(path.resolve('dist'),path.join(transient,'dist'),{recursive:true});
  fs.writeFileSync(path.join(transient,'package.json'),'{"name":"kith-coord","type":"module"}');
  const original='{ "mcpServers": { "peer": { "command": "keep" } }, "permissions": "unchanged" }\n';
  fs.writeFileSync(path.join(home,'.claude.json'),original);
  const agents='Existing team instructions\n';fs.writeFileSync(path.join(root,'AGENTS.md'),agents);
  const env={...process.env,HOME:home,USERPROFILE:home};
  const cli=path.join(transient,'dist/cli/index.js');
  const run=(...args:string[])=>execFileSync(process.execPath,[cli,'setup',root,...args],{env,cwd:root,encoding:'utf8',timeout:20000});
  run('--dry-run');expect(fs.existsSync(path.join(home,'.local'))).toBe(false);expect(fs.readFileSync(path.join(root,'AGENTS.md'),'utf8')).toBe(agents);
  run();
  const cfg=JSON.parse(fs.readFileSync(path.join(home,'.claude.json'),'utf8'));
  expect(cfg.permissions).toBe('unchanged');expect(cfg.mcpServers.peer.command).toBe('keep');
  expect(fs.readFileSync(path.join(root,'AGENTS.md'),'utf8')).toContain(agents.trim());
  expect(fs.readFileSync(path.join(root,'AGENTS.md'),'utf8')).toContain('kith_begin_work');
  const configured=fs.readFileSync(path.join(home,'.claude.json'));run();expect(fs.readFileSync(path.join(home,'.claude.json'))).toEqual(configured);
  fs.rmSync(transient,{recursive:true});await verifySetupRuntime(cfg.mcpServers.kith.args[0]);
  fs.writeFileSync(path.join(root,'unfinished.txt'),'keep unfinished work');
  expect(uninstallKith(home).ok).toBe(true);expect(fs.readFileSync(path.join(home,'.claude.json'),'utf8')).toBe(original);
  expect(uninstallKith(root).ok).toBe(true);expect(fs.readFileSync(path.join(root,'AGENTS.md'),'utf8')).toBe(agents);
  expect(fs.readFileSync(path.join(root,'unfinished.txt'),'utf8')).toBe('keep unfinished work');
});

it('an interrupted retained-runtime install is retryable; damaged selected runtimes are never overwritten',async()=>{
  const home=path.join(temp,'home');fs.mkdirSync(home);
  vi.spyOn(fs,'renameSync').mockImplementation(()=>{throw new Error('interrupted runtime install');});
  expect(()=>setupRuntime(home)).toThrow('interrupted');vi.restoreAllMocks();
  const cli=setupRuntime(home);await verifySetupRuntime(cli);
  expect(setupRuntime(home)).toBe(cli);
  fs.writeFileSync(cli,'damaged');expect(()=>setupRuntime(home)).toThrow('damaged');expect(fs.readFileSync(cli,'utf8')).toBe('damaged');
});

it('malformed guidance fails preflight before changing any client; redirected retained runtime is refused',()=>{
  const root=repo(),home=path.join(temp,'home');fs.mkdirSync(path.join(home,'.claude'),{recursive:true});
  fs.writeFileSync(path.join(root,'AGENTS.md'),'<!-- KITH:START --> unfinished');
  expect(()=>autoConfigureAllClients(root,home,{guidance:true,dryRun:true})).toThrow('incomplete');
  expect(fs.existsSync(path.join(home,'.claude.json'))).toBe(false);
  fs.mkdirSync(path.join(home,'.local/share'),{recursive:true});fs.symlinkSync(temp,path.join(home,'.local/share/kith'),'dir');
  expect(()=>setupRuntime(home)).toThrow('redirected');
});

it('distinguishes watching, registered sessions, real tasks, current claims and resource wait/release',()=>{
  const root=repo();expect(view(root)).toMatchObject({available:true,sessions:0,working:[]});expect(fs.existsSync(path.join(root,'.coord'))).toBe(false);
  const e=engine(root);e.fencing.registerAgent({id:'alpha'});
  expect(view(root)).toMatchObject({sessions:1,working:[]});
  const a=e.beginWork({agentId:'alpha',title:'Fix invoice calculation',scopeGlobs:['a.mjs'],isolateWorktree:true});expect(a.ok).toBe(true);
  e.fencing.registerAgent({id:'beta'});e.beginWork({agentId:'beta',title:'Fix receipt',scopeGlobs:['b.mjs']});
  const held=e.broker.tryAcquireMutex({agentId:'alpha',mutexName:'tests'});expect(held.acquired).toBe(true);
  expect(e.broker.tryAcquireMutex({agentId:'beta',mutexName:'tests'}).acquired).toBe(false);
  expect(view(root)).toMatchObject({working:expect.arrayContaining([{agentId:'alpha',client:'unknown',title:'Fix invoice calculation',taskId:expect.any(String),checkout:expect.any(String),scopes:['a.mjs']}]),waiting:[{agentId:'beta',resource:'tests',holder:'alpha',position:1}]});
  e.broker.releaseMutex({agentId:'alpha',mutexName:'tests',fencingToken:held.fencingToken});
  expect(e.broker.tryAcquireMutex({agentId:'beta',mutexName:'tests'}).acquired).toBe(true);expect(view(root).waiting).toEqual([]);
});

it('shows a real failed verification, preserves source and target, and clears it after repaired integration',async()=>{
  const root=repo(),e=engine(root);e.fencing.registerAgent({id:'alpha'});
  const a=e.beginWork({agentId:'alpha',title:'Fix calculation',scopeGlobs:['a.mjs'],isolateWorktree:true});
  const tree=a.worktree!.worktreePath;fs.writeFileSync(path.join(tree,'a.mjs'),'export const a=1;\n');git(tree,'add','.');git(tree,'commit','-qm','Fix calculation');
  const before=git(root,'rev-parse','HEAD');expect(e.completeWork({agentId:'alpha',verificationCmd:'node -e "process.exit(17)"'}).ok).toBe(false);
  expect(git(root,'rev-parse','HEAD')).toBe(before);expect(fs.readFileSync(path.join(tree,'a.mjs'),'utf8')).toContain('a=1');
  expect(view(root).attention).toEqual([{message:'Integration did not pass: alpha',nextStep:expect.stringContaining('repair')}]);
  expect(e.completeWork({agentId:'alpha',verificationCmd:'node --check a.mjs'}).ok).toBe(true);
  expect(view(root)).toMatchObject({working:[],waiting:[],attention:[],sessions:0});
  const watcher=new PassiveConflictWatcher(root);await watcher.scanOnce();expect(watcher.getScanState().worktrees.find(w=>w.path===tree)?.activity).toBe('retained');
  expect(fs.readFileSync(path.join(tree,'a.mjs'),'utf8')).toContain('a=1');
});

it('excludes expired and replaced generations and reports unavailable data without writing original state',()=>{
  const root=repo(),e=engine(root);const a=e.fencing.registerAgent({id:'alpha'});e.beginWork({agentId:'alpha',title:'Old task',scopeGlobs:['a.mjs']});
  e.coordDb.db.prepare('UPDATE agents SET lease_expires_at=0 WHERE id=?').run('alpha');
  expect(view(root)).toMatchObject({sessions:0,working:[]});
  e.fencing.registerAgent({id:'alpha'});expect(view(root).working).toEqual([]);
  e.coordDb.db.prepare("INSERT INTO mutex_waiters(mutex_name,request_id,owner_agent_id,session_epoch,waiter_pid,waiter_start,expires_at) VALUES('tests','old','alpha',?,?,?,?)").run(a.sessionEpoch,process.pid,a.agent.pid_start_time,Date.now()+60000);
  expect(view(root).waiting).toEqual([]);
  const files=['state.db','state.db-wal','state.db-shm'].map(n=>path.join(e.coordDb.coordDir,n));
  const before=files.map(f=>fs.existsSync(f)?fs.readFileSync(f):null);view(root);expect(files.map(f=>fs.existsSync(f)?fs.readFileSync(f):null)).toEqual(before);
  const unavailable={...readCoordinationState(root,{coordinationOnly:true}),state:'unavailable' as const};expect(coordinationView(unavailable)).toMatchObject({available:false,working:[],attention:[{message:'Coordination status unavailable',nextStep:expect.any(String)}]});
});
