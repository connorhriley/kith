const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vscode=require('vscode');
exports.run=async()=>{
 console.log('KITH_HOST_CONTEXT',JSON.stringify({editor:vscode.env.appName,version:vscode.version,folders:(vscode.workspace.workspaceFolders??[]).map(f=>f.name)}));
 const extension=vscode.extensions.getExtension('kith-coord.kith');assert(extension,'Packaged extension is present in the actual editor host');
 const api=await extension.activate();await api.ready;
 assert.equal(api.getSnapshot().complete,true);assert.equal(api.getSnapshot().roots,1);
 assert.equal(fs.existsSync(path.join(vscode.workspace.workspaceFolders[0].uri.fsPath,'.coord/state.db')),false,'Read-only UI must not initialize a database');
 const registration=api.getRegistration();
 assert.match(registration,/offered through (VS Code|Cursor) MCP/);
 const snapshot=await vscode.commands.executeCommand('kith.refresh');assert.equal(snapshot.complete,true);
 for(const name of ['.coord','.vscode','.cursor'])assert.equal(fs.existsSync(path.join(vscode.workspace.workspaceFolders[0].uri.fsPath,name)),false,`Observation must not create ${name}`);
 const record={passed:true,editor:vscode.env.appName,version:vscode.version,registration,extension:extension.id,readonlyWorkspace:true,configFilesCreated:false,checkedAt:new Date().toISOString()};
 fs.writeFileSync(process.env.KITH_EDITOR_TEST_REPORT,JSON.stringify(record,null,2)+'\n');
};
