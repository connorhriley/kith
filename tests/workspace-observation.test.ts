import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { beforeEach, afterEach, expect, it } from 'vitest';
import { KithEngine, readCoordinationState, observeWorkspaces, recoveryReport } from '../src/index.js';
import { doctorReport } from '../src/cli/doctor.js';
let root:string,engine:KithEngine;
const git=(cwd:string,...args:string[])=>execFileSync('git',args,{cwd,encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
const digest=(directory:string):Record<string,string> => Object.fromEntries(fs.readdirSync(directory,{withFileTypes:true}).flatMap(entry=>{
 const p=path.join(directory,entry.name); if(entry.isDirectory())return Object.entries(digest(p));
 return [[p,entry.isSymbolicLink()?fs.readlinkSync(p):crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex')]];
}));
beforeEach(()=>{
 root=fs.mkdtempSync(path.join(os.tmpdir(),"kith observe ' "));git(root,'init');git(root,'config','user.name','Test');git(root,'config','user.email','test@example.test');
 fs.writeFileSync(path.join(root,'.gitignore'),'.coord/\n');fs.writeFileSync(path.join(root,'shared.ts'),'export const base = 1;\n');git(root,'add','.');git(root,'commit','-m','seed');
 engine=new KithEngine(root);engine.fencing.registerAgent({id:'a'});engine.fencing.registerAgent({id:'b'});
});
afterEach(()=>{engine.close();fs.rmSync(root,{recursive:true,force:true});});

it('observes worktree changes, actual branches, overlap and relative commits without modifying state or indexes',()=>{
 const a=engine.worktrees.spawnWorktree({agentId:'a'}),b=engine.worktrees.spawnWorktree({agentId:'b'});
 fs.appendFileSync(path.join(a.worktreePath,'shared.ts'),'export const a = true;\n');fs.appendFileSync(path.join(b.worktreePath,'shared.ts'),'export const b = true;\n');
 const agents=engine.fencing.listAgents();
 const before=digest(engine.coordDb.coordDir),indexes=[a,b].map(w=>fs.readFileSync(git(w.worktreePath,'rev-parse','--path-format=absolute','--git-path','index')));
 const status=observeWorkspaces(root,agents);
 expect(status).toHaveLength(2);
 for(const workspace of status){expect(workspace.available,workspace.error).toBe(true);expect(workspace.dirtyFiles.map(c=>c.path)).toContain('shared.ts');expect(workspace.overlaps[0].path).toBe('shared.ts');expect(workspace.ahead).toBe(0);expect(workspace.behind).toBe(0);expect(workspace.hoursSinceLastCommit).toBeGreaterThanOrEqual(0);}
 expect(digest(engine.coordDb.coordDir)).toEqual(before);
 [a,b].forEach((w,i)=>expect(fs.readFileSync(git(w.worktreePath,'rev-parse','--path-format=absolute','--git-path','index'))).toEqual(indexes[i]));
});

it('previews exact committed conflicts and refuses dirty inputs without checkpointing or advancing branches',()=>{
 const a=engine.worktrees.spawnWorktree({agentId:'a'}),b=engine.worktrees.spawnWorktree({agentId:'b'});
 fs.appendFileSync(path.join(a.worktreePath,'shared.ts'),'export const a = true;\n');
 const initial=git(root,'rev-parse','HEAD');
 expect(engine.previewIntegration('a').clean).toBeNull();expect(git(a.worktreePath,'rev-parse','HEAD')).toBe(initial);
 git(a.worktreePath,'add','.');git(a.worktreePath,'commit','-m','a');
 expect(engine.previewIntegration('a')).toMatchObject({ok:true,clean:true,verified:false});
 expect(engine.mergeTrain.enqueueAndMerge({agentId:'a',branch:a.branch,worktreePath:a.worktreePath}).merged).toBe(true);
 fs.appendFileSync(path.join(b.worktreePath,'shared.ts'),'export const b = true;\n');git(b.worktreePath,'add','.');git(b.worktreePath,'commit','-m','b');
 const targetHead=git(root,'rev-parse','HEAD'),sourceHead=git(b.worktreePath,'rev-parse','HEAD'),before=digest(engine.coordDb.coordDir);
 expect(engine.previewIntegration('b')).toMatchObject({ok:true,clean:false,conflicts:['shared.ts'],sourceHead,targetHead,verified:false});
 expect(git(root,'rev-parse','HEAD')).toBe(targetHead);expect(git(b.worktreePath,'rev-parse','HEAD')).toBe(sourceHead);expect(digest(engine.coordDb.coordDir)).toEqual(before);
 fs.writeFileSync(path.join(root,'local.txt'),'keep');expect(engine.previewIntegration('b').clean).toBeNull();expect(fs.readFileSync(path.join(root,'local.txt'),'utf8')).toBe('keep');
});

it('offline observation and doctor preserve expired owners, event cursors and the original WAL/SHM bytes',()=>{
 engine.locks.acquireLocks({agentId:'a',patterns:['shared.ts']});
 engine.coordDb.db.prepare("UPDATE agents SET lease_expires_at=0 WHERE id='a'").run();
 const before=digest(engine.coordDb.coordDir);
 const state=readCoordinationState(root);expect(state.state,state.error).toBe('ready');expect(state.agents.find(a=>a.id==='a')?.status).toBe('active');expect(state.locks).toHaveLength(1);
 const doctor=doctorReport(root);expect(doctor.checks.find(c=>c.name==='coordination-state')?.ok).toBe(true);
 expect(recoveryReport(root).agents.find(a=>a.id==='a')?.status).toBe('active');expect(digest(engine.coordDb.coordDir)).toEqual(before);
});

it('refuses unsupported offline state without migration and does not create state for doctor/recover',()=>{
 engine.coordDb.db.prepare("UPDATE meta SET value='999' WHERE key='schema_version'").run();const before=digest(engine.coordDb.coordDir);
 expect(readCoordinationState(root)).toMatchObject({state:'unavailable',agents:[]});expect(digest(engine.coordDb.coordDir)).toEqual(before);
 const empty=fs.mkdtempSync(path.join(os.tmpdir(),'kith-observe-empty-'));
 try{
  for(const args of [['doctor'],['recover'],['status','--offline']]){
   const result=spawnSync(process.execPath,[path.resolve('dist/cli/index.js'),...args,'--repo',empty],{encoding:'utf8'});expect(()=>JSON.parse(result.stdout)).not.toThrow();
  }
  expect(fs.readdirSync(empty)).toEqual([]);
 }finally{fs.rmSync(empty,{recursive:true,force:true});}
});


it('refuses configured merge drivers before preview can execute project commands',()=>{
 fs.writeFileSync(path.join(root,'.gitattributes'),'shared.ts merge=sideeffect\n');git(root,'add','.gitattributes');git(root,'commit','-m','Attributes');
 const a=engine.worktrees.spawnWorktree({agentId:'a'});
 fs.writeFileSync(path.join(root,'shared.ts'),'export const target = 2;\n');git(root,'commit','-am','Target change');
 fs.writeFileSync(path.join(a.worktreePath,'shared.ts'),'export const source = 3;\n');git(a.worktreePath,'commit','-am','Source change');
 git(root,'config','merge.sideeffect.driver','node -e "require(\'node:fs\').writeFileSync(\'preview-side-effect\',\'bad\')"');
 expect(()=>engine.previewIntegration('a')).toThrow('custom merge drivers');
 expect(fs.existsSync(path.join(root,'preview-side-effect'))).toBe(false);
 expect(fs.existsSync(path.join(a.worktreePath,'preview-side-effect'))).toBe(false);
});
