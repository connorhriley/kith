// Credential-free native platform workflow. Commands requiring POSIX groups must fail closed on Windows.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
const cli=fileURLToPath(new URL('../dist/cli/index.js',import.meta.url));
const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),"kith platform ' spaces ")));
const env=Object.fromEntries(Object.entries(process.env).filter(([key,value])=>value!==undefined&&!key.startsWith('KITH_')));
const clients=[];
const report={platform:process.platform,node:process.version,passed:false,phase:'setup',checks:[]};
const git=(cwd,...args)=>execFileSync('git',args,{cwd,env,encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
const command=(...args)=>execFileSync(process.execPath,[cli,'--repo',root,...args],{cwd:root,env,encoding:'utf8',stdio:['ignore','pipe','pipe']});
const body=result=>result.structuredContent??JSON.parse(result.content[0].text);
async function call(client,name,args={}) {
 report.phase=name;
 const result=await client.callTool({name,arguments:args});
 if(result.isError) {
  const text=result.content?.[0]?.text??'Unknown tool failure';
  throw new Error(`${name}: ${text.startsWith('{')?'Unexpected refusal':text.replace(/[A-Za-z0-9_-]{43}/g,'[redacted]')}`);
 }
 return body(result);
}
async function connect() {
 const client=new Client({name:'native-platform-workflow',version:'1.0.0'});
 const transport=new StdioClientTransport({command:process.execPath,args:[cli,'mcp','--repo',root],cwd:root,env,stderr:'ignore'});
 clients.push(client);await client.connect(transport);return {client,transport};
}
function fingerprints(dir) {
 return Object.fromEntries(fs.readdirSync(dir,{withFileTypes:true}).flatMap(entry=>{
  const file=path.join(dir,entry.name);
  if(entry.isDirectory())return Object.entries(fingerprints(file));
  return [[file,entry.isSymbolicLink()?fs.readlinkSync(file):crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')]];
 }));
}
try {
 git(root,'init','-q');git(root,'config','user.name','Kith platform fixture');git(root,'config','user.email','fixture@example.test');
 fs.writeFileSync(path.join(root,'.gitignore'),'.coord/\n.cursor/\n.claude/\n.codex/\n.mcp.json\nAGENTS.md\n.agent/\n');
 fs.mkdirSync(path.join(root,'src'));fs.writeFileSync(path.join(root,'src/base.mjs'),'export const base = true;\n');
 git(root,'add','.');git(root,'commit','-qm','Platform fixture');
 report.git=git(root,'--version');
 const {client:one,transport}=await connect(),{client:two}=await connect();
 const a=await call(one,'kith_begin_work',{agentId:'alpha',title:'Alpha',scopeGlobs:['file:src/routes/[id]/page.mjs'],isolateWorktree:true});
 const refused=await two.callTool({name:'kith_begin_work',arguments:{agentId:'beta',title:'Overlap probe',scopeGlobs:['file:src/routes/[id]/page.mjs']}});
 assert.equal(refused.isError,true);assert(body(refused).lockConflicts.length);
 assert.equal((await two.callTool({name:'kith_heartbeat',arguments:{agentId:'alpha'}})).isError,true);
 const b=await call(two,'kith_begin_work',{agentId:'beta',title:'Beta',scopeGlobs:['src/beta.mjs'],isolateWorktree:true});
 report.checks.push('owned sessions, refused overlap and refused capability theft');
 const fileA=path.join(a.worktree.worktreePath,'src/routes/[id]/page.mjs');
 fs.mkdirSync(path.dirname(fileA),{recursive:true});fs.writeFileSync(fileA,'export const alpha = true;\n');
 fs.writeFileSync(path.join(b.worktree.worktreePath,'src/beta.mjs'),'export const beta = true;\n');
 await call(one,'kith_record_file_edit',{agentId:'alpha',filePath:fileA});
 await call(two,'kith_record_file_edit',{agentId:'beta',filePath:path.join(b.worktree.worktreePath,'src/beta.mjs')});
 const ports=await Promise.all([call(one,'kith_acquire_port',{agentId:'alpha',serviceName:'web'}),call(two,'kith_acquire_port',{agentId:'beta',serviceName:'web'})]);
 assert.notEqual(ports[0].port,ports[1].port);
 report.checks.push('native absolute paths, literal bracket filenames, independent worktrees and distinct port leases');
 if(process.platform==='win32') {
  const marker=path.join(root,'must-not-run');
  const blocked=await one.callTool({name:'kith_run_with_mutex',arguments:{agentId:'alpha',mutexName:'unsupported',command:[process.execPath,'-e',`require('node:fs').writeFileSync(${JSON.stringify(marker)},'bad')`]}});
  assert.equal(blocked.isError,true);assert.match(blocked.content[0].text,/require macOS or Linux process groups/);
  assert.equal(fs.existsSync(marker),false);
  const state=await call(one,'kith_get_status');assert.equal(state.commandGuards.length,0);assert.equal(state.mutexWaiters.length,0);
  report.checks.push('unsupported process-group supervision refused without execution or leaked guards');
 }
 report.phase='preview and verification';
 assert.equal((await one.callTool({name:'kith_preview_integrate',arguments:{agentId:'alpha'}})).isError,true);
 git(a.worktree.worktreePath,'add','.');git(a.worktree.worktreePath,'commit','-qm','Alpha');
 assert.equal((await call(one,'kith_preview_integrate',{agentId:'alpha'})).clean,true);
 const head=git(root,'rev-parse','HEAD');
 assert.equal((await one.callTool({name:'kith_complete_work',arguments:{agentId:'alpha',verificationCmd:'node -e "process.exit(17)"'}})).isError,true);
 assert.equal(git(root,'rev-parse','HEAD'),head);assert.equal(fs.readFileSync(fileA,'utf8'),'export const alpha = true;\n');
 await call(one,'kith_complete_work',{agentId:'alpha',verificationCmd:'node --check "src/routes/[id]/page.mjs"'});
 await call(two,'kith_complete_work',{agentId:'beta',verificationCmd:'node --check src/beta.mjs'});
 assert.equal(fs.readFileSync(path.join(root,'src/routes/[id]/page.mjs'),'utf8'),'export const alpha = true;\n');
 assert.equal(fs.readFileSync(path.join(root,'src/beta.mjs'),'utf8'),'export const beta = true;\n');
 report.checks.push('dirty preview refusal, committed preview, failed verification and successful retry/integration');
 const crash=await call(one,'kith_begin_work',{agentId:'crash',title:'Recover interrupted work',scopeGlobs:['src/recovered.mjs'],isolateWorktree:true});
 const saved=path.join(crash.worktree.worktreePath,'src/recovered.mjs');fs.writeFileSync(saved,'export const recovered = true;\n');
 report.phase='kill and resume owner';process.kill(transport.pid,'SIGKILL');await one.close();
 const {client:replacement}=await connect();
 const resumed=await call(replacement,'kith_claim_next_task',{agentId:'crash'});assert.equal(resumed.claimed,true);assert.notEqual(resumed.sessionToken,crash.sessionToken);
 assert.equal((await replacement.callTool({name:'kith_heartbeat',arguments:{agentId:'crash',sessionToken:crash.sessionToken}})).isError,true);
 assert.equal(fs.readFileSync(saved,'utf8'),'export const recovered = true;\n');
 await call(replacement,'kith_record_file_edit',{agentId:'crash',filePath:saved});
 await call(replacement,'kith_complete_work',{agentId:'crash',verificationCmd:'node --check src/recovered.mjs'});
 assert.equal(fs.readFileSync(path.join(root,'src/recovered.mjs'),'utf8'),'export const recovered = true;\n');
 report.checks.push('killed MCP owner recovered with new capability and preserved worktree, then integrated');
 await Promise.all(clients.map(client=>client.close()));clients.length=0;
 report.phase='offline recovery and setup';
 const state=path.join(root,'.coord'),before=fingerprints(state);
 assert.equal(JSON.parse(command('status','--offline')).state,'ready');assert.equal(JSON.parse(command('recover')).state,'ready');
 assert.deepEqual(fingerprints(state),before);
 command('init','--mcp-only','--only','cursor');
 const config=JSON.parse(fs.readFileSync(path.join(root,'.cursor/mcp.json'),'utf8')).mcpServers.kith;
 if(process.platform==='win32')assert.equal(config.command,process.execPath,'Native Windows config must not rely on spawning kith.cmd directly');
 assert.equal(JSON.parse(command('uninstall')).ok,true);assert.equal(fs.existsSync(path.join(root,'.cursor/mcp.json')),false);
 assert.equal(fs.readFileSync(path.join(root,'src/recovered.mjs'),'utf8'),'export const recovered = true;\n');
 report.checks.push('offline inspection preserves original state; tracked MCP setup/uninstall preserves integrated work');
 report.phase='complete';report.passed=true;
} catch(error) {
 report.error=String(error.message).split('\n')[0].replace(/[A-Za-z0-9_-]{43}/g,'[redacted]');process.exitCode=1;
} finally {
 await Promise.allSettled(clients.map(client=>client.close()));
 const output=process.argv[2];if(output){fs.mkdirSync(path.dirname(output),{recursive:true});fs.writeFileSync(output,JSON.stringify(report,null,2)+'\n');}
 console.log(JSON.stringify(report,null,2));fs.rmSync(root,{recursive:true,force:true,maxRetries:10,retryDelay:100});
}
