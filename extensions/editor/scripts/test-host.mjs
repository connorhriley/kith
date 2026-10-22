import {runTests} from '@vscode/test-electron';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const extension=fileURLToPath(new URL('..',import.meta.url));
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'kith-editor-host-'));
try{
 const workspace=path.join(temp,'fixture'),profile=path.join(temp,'profile'),home=path.join(temp,'home');
 for(const p of [workspace,path.join(profile,'User'),home])fs.mkdirSync(p,{recursive:true});
 execFileSync('git',['init','-q'],{cwd:workspace});
 fs.writeFileSync(path.join(profile,'User/settings.json'),JSON.stringify({'kith.nodePath':process.execPath,'telemetry.telemetryLevel':'off','extensions.autoCheckUpdates':false,'extensions.autoUpdate':false}));
 const report=path.resolve(process.env.KITH_EDITOR_HOST_REPORT??path.join(extension,'../../artifacts/editor-host.json'));fs.mkdirSync(path.dirname(report),{recursive:true});
 fs.rmSync(report,{force:true});
 // Only this empty test profile uses Electron's mock Keychain. Never sign in
 // here or apply this flag to a user's editor or the shipped extension.
 const isCursor=/^cursor(?:\.exe)?$/i.test(path.basename(process.env.KITH_EDITOR_EXECUTABLE??''));
 await runTests({version:process.env.KITH_EDITOR_VERSION??'1.143.0',...(process.env.KITH_EDITOR_EXECUTABLE?{vscodeExecutablePath:process.env.KITH_EDITOR_EXECUTABLE}:{}),extensionDevelopmentPath:extension,extensionTestsPath:path.join(extension,'test/host.cjs'),extensionTestsEnv:{HOME:home,KITH_EDITOR_TEST_REPORT:report},launchArgs:[workspace,'--user-data-dir',profile,'--extensions-dir',path.join(temp,'extensions'),'--skip-welcome','--skip-release-notes','--disable-workspace-trust',...(isCursor?['--classic']:[]),...(process.platform==='darwin'?['--use-mock-keychain']:[])]});
 console.log(fs.readFileSync(report,'utf8'));
}finally{fs.rmSync(temp,{recursive:true,force:true});}
