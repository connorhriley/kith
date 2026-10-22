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
  let snapshot={complete:false,overlaps:0,roots:0,text:'Waiting for a trusted local workspace.'};
  const folders=()=>(vscode.workspace.workspaceFolders??[]).filter(f=>f.uri.scheme==='file');
  const node=()=>runtime??=resolveNode(vscode.workspace.getConfiguration('kith').inspect<string>('nodePath')?.globalValue??'',context.extensionPath);
  const cursorApi=()=>(vscode as typeof vscode&{cursor?:{mcp?:CursorMcp}}).cursor?.mcp;
  const configurationFiles=()=>cursorApi()
    ? [...folders().map(f=>path.join(f.uri.fsPath,'.cursor/mcp.json')),path.join(os.homedir(),'.cursor/mcp.json')]
    : [...folders().map(f=>path.join(f.uri.fsPath,'.vscode/mcp.json')), ...(context.globalStorageUri?.fsPath ? [path.resolve(context.globalStorageUri.fsPath,'../../mcp.json')] : [])];
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
        snapshot={complete:false,overlaps:0,roots:0,text:'Open a trusted local workspace. Kith has not run a repository process.'};
      }else{
        const executable=await node();let complete=true;
        const lines=[`Kith — read-only observations (${new Date().toLocaleString()})`,registered,'',
          'Overlaps are different or unverified dirty copies, not proven merge conflicts. File writers cannot be identified from these observations.',''];
        const inspected=new Set<string>(),overlaps=new Set<string>();
        for(const folder of roots){
          const result=await runJson(executable,launcher,['watch',folder.uri.fsPath,'--once','--raw'],stopped.signal);
          lines.push(folder.uri.fsPath);
          if(!result.complete){complete=false;lines.push('  Scan unavailable; no clean verdict.');}
          const alerts=(result.collisions??[]).filter((a:{id:string})=>!overlaps.has(a.id));
          for(const a of alerts)overlaps.add(a.id);
          lines.push(`  ${alerts.length} differing or unverified shared dirty paths across ${(result.repos??[]).length} checkouts.`);
          for(const a of alerts.slice(0,100))lines.push(`  • ${a.filePath}\n    ${a.repos.join('\n    ')}`);
          if(alerts.length>100)lines.push(`  … ${alerts.length-100} more paths omitted.`);
          for(const error of result.errors??[])lines.push(`  Unavailable: ${error.message}`);
          for(const repo of result.repos??[]){
            if(inspected.has(repo))continue;inspected.add(repo);
            const state=await runJson(executable,launcher,['status','--offline','--repo',repo],stopped.signal);
            if(state.state==='unavailable')complete=false;
            lines.push(`  ${repo}: ${state.state==='missing'?'No Kith state yet':state.state??'observed'}; ${(state.agents??[]).filter((a:{status:string})=>a.status==='active').length} recorded active sessions`);
            if(state.error)lines.push(`    ${state.error}`);
          }
          lines.push('');
        }
        snapshot={complete,overlaps:overlaps.size,roots:roots.length,text:lines.join('\n')};
      }
      bar.text=!snapshot.complete?'$(question) Kith':snapshot.overlaps?`$(warning) Kith: ${snapshot.overlaps} overlaps`:'$(organization) Kith';
      bar.tooltip=`${snapshot.complete?'Read-only observations available':'Observation unavailable'} — click for details. No compatibility verdict.`;
      output.replace(snapshot.text+'\n');
    }catch(error){
      snapshot={...snapshot,complete:false,text:`Kith observation unavailable.\n${registered}\n${error instanceof Error?error.message:String(error)}`};
      bar.text='$(question) Kith';output.replace(snapshot.text+'\n');
    }finally{busy=false;}
    return snapshot;
  }
  function schedule(){
    if(timer)clearInterval(timer);
    const seconds=vscode.workspace.getConfiguration('kith').get<number>('statusIntervalSeconds',15);
    timer=setInterval(()=>{void refresh();},Math.max(5,Math.min(300,seconds))*1000);
  }
  context.subscriptions.push(output,bar,changed,
    vscode.commands.registerCommand('kith.showStatus',async()=>{await refresh();output.show(true);return snapshot;}),
    vscode.commands.registerCommand('kith.refresh',refresh),
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
