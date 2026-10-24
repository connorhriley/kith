const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const os=require('node:os');
const Module=require('node:module');
const {execFileSync}=require('node:child_process');
const base=path.resolve(__dirname,'..');
function repository(root){
 fs.mkdirSync(root,{recursive:true});
 const git=(...args)=>execFileSync('git',args,{cwd:root,stdio:'ignore'});
 git('init','-q');fs.writeFileSync(path.join(root,'.gitignore'),'.coord/\n');fs.writeFileSync(path.join(root,'work.mjs'),'export const base = true;\n');
 git('add','.');git('-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','-qm','fixture');return root;
}
async function fixture(options={}){
 const temp=fs.mkdtempSync(path.join(os.tmpdir(),'kith-editor-'));
 const root=repository(path.join(temp,'repo')),home=path.join(temp,'home');fs.mkdirSync(home);
 const oldHome=process.env.HOME;process.env.HOME=home;
 const events={registered:[],unregistered:[],output:'',commands:new Map()};
 class Disposable{constructor(fn=()=>{}){this.fn=fn;}dispose(){this.fn();}}
 class Emitter{event=()=>new Disposable();dispose(){}}
 const config={get:(key,fallback)=>key==='mcp.enabled'?true:fallback,inspect:()=>({globalValue:options.badNode?path.join(temp,'missing-node'):process.execPath})};
 const vscode={Disposable,EventEmitter:Emitter,StatusBarAlignment:{Left:1},
  window:{createOutputChannel:()=>({replace:t=>events.output=t,show(){},dispose(){}}),createStatusBarItem:()=>({show(){},dispose(){}})},
  workspace:{isTrusted:options.trusted!==false,workspaceFolders:[{uri:{scheme:'file',fsPath:root}}],getConfiguration:()=>config,
   onDidChangeWorkspaceFolders:()=>new Disposable(),onDidGrantWorkspaceTrust:()=>new Disposable(),onDidChangeConfiguration:()=>new Disposable()},
  commands:{registerCommand:(name,fn)=>{events.commands.set(name,fn);return new Disposable();}},
  lm:{registerMcpServerDefinitionProvider:(id,provider)=>{events.registered.push({id,provider});return new Disposable(()=>events.unregistered.push(id));},mcpServerDefinitions:[]},
  McpStdioServerDefinition:class{constructor(label,command,args,env,version){Object.assign(this,{label,command,args,env,version});}},
 };
 if(options.cursor)vscode.cursor={mcp:{registerServer:c=>events.registered.push(c),unregisterServer:n=>events.unregistered.push(n)}};
 const ctx={extensionPath:base,asAbsolutePath:p=>path.join(base,p),subscriptions:[],extension:{packageJSON:{version:require('../package.json').version}}};
 if(options.manual){const dir=path.join(root,options.cursor?'.cursor':'.vscode');fs.mkdirSync(dir);fs.writeFileSync(path.join(dir,'mcp.json'),'{ // preserve comment\n "servers":{"kith":{"command":"custom"},"peer":{"env":{"TOKEN":"fixture-private"}}},\n}');}
 if(options.workspaceConfig){const file=path.join(temp,'existing.code-workspace');fs.writeFileSync(file,'{"mcp":{"servers":{"Kith":null}},"folders":[]}');vscode.workspace.workspaceFile={scheme:'file',fsPath:file};}
 if(options.malformed){const dir=path.join(root,'.vscode');fs.mkdirSync(dir);fs.writeFileSync(path.join(dir,'mcp.json'),'{"servers":{"kith":{"env":{"TOKEN":"fixture-private"}}}');}
 if(options.overlap){const peer=path.join(root,'.coord/worktrees/peer');execFileSync('git',['worktree','add','-qb','peer',peer],{cwd:root});fs.writeFileSync(path.join(root,'work.mjs'),'export const left = true;\n');fs.writeFileSync(path.join(peer,'work.mjs'),'export const right = true;\n');events.peer=peer;}
 const load=Module._load;
 Module._load=function(request,...args){return request==='vscode'?vscode:load.call(this,request,...args);};
 delete require.cache[require.resolve('../dist/extension.cjs')];
 let api;
 try{api=require('../dist/extension.cjs').activate(ctx);}finally{Module._load=load;}
 try{await api.ready;}catch(error){await close();throw error;}
 async function close(){for(const item of ctx.subscriptions.reverse())item.dispose();if(oldHome===undefined)delete process.env.HOME;else process.env.HOME=oldHome;fs.rmSync(temp,{recursive:true,force:true});}
 return{root,home,events,api,close};
}
test('VS Code registration uses the bundled server and observations create no project database',async()=>{
 const f=await fixture();try{
  assert.equal(f.events.registered.length,1);const r=f.events.registered[0];assert.equal(r.id,'kith.editor');
  const [d]=await r.provider.provideMcpServerDefinitions();assert.equal(d.command,fs.realpathSync(process.execPath));assert.deepEqual(d.args,[path.join(base,'server/launch.cjs'),'mcp']);
  assert.equal(f.api.getSnapshot().complete,true);assert.equal(fs.existsSync(path.join(f.root,'.coord/state.db')),false);
  assert.match(f.events.output,/Watching only — no active Kith tasks/);assert.doesNotMatch(f.events.output,/Zero Conflicts/);
 }finally{await f.close();}
});
test('Cursor uses its native API, never writes MCP files, and removes only its own registration',async()=>{
 const f=await fixture({cursor:true});try{
  assert.equal(f.events.registered[0].name,'kith-editor');assert.equal(fs.existsSync(path.join(f.root,'.cursor/mcp.json')),false);
  assert.equal(fs.existsSync(path.join(f.home,'.cursor/mcp.json')),false);
 }finally{await f.close();}
 assert.deepEqual(f.events.unregistered,['kith-editor']);
});
test('preserves commented/custom existing MCP configuration and avoids a duplicate server',async()=>{
 const f=await fixture({manual:true});try{
  assert.equal(f.events.registered.length,0);assert.match(f.api.getRegistration(),/Existing Kith configuration preserved/);
  const text=fs.readFileSync(path.join(f.root,'.vscode/mcp.json'),'utf8');assert.match(text,/preserve comment/);assert.match(text,/fixture-private/);assert.doesNotMatch(f.events.output,/fixture-private/);
 }finally{await f.close();}
 assert.deepEqual(f.events.unregistered,[]);
});
test('untrusted workspaces run no server or observation and missing Node never becomes a clean verdict',async()=>{
 for(const options of [{trusted:false},{badNode:true}]){const f=await fixture(options);try{assert.equal(f.events.registered.length,0);assert.equal(f.api.getSnapshot().complete,false);assert.equal(fs.existsSync(path.join(f.root,'.coord')),false);}finally{await f.close();}}
});
test('preserves workspace-file MCP entries and refuses registration over malformed configuration',async()=>{
 for(const options of [{workspaceConfig:true},{malformed:true}]){const f=await fixture(options);try{
  assert.equal(f.events.registered.length,0);
  assert.match(f.api.getRegistration(),options.malformed?/cannot be read/:/Existing Kith configuration preserved/);
  assert.doesNotMatch(f.events.output,/fixture-private/);
 }finally{await f.close();}}
});
test('reports real differing worktree copies and clears resolved observations',async()=>{
 const f=await fixture({overlap:true});try{
  assert.equal(f.api.getSnapshot().overlaps,1);assert.match(f.events.output,/Status unavailable or partial/);assert.match(f.events.output,/do not establish a merge conflict/);
  assert.match(f.api.getSnapshot().details,/Ownership unavailable/);
  for(const root of [f.root,f.events.peer])fs.writeFileSync(path.join(root,'work.mjs'),'export const base = true;\n');
  await f.api.refresh();assert.equal(f.api.getSnapshot().overlaps,0);
 }finally{await f.close();}
});
