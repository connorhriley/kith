const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {execFileSync}=require('node:child_process');
const {createRequire}=require('node:module');
const rootRequire=createRequire(path.resolve(__dirname,'../../../package.json'));
const {Client}=rootRequire('@modelcontextprotocol/sdk/client/index.js');
const {StdioClientTransport}=rootRequire('@modelcontextprotocol/sdk/client/stdio.js');
test('sealed server payload finishes two project tasks and refuses capability reuse without runtime dependencies',async()=>{
 const temp=fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(),'kith-editor-bundle-')));
 const server=path.join(temp,'server');fs.cpSync(path.resolve(__dirname,'../server'),server,{recursive:true});
 const roots=['one','two'].map(name=>{const r=path.join(temp,name);fs.mkdirSync(r);const git=(...a)=>execFileSync('git',a,{cwd:r,stdio:'ignore'});git('init','-q');git('config','user.name','Fixture');git('config','user.email','fixture@example.invalid');fs.writeFileSync(path.join(r,'.gitignore'),'.coord/\n');git('add','.');git('commit','-qm','base');return r;});
 const c=new Client({name:'editor-bundle-workflow',version:'1'});
 try{
  // Editors inherit the host environment. The SDK's reduced default omits
  // Windows system variables needed by the kernel process-identity probe.
  // The shipped launcher still removes inherited Kith capabilities/Git routing.
  await c.connect(new StdioClientTransport({command:process.execPath,args:[path.join(server,'launch.cjs'),'mcp'],cwd:path.parse(temp).root,env:process.env,stderr:'ignore'}));
  const tools=(await c.listTools()).tools;
  assert.equal(tools.length,14);assert.ok(tools.some(t=>t.name==='kith_run_dev_server'));
  assert.equal((await c.callTool({name:'kith_get_status',arguments:{}})).isError,true);
  const call=async(name,args)=>{const r=await c.callTool({name,arguments:args});const diagnostic=r.isError?String(r.content?.[0]?.text??'').replace(/[A-Za-z0-9_-]{43}/g,'[redacted]').slice(0,1500):'';assert.equal(r.isError,false,`Unexpected ${name} refusal: ${diagnostic}`);return r.structuredContent;};
  const tokens=[];
  for(const [index,repository] of roots.entries()){
   const begun=await call('kith_begin_work',{repository,agentId:'same-id',title:'Real editor task',scopeGlobs:['change.mjs'],isolateWorktree:true});tokens.push(begun.sessionToken);
   fs.writeFileSync(path.join(begun.worktree.worktreePath,'change.mjs'),`export const project = ${index};\n`);
   await call('kith_record_file_edit',{repository,agentId:'same-id',filePath:'change.mjs'});
   const command={repository,agentId:'same-id',mutexName:'check',command:[process.execPath,'--check','change.mjs']};
   if(process.platform==='win32')assert.equal((await c.callTool({name:'kith_run_with_mutex',arguments:command})).isError,true,'Native Windows must retain its unsupported-supervision refusal');
   else await call('kith_run_with_mutex',command);
  }
  assert(tokens[0]!==tokens[1],'Repository capability grants must differ');
  assert.equal((await c.callTool({name:'kith_heartbeat',arguments:{repository:roots[0],agentId:'same-id',sessionToken:tokens[1]}})).isError,true);
  for(const [index,repository] of roots.entries()){
   await call('kith_complete_work',{repository,agentId:'same-id',verificationCmd:`"${process.execPath}" --check change.mjs`});
   assert.match(fs.readFileSync(path.join(repository,'change.mjs'),'utf8'),new RegExp(`project = ${index}`));
  }
 }finally{await c.close();fs.rmSync(temp,{recursive:true,force:true});}
});
