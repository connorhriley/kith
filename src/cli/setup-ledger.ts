import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { discoverRepository, isWithin, physicalPath } from '../core/repository.js';
type Plan = Map<string,{content:string;mode?:number}>;
interface Entry { before:string|null; after:string; beforeMode:number|null; afterMode:number; drifted?:boolean }
interface Ledger { version:1; root:string; files:Record<string,Entry> }
function location(root:string,name:string) {
  if(path.isAbsolute(name)||name.startsWith('.coord'+path.sep)&&!/^\.coord[\/]bin[\/](npm|pnpm|yarn)$/.test(name))throw new Error('Invalid setup ledger path');
  const target=path.resolve(root,name);
  if(!isWithin(root,target)||target===root||physicalPath(target)!==target)throw new Error(`Setup path is redirected or outside repository: ${name}`);
  return target;
}
function ledgerFile(root:string,coordDir:string) {
  const dir=path.join(coordDir,'setup');
  if(physicalPath(coordDir)!==coordDir||physicalPath(dir)!==dir)throw new Error('Setup state is redirected');
  const file = path.join(dir,crypto.createHash('sha256').update(root).digest('hex')+'.json');
  if (physicalPath(file) !== file) throw new Error('Setup ledger is redirected');
  return file;
}
function read(root:string,coordDir:string):Ledger {
  const file=ledgerFile(root,coordDir);
  if(!fs.existsSync(file))return {version:1,root,files:{}};
  const value=JSON.parse(fs.readFileSync(file,'utf8')) as Ledger;
  if(value.version!==1||value.root!==root||!value.files||typeof value.files!=='object'||Array.isArray(value.files))throw new Error('Unsupported setup ledger; preserve it before manual repair');
  for(const [name,entry] of Object.entries(value.files)) {
    location(root,name);
    if(!entry||typeof entry.after!=='string'||entry.before!==null&&typeof entry.before!=='string'||![entry.after,entry.before].every(v=>v===null||Buffer.from(v,'base64').toString('base64')===v)||![entry.afterMode,entry.beforeMode].every(v=>v===null||Number.isInteger(v)&&v>=0&&v<=0o777)||(entry.before===null)!==(entry.beforeMode===null))throw new Error('Damaged setup ledger; preserve it before manual repair');
  }
  return value;
}
function persist(root:string,coordDir:string,ledger:Ledger) {
  const file=ledgerFile(root,coordDir),temp=file+'.'+crypto.randomBytes(6).toString('hex')+'.tmp';
  fs.mkdirSync(path.dirname(file),{recursive:true,mode:0o700});
  const fd=fs.openSync(temp,'wx',0o600);
  try {fs.writeFileSync(fd,JSON.stringify(ledger,null,2)+'\n');fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
  fs.renameSync(temp,file);
  // Node cannot open directory handles for fsync on Windows; the backup file itself is flushed above.
  for (const parent of process.platform === 'win32' ? [] : [path.dirname(file), coordDir]) {
    const dir=fs.openSync(parent,'r');try{fs.fsyncSync(dir);}finally{fs.closeSync(dir);}
  }
}
function lock(coordDir:string) {
  const file=path.join(coordDir,'setup.lock'),fd=fs.openSync(file,'wx',0o600);
  fs.writeFileSync(fd,JSON.stringify({pid:process.pid}));
  return ()=>{fs.closeSync(fd);fs.unlinkSync(file);};
}
/** Backups are private, persisted before client writes, and never interpreted as commands. */
export function applySetupPlan(root:string,coordDir:string,plan:Plan,warnings:string[]) {
  const release=lock(coordDir);
  try {
    const ledger=read(root,coordDir);
    const observed = new Map<string, { bytes: string|null; mode: number|null }>();
    for(const [name,planned] of plan) {
      const relative=path.relative(root,path.isAbsolute(name)?name:path.join(root,name));
      const target=location(root,relative),exists=fs.existsSync(target),current=exists?fs.readFileSync(target).toString('base64'):null;
      const mode=exists?fs.statSync(target).mode&0o777:null,previous=ledger.files[relative];
      observed.set(relative, {bytes:current, mode});
      if(previous&&(previous.drifted||previous.after!==current||previous.afterMode!==mode)) {
        previous.drifted=true;warnings.push(`User changes in ${relative} will be preserved by uninstall; review that file manually.`);
      } else ledger.files[relative]={before:previous?previous.before:current,after:Buffer.from(planned.content).toString('base64'),beforeMode:previous?previous.beforeMode:mode,
        afterMode:mode??(process.platform === 'win32' ? 0o666 : ((planned.mode??0o666)&~process.umask()))};
    }
    persist(root,coordDir,ledger);
    for(const [name,planned] of plan) {
      const relative=path.relative(root,path.isAbsolute(name)?name:path.join(root,name)),target=location(root,relative);
      const snapshot = observed.get(relative)!;
      const current = fs.existsSync(target) ? fs.readFileSync(target).toString('base64') : null;
      const mode = fs.existsSync(target) ? fs.statSync(target).mode & 0o777 : null;
      if (current !== snapshot.bytes || mode !== snapshot.mode) throw new Error(`Configuration changed during setup: ${relative}; preserve the setup ledger before retrying`);
      fs.mkdirSync(path.dirname(target),{recursive:true});fs.writeFileSync(target,planned.content,{encoding:'utf8',mode:planned.mode});
    }
  }finally{release();}
}

/** Restore only exact recorded Kith writes. Leave database, recovery copies, ignored-state rule and edited files intact. */
export function uninstallKith(directory=process.cwd(),dryRun=false) {
  const layout=discoverRepository(directory),root=layout.checkoutRoot;
  if(physicalPath(layout.coordDir)!==layout.coordDir)throw new Error('Coordination directory is redirected');
  const report={ok:true,dryRun,restored:[] as string[],removed:[] as string[],needsReview:[] as string[],retained:[layout.coordDir,'.gitignore']};
  if(!fs.existsSync(layout.coordDir))return report;
  const release=dryRun?()=>{}:lock(layout.coordDir);
  try {
    const ledger=read(root,layout.coordDir);
    for(const [name,entry] of Object.entries(ledger.files)) {
      if(name==='.gitignore')continue;
      const target=location(root,name),current=fs.existsSync(target)?fs.readFileSync(target).toString('base64'):null;
      if(current===entry.before){if(!dryRun)delete ledger.files[name];continue;}
      if(entry.drifted||current!==entry.after||!fs.existsSync(target)||(fs.statSync(target).mode&0o777)!==entry.afterMode){report.needsReview.push(name);continue;}
      if(entry.before===null){report.removed.push(name);if(!dryRun)fs.unlinkSync(target);}
      else {report.restored.push(name);if(!dryRun){fs.writeFileSync(target,Buffer.from(entry.before,'base64'));fs.chmodSync(target,entry.beforeMode!);}}
      if(!dryRun)delete ledger.files[name];
    }
    report.ok=report.needsReview.length===0;
    if(!dryRun)persist(root,layout.coordDir,ledger);
    return report;
  }finally{release();}
}
