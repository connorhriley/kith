import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { KITH_PROTOCOL_VERSION } from '../dist/index.js';
const root=fileURLToPath(new URL('..',import.meta.url)), fixture=fs.mkdtempSync(path.join(os.tmpdir(),'kith-protocol-'));
const client=new Client({name:'kith-protocol-export',version:'1.0.0'});
const env=Object.fromEntries(Object.entries(process.env).filter(([k,v])=>v!==undefined&&!k.startsWith('KITH_')));
try {
 await client.connect(new StdioClientTransport({command:process.execPath,args:[path.join(root,'dist/cli/index.js'),'mcp','--repo',fixture],env,stderr:'ignore'}));
 const {tools}=await client.listTools();
 const schema={protocolVersion:KITH_PROTOCOL_VERSION,tools:tools.map(({name,description,inputSchema})=>({name,description,inputSchema}))};
 const output=JSON.stringify(schema,null,2)+'\n', target=path.join(root,'docs/protocol/tools.v1.json');
 if(process.argv.includes('--check')) assert.equal(fs.readFileSync(target,'utf8'),output,'MCP schemas changed. Review compatibility and regenerate with pnpm protocol:export.');
 else fs.writeFileSync(target,output);
 console.log(`${tools.length} MCP tool schemas ${process.argv.includes('--check')?'checked':'exported'} for protocol ${KITH_PROTOCOL_VERSION}.`);
} finally {await client.close();fs.rmSync(fixture,{recursive:true,force:true});}
