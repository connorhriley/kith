import {build} from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const extension=fileURLToPath(new URL('..',import.meta.url)),root=path.resolve(extension,'../..');
fs.rmSync(path.join(extension,'dist'),{recursive:true,force:true});
fs.rmSync(path.join(extension,'server'),{recursive:true,force:true});
const ui=await build({metafile:true,entryPoints:[path.join(extension,'src/extension.ts')],outfile:path.join(extension,'dist/extension.cjs'),bundle:true,platform:'node',format:'cjs',mainFields:['module','main'],target:'node20',external:['vscode'],sourcemap:true});
const result=await build({entryPoints:{'cli/index':path.join(root,'src/cli/index.ts'),'command-worker':path.join(root,'src/core/command-worker.ts')},outdir:path.join(extension,'server'),bundle:true,platform:'node',format:'esm',target:'node22',metafile:true,banner:{js:"import {createRequire as __kithCreateRequire} from 'node:module'; const require = __kithCreateRequire(import.meta.url);"}});
fs.writeFileSync(path.join(extension,'server/package.json'),'{"type":"module"}\n');
fs.writeFileSync(path.join(extension,'server/launch.cjs'),`// Do not inherit another agent's capability or Git routing environment.\nfor(const key of Object.keys(process.env)) if(key.startsWith('KITH_') || ['CLAUDE_PROJECT_DIR','GIT_DIR','GIT_WORK_TREE','GIT_COMMON_DIR','GIT_INDEX_FILE'].includes(key)) delete process.env[key];\nimport('./cli/index.js');\n`);
const packages=new Map();
for(const input of [...Object.keys(result.metafile.inputs),...Object.keys(ui.metafile.inputs)]) {
 if(!input.includes('node_modules'))continue;
 let dir=path.dirname(path.resolve(input));
 while(dir!==path.dirname(dir)) {
  const manifest=path.join(dir,'package.json');
  if(fs.existsSync(manifest)) {
   const pkg=JSON.parse(fs.readFileSync(manifest,'utf8'));
   if(pkg.name&&pkg.version&&!packages.has(pkg.name+'@'+pkg.version)) {
    const license=fs.readdirSync(dir).find(n=>/^licen[cs]e(?:\.|$)/i.test(n));
    packages.set(pkg.name+'@'+pkg.version,`## ${pkg.name}@${pkg.version}\n${pkg.license??''}\n\n${license?fs.readFileSync(path.join(dir,license),'utf8'):'See package repository for license terms.'}`);
   }
   if(pkg.name && pkg.version) break;
  }
  dir=path.dirname(dir);
 }
}
fs.writeFileSync(path.join(extension,'THIRD_PARTY_NOTICES.md'),'# Bundled dependencies\n\n'+[...packages.values()].join('\n\n'));
console.log('Bundled the existing Kith CLI and supervised worker; no runtime npm install required.');
