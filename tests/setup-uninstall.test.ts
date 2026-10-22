import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeEach,afterEach,it,expect,vi } from 'vitest';
import { initializeKithRepository } from '../src/cli/init.js';
import { uninstallKith } from '../src/cli/setup-ledger.js';
import { doctorReport } from '../src/cli/doctor.js';
let root:string;
beforeEach(()=>{root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'kith-uninstall-')));});
afterEach(()=>{vi.restoreAllMocks();fs.rmSync(root,{recursive:true,force:true});});
const source=()=>{
 fs.mkdirSync(path.join(root,'.claude'),{recursive:true});const file=path.join(root,'.claude/settings.json');
 const bytes=Buffer.from('{ "permissions": { "allow": ["Read"] } }\n');fs.writeFileSync(file,bytes,{mode:0o600});return {file,bytes};
};
it('previews and restores exact original configuration bytes while retaining database, work and ignore protection',()=>{
 const original=source();initializeKithRepository(root,'kith',{integrations:['claude','cursor','agents','shims']});
 const state=path.join(root,'.coord','state.db'),before=fs.readFileSync(state);
 fs.writeFileSync(path.join(root,'.coord/quarantine/saved.txt'),'keep');
 const preview=uninstallKith(root,true);expect(preview.restored).toContain('.claude/settings.json');expect(fs.readFileSync(original.file)).not.toEqual(original.bytes);
 const result=uninstallKith(root);expect(result.ok).toBe(true);expect(fs.readFileSync(original.file)).toEqual(original.bytes);expect(fs.statSync(original.file).mode&0o777).toBe(0o600);
 expect(fs.existsSync(path.join(root,'.mcp.json'))).toBe(false);expect(fs.readFileSync(state)).toEqual(before);expect(fs.readFileSync(path.join(root,'.coord/quarantine/saved.txt'),'utf8')).toBe('keep');
 expect(fs.readFileSync(path.join(root,'.gitignore'),'utf8')).toContain('.coord/');
});
it('preserves user-edited configuration even after a subsequent init mode update',()=>{
 source();initializeKithRepository(root,'kith',{integrations:['claude']});
 const file=path.join(root,'.claude/settings.json'),config=JSON.parse(fs.readFileSync(file,'utf8'));config.userChoice='keep';fs.writeFileSync(file,JSON.stringify(config));
 initializeKithRepository(root,'kith',{integrations:['claude'],enforcement:'warn'});
 const before=fs.readFileSync(file),result=uninstallKith(root);expect(result.ok).toBe(false);expect(result.needsReview).toContain('.claude/settings.json');expect(fs.readFileSync(file)).toEqual(before);
});
it('can undo a partially failed setup from backups written before client files',()=>{
 const original=source(),write=fs.writeFileSync;
 vi.spyOn(fs,'writeFileSync').mockImplementation((...args:any[])=>{if(args[0]===path.join(root,'.mcp.json'))throw new Error('injected interrupted setup');return (write as any)(...args);});
 expect(()=>initializeKithRepository(root,'kith',{integrations:['claude','cursor','agents']})).toThrow('injected');vi.restoreAllMocks();
 expect(uninstallKith(root).ok).toBe(true);expect(fs.readFileSync(original.file)).toEqual(original.bytes);expect(fs.existsSync(path.join(root,'.coord/state.db'))).toBe(true);
});
it('refuses damaged backup encodings before restoring any configuration',()=>{
 source();initializeKithRepository(root,'kith',{integrations:['claude']});
 const dir=path.join(root,'.coord/setup'),file=path.join(dir,fs.readdirSync(dir)[0]),ledger=JSON.parse(fs.readFileSync(file,'utf8'));
 Object.values(ledger.files).forEach((entry:any)=>{entry.before='not-valid-base64';});fs.writeFileSync(file,JSON.stringify(ledger));
 const before=fs.readFileSync(path.join(root,'.claude/settings.json'));expect(()=>uninstallKith(root)).toThrow('Damaged setup ledger');expect(fs.readFileSync(path.join(root,'.claude/settings.json'))).toEqual(before);
});
it('diagnoses missing inherited ownership when native hooks are installed without creating a session',()=>{
 initializeKithRepository(root,'kith',{integrations:['cursor']});
 const before=fs.readFileSync(path.join(root,'.coord/state.db')),report=doctorReport(root);
 expect(report.checks.find(c=>c.name==='session-environment')?.ok).toBe(false);expect(fs.readFileSync(path.join(root,'.coord/state.db'))).toEqual(before);
});


it('diagnoses the configured MCP launcher instead of requiring a global kith binary for an explicit launcher',()=>{
 initializeKithRepository(root,'kith',{integrations:['claude'],mcpOnly:true});
 const file=path.join(root,'.mcp.json'),config=JSON.parse(fs.readFileSync(file,'utf8'));
 config.mcpServers.kith={command:process.execPath,args:[path.resolve('dist/cli/index.js'),'mcp','--repo',root]};
 fs.writeFileSync(file,JSON.stringify(config));
 expect(doctorReport(root).checks.find(c=>c.name==='claude-mcp')?.ok).toBe(true);
 config.mcpServers.kith.command=path.join(root,'missing-launcher');fs.writeFileSync(file,JSON.stringify(config));
 expect(doctorReport(root).checks.find(c=>c.name==='claude-mcp')?.ok).toBe(false);
});


it('recognizes global setup before first work without creating project state or modifying config',()=>{
 const home=path.join(root,'home'),project=path.join(root,'project');
 fs.mkdirSync(home);fs.mkdirSync(project);
 const config=path.join(home,'.claude.json'),bytes=JSON.stringify({mcpServers:{kith:{command:process.execPath,args:[path.resolve('dist/cli/index.js'),'mcp']},peer:{command:'retained'}}});
 fs.writeFileSync(config,bytes);
 const report=doctorReport(project,home);
 expect(report.checks.find(c=>c.name==='claude-global-mcp')?.ok).toBe(true);
 expect(report.checks.find(c=>c.name==='mcp-configuration')?.ok).toBe(true);
 expect(report.checks.find(c=>c.name==='coordination-state')?.ok).toBe(true);
 expect(fs.existsSync(path.join(project,'.coord'))).toBe(false);
 expect(fs.existsSync(path.join(home,'.coord'))).toBe(false);
 expect(fs.readFileSync(config,'utf8')).toBe(bytes);
});

it('reports moved CLI entries and incorrectly pinned global launchers without rewriting them',()=>{
 const home=path.join(root,'home'),project=path.join(root,'project');fs.mkdirSync(home);fs.mkdirSync(project);
 const file=path.join(home,'.claude.json');
 for(const args of [[path.join(root,'missing.js'),'mcp'],[path.resolve('dist/cli/index.js'),'mcp','--repo',home]]){
  const bytes=JSON.stringify({mcpServers:{kith:{command:process.execPath,args}}});fs.writeFileSync(file,bytes);
  expect(doctorReport(project,home).checks.find(c=>c.name==='claude-global-mcp')?.ok).toBe(false);
  expect(fs.readFileSync(file,'utf8')).toBe(bytes);
  expect(fs.existsSync(path.join(project,'.coord'))).toBe(false);
 }
});
