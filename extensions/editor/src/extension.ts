import * as vscode from 'vscode';
import path from 'node:path';
import os from 'node:os';
import {resolveNode, runJson, existingKith} from './runtime';

type CursorMcp = {registerServer(config:{name:string;server:{command:string;args:string[];env:Record<string,string>}}):void;unregisterServer(name:string):void};
export function activate(context:vscode.ExtensionContext) {
  const output=vscode.window.createOutputChannel('Kith');
  const bar=vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left,20);
  bar.command='kith.showStatus';bar.text='$(organization) Kith';bar.show();
  const stopped=new AbortController(),changed=new vscode.EventEmitter<void>();
  const launcher=context.asAbsolutePath('server/launch.cjs');
  let runtime:Promise<string>|undefined,registration:vscode.Disposable|undefined;
  let registered='Not offered yet',busy=false,generation=0,timer:ReturnType<typeof setInterval>|undefined;
  let detailsMode=false;
  let snapshot={tasks:0,attention:0,details:'',complete:false,overlaps:0,roots:0,text:'Waiting for a trusted local workspace.'};
  const folders=()=>(vscode.workspace.workspaceFolders??[]).filter(f=>f.uri.scheme==='file');
  const node=()=>runtime??=resolveNode(vscode.workspace.getConfiguration('kith').inspect<string>('nodePath')?.globalValue??'',context.extensionPath);
  const cursorApi=()=>(vscode as typeof vscode&{cursor?:{mcp?:CursorMcp}}).cursor?.mcp;
  const configurationFiles=()=>cursorApi()
    ? [...folders().map(f=>path.join(f.uri.fsPath,'.cursor/mcp.json')),path.join(os.homedir(),'.cursor/mcp.json')]
    : [...folders().map(f=>path.join(f.uri.fsPath,'.vscode/mcp.json')), ...(vscode.workspace.workspaceFile?.scheme==='file'?[vscode.workspace.workspaceFile.fsPath]:[]), ...(context.globalStorageUri?.fsPath ? [path.resolve(context.globalStorageUri.fsPath,'../../mcp.json')] : [])];
  async function connectMcp() {
    const current=++generation;
    registration?.dispose();registration=undefined;
    if(!vscode.workspace.isTrusted||!folders().length){registered='Open a trusted local workspace to offer MCP.';return;}
    if(!vscode.workspace.getConfiguration('kith').get<boolean>('mcp.enabled',true)){registered='MCP disabled in Kith settings.';return;}
    try {
      const existing=existingKith(configurationFiles());
      if(existing){registered=`Existing Kith configuration preserved: ${existing}`;return;}
      const executable=await node();
      if(stopped.signal.aborted||current!==generation)return;
      const cursor=cursorApi();
      if(cursor?.registerServer){
        cursor.registerServer({name:'kith-editor',server:{command:executable,args:[launcher,'mcp'],env:{}}});
        registration=new vscode.Disposable(()=>cursor.unregisterServer('kith-editor'));
        registered='Bundled Kith offered through Cursor MCP. Cursor manages server approval and start status.';
      }else if(vscode.lm?.registerMcpServerDefinitionProvider){
        registration=vscode.lm.registerMcpServerDefinitionProvider('kith.editor',{
          onDidChangeMcpServerDefinitions:changed.event,
          provideMcpServerDefinitions:()=>[new vscode.McpStdioServerDefinition('Kith',executable,[launcher,'mcp'],{},context.extension.packageJSON.version)],
        });
        registered='Bundled Kith offered through VS Code MCP. VS Code manages server approval and start status.';
      }else registered='Update this editor to use native MCP registration. No configuration was changed.';
    }catch(error){registered=error instanceof Error?error.message:String(error);}
  }
  async function refresh() {
    if(busy||stopped.signal.aborted)return snapshot;
    busy=true;
    try {
      const roots=folders();
      if(!vscode.workspace.isTrusted||!roots.length){
        snapshot={tasks:0,attention:0,details:'',complete:false,overlaps:0,roots:0,text:'Open a trusted local workspace. Kith has not run a repository process.'};
      }else{
        const executable=await node();let complete=true;
        const lines=[`Kith — read-only observations (${new Date().toLocaleString()})`,registered,'',
          'Overlaps are different or unverified dirty copies, not proven merge conflicts. File writers cannot be identified from these observations.',''];
        const inspected=new Set<string>(),overlaps=new Set<string>(),sessions=new Set<string>(),taskIds=new Set<string>();
        const working:string[]=[],waiting:string[]=[],attention:string[]=[],resources:string[]=[],saved=new Set<string>();
        for(const folder of roots){
          const result=await runJson(executable,launcher,['watch',folder.uri.fsPath,'--once','--raw'],stopped.signal);
          const coordination=result.coordination;
          if(!coordination?.available)complete=false;
          for(const key of coordination?.sessionKeys??[])sessions.add(key);
          for(const task of coordination?.working??[]){
            const key=JSON.stringify([task.checkout,task.taskId]);if(taskIds.has(key))continue;taskIds.add(key);
            working.push(`${task.agentId}: ${task.title}`,`  ${task.checkout}`,`  Claimed: ${task.scopes.length?task.scopes.join(', '):'no current file claims'}`);
          }
          for(const row of coordination?.waiting??[])waiting.push(`${row.agentId} → ${row.resource}; held by ${row.holder??'not recorded'} (queue ${row.position})`);
          for(const row of coordination?.attention??[])attention.push(`${row.message}. ${row.nextStep}`);
          for(const row of coordination?.using??[])resources.push(`${row.agentId}: ${row.resource} — ${row.detail}`);
          lines.push(folder.uri.fsPath);
          if(!result.complete){complete=false;lines.push('  Scan unavailable; no clean verdict.');}
          const alerts=(result.collisions??[]).filter((a:{id:string})=>!overlaps.has(a.id));
          for(const a of alerts)overlaps.add(a.id);
          lines.push(`  ${alerts.length} differing or unverified shared dirty paths across ${(result.repos??[]).length} checkouts.`);
          for(const a of alerts.slice(0,100))lines.push(`  • ${a.filePath}\n    ${a.repos.join('\n    ')}`);
          if(alerts.length>100)lines.push(`  … ${alerts.length-100} more paths omitted.`);
          for(const error of result.errors??[])lines.push(`  Unavailable: ${error.message}`);
          if(result.ownershipComplete!==true)complete=false;
          for(const row of result.worktrees??[]){
            if(inspected.has(row.path))continue;inspected.add(row.path);
            if(row.activity==='retained')saved.add(row.path);
            const activity=({active:'Active Kith lease',retained:'Retained',unregistered:'No Kith session',unknown:'Ownership unavailable'} as Record<string,string>)[row.activity]??'Ownership unavailable';
            lines.push(`  ${row.label} — ${activity}; ${row.dirtyFiles??'unknown'} Git changes; ${row.sharedDirtyPaths} shared dirty paths`,
              `    ${row.path}${row.agentIds?.length?` (${row.agentIds.join(', ')})`:''}`,`    ${row.detail}`);
          }
          lines.push('');
        }
        const summary=[`Kith — ${new Date().toLocaleString()}`,registered,''];
        if(!complete)summary.push('Status unavailable or partial. Inspect details before acting.');
        if(attention.length)summary.push('Needs attention',...new Set(attention),'');
        summary.push(taskIds.size?`Coordinating ${taskIds.size} task(s)`:sessions.size?`${sessions.size} session(s) recorded; no task started`:'Watching only — no active Kith tasks');
        if(!taskIds.size)summary.push('Ask your agent: Use Kith for this task; claim its files, work in an isolated worktree and verify before integrating.');
        summary.push(...working,'');
        if(waiting.length)summary.push('Waiting',...new Set(waiting),'');
        if(resources.length)summary.push('Shared resources',...new Set(resources),'');
        if(overlaps.size)summary.push(`Review before integration: ${overlaps.size} shared files. Different copies do not establish a merge conflict.`,'');
        if(saved.size)summary.push(`Saved work: ${saved.size} checkout(s). Preserved for inspection; no cleanup performed.`);
        summary.push('Details: Kith: Show Coordination Details. Writes outside Kith are not attributed.');
        snapshot={tasks:taskIds.size,attention:attention.length,details:lines.join('\n'),complete,overlaps:overlaps.size,roots:roots.length,text:summary.join('\n')};
      }
      bar.text=!snapshot.complete?'$(question) Kith':snapshot.attention?'$(warning) Kith':snapshot.tasks?`Kith: ${snapshot.tasks} task(s)`:'Kith: watching';
      bar.tooltip=`${snapshot.complete?'Recorded coordination':'Status unavailable'} — click to see tasks, waits and next steps.`;
      output.replace((detailsMode?snapshot.details:snapshot.text)+'\n');
    }catch(error){
      snapshot={...snapshot,complete:false,text:`Kith observation unavailable.\n${registered}\n${error instanceof Error?error.message:String(error)}`};
      bar.text='$(question) Kith';output.replace((detailsMode?snapshot.details:snapshot.text)+'\n');
    }finally{busy=false;}
    return snapshot;
  }
  function schedule(){
    if(timer)clearInterval(timer);
    const seconds=vscode.workspace.getConfiguration('kith').get<number>('statusIntervalSeconds',15);
    timer=setInterval(()=>{void refresh();},Math.max(5,Math.min(300,seconds))*1000);
  }
  context.subscriptions.push(output,bar,changed,
    vscode.commands.registerCommand('kith.showStatus',async()=>{detailsMode=false;await refresh();output.show(true);return snapshot;}),
    vscode.commands.registerCommand('kith.refresh',refresh),
    vscode.commands.registerCommand('kith.showDetails',async()=>{detailsMode=true;await refresh();output.show(true);return snapshot;}),
    vscode.workspace.onDidChangeWorkspaceFolders(()=>{void connectMcp().then(refresh);}),
    vscode.workspace.onDidGrantWorkspaceTrust(()=>{void connectMcp().then(refresh);}),
    vscode.workspace.onDidChangeConfiguration(event=>{
      if(event.affectsConfiguration('kith.nodePath')||event.affectsConfiguration('kith.mcp.enabled')){runtime=undefined;void connectMcp().then(refresh);}
      if(event.affectsConfiguration('kith.statusIntervalSeconds'))schedule();
    }),
    new vscode.Disposable(()=>{stopped.abort();if(timer)clearInterval(timer);registration?.dispose();}),
  );
  const ready=connectMcp().then(refresh);schedule();
  return {ready,refresh,getSnapshot:()=>snapshot,getRegistration:()=>registered};
}
