// Keep license notices with the self-contained runtime retained by setup.
import fs from 'node:fs';
import path from 'node:path';
import {createRequire} from 'node:module';
const seen=new Set(), notices=[];
function visit(root) {
  const pkg=JSON.parse(fs.readFileSync(path.join(root,'package.json'),'utf8'));
  const key=pkg.name+'@'+pkg.version;
  if(seen.has(key))return;seen.add(key);
  if(pkg.name!=='kith-coord') {
    const files=fs.readdirSync(root).filter(n=>/^(licen[cs]e|copying|notice)(\.|$)/i.test(n)&&fs.statSync(path.join(root,n)).isFile());
    notices.push(`## ${key}\n${pkg.license??''}\n${files.map(n=>fs.readFileSync(path.join(root,n),'utf8')).join('\n')}`);
  }
  const require=createRequire(path.join(root,'package.json'));
  for(const name of Object.keys(pkg.dependencies??{})) {
    let entry;try{entry=require.resolve(name+'/package.json');}catch{entry=require.resolve(name);}
    let dir=path.dirname(entry);
    while(!fs.existsSync(path.join(dir,'package.json'))) {
      const parent=path.dirname(dir);if(parent===dir)throw Error('Cannot locate dependency notices: '+name);dir=parent;
    }
    visit(fs.realpathSync(dir));
  }
}
visit(process.cwd());
fs.writeFileSync('dist/THIRD_PARTY_NOTICES.txt',notices.join('\n\n'));
