import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {afterEach, beforeEach, expect, it} from 'vitest';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {KithEngine} from '../src/core/engine.js';
import type {BlastRadiusAlert, ContractRecord} from '../src/core/dep-graph.js';
import type {LinkedWorkspaceContract} from '../src/core/workspace-contracts.js';
import {compactBreakingChanges, compactDeltaFooter, compactFileEditResult, compactLinkedContracts, compactPublishedContracts} from '../src/mcp/compact.js';

let root: string, engine: KithEngine;
const clients: Client[] = [];
const cli = path.resolve('dist/cli/index.js');
const env = Object.fromEntries(Object.entries(process.env).filter(([key, value]) => value !== undefined && !key.startsWith('KITH_')));
const git = (...args: string[]) => execFileSync('git', args, {cwd: root, stdio: 'ignore'});
beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kith-context-')));
  git('init', '-q'); git('config', 'user.name', 'Fixture'); git('config', 'user.email', 'fixture@example.invalid');
  fs.writeFileSync(path.join(root, '.gitignore'), '.coord/\n'); git('add', '.'); git('commit', '-qm', 'Initial');
  engine = new KithEngine(root);
});
afterEach(async () => { await Promise.allSettled(clients.splice(0).map(c => c.close())); engine.close(); fs.rmSync(root, {recursive: true, force: true}); });
async function connect() {
  const c = new Client({name: 'context-regression', version: '1'}); clients.push(c);
  await c.connect(new StdioClientTransport({command: process.execPath, args: [cli, 'mcp', '--repo', root], cwd: root, env, stderr: 'ignore'}));
  return c;
}
async function call(c: Client, name: string, args: Record<string, unknown> = {}) {
  const r = await c.callTool({name, arguments: args});
  expect(r.isError).toBe(false);
  const data = r.structuredContent as any;
  expect(JSON.parse((r.content[0] as {text: string}).text)).toEqual(data);
  return data;
}
function record(name: string, breaking = false): ContractRecord {
  return {id: name, file_path: `src/${name}.ts`, symbol_name: name, kind: 'interface', signature: `interface ${name} {id:string}`, version: 1, is_breaking: breaking, updated_at: 1, owner_agent_id: null, ast_hash: 'fingerprint', params_fingerprint: 'metadata', doc_comment: ''};
}

it('renews on useful calls, delivers sibling changes once, and keeps expired/replayed receipts historical', async () => {
  const worker = await connect(), peer = await connect();
  const begun = await call(worker, 'kith_begin_work', {agentId: 'worker', title: 'Work', scopeGlobs: ['work.ts']});
  expect(begun.session).toEqual({agentId: 'worker', leaseExpiresAt: begun.agent.lease_expires_at});
  await call(peer, 'kith_begin_work', {agentId: 'peer', title: 'Peer', scopeGlobs: ['peer.ts']});
  await call(peer, 'kith_record_file_edit', {agentId: 'peer', filePath: 'peer.ts', content: 'export const peer = 1;'});
  engine.coordDb.db.prepare("UPDATE agents SET lease_expires_at=? WHERE id='worker'").run(Date.now() + 10000);
  const args = {agentId: 'worker', filePath: 'work.ts', content: 'export const work = 1;', operationKey: 'owned-edit'};
  const edited = await worker.callTool({name: 'kith_record_file_edit', arguments: args});
  expect(edited.isError).toBe(false);
  const receipt = edited.structuredContent!.session as {agentId: string; leaseExpiresAt: number};
  expect(receipt.leaseExpiresAt).toBeGreaterThan(Date.now() + 200000);
  expect(receipt.leaseExpiresAt).toBe(engine.fencing.getAgent('worker')!.lease_expires_at);
  expect(JSON.stringify(edited.content.slice(1))).toContain('[contracts_updated]');
  const next = await worker.callTool({name: 'kith_record_file_edit', arguments: {...args, operationKey: 'next-edit'}});
  expect(next.isError).toBe(false); expect(JSON.stringify(next.content.slice(1))).not.toContain('[contracts_updated]');
  const denied = await peer.callTool({name: 'kith_record_file_edit', arguments: args});
  expect(denied.isError).toBe(true); expect(denied.structuredContent!.session).toBeUndefined();
  const expired = Date.now() - 1;
  engine.coordDb.db.prepare("UPDATE agents SET lease_expires_at=? WHERE id='worker'").run(expired);
  const replay = await call(worker, 'kith_record_file_edit', args);
  expect(replay.operation.replayed).toBe(true); expect(replay.session).toEqual(receipt);
  expect(engine.fencing.getAgent('worker')!.lease_expires_at).toBe(expired);
  const refused = await worker.callTool({name: 'kith_heartbeat', arguments: {agentId: 'worker'}});
  expect(refused.isError).toBe(true); expect(refused.structuredContent!.session).toBeUndefined();
});

it('finishes an isolated task in three Kith calls with automatic publication and one integration check', async () => {
  fs.writeFileSync(path.join(root, 'verify.cjs'), "require('node:fs').appendFileSync(process.argv[2], 'checked\\n');\n");
  git('add', 'verify.cjs'); git('commit', '-qm', 'Project verification');
  const c = await connect();
  const begin = await call(c, 'kith_begin_work', {agentId: 'lean', title: 'Implement feature', scopeGlobs: ['feature.js'], isolateWorktree: true});
  expect(begin.ok).toBe(true);
  const checkout = begin.worktree.worktreePath;
  fs.writeFileSync(path.join(checkout, 'feature.js'), 'export function feature() {return 1;}\n');
  const report = await call(c, 'kith_record_file_edit', {agentId: 'lean', filePath: 'feature.js'});
  expect(report.contractReport.upsertedContracts.some((entry: any) => entry.symbol_name === 'feature')).toBe(true);
  expect(engine.depGraph.listContracts().some(entry => entry.symbol_name === 'feature')).toBe(true);
  for (const args of [['add', 'feature.js'], ['commit', '-qm', 'Implement feature']]) execFileSync('git', args, {cwd: checkout, stdio: 'ignore'});
  const counter = path.join(root, '.coord', 'verification-count');
  const quoted = "'" + counter.replace(/'/g, "'\\''") + "'";
  const complete = await call(c, 'kith_complete_work', {agentId: 'lean', verificationCmd: `node verify.cjs ${quoted}`});
  expect(complete.ok).toBe(true); expect(complete.session).toBeUndefined();
  expect(fs.readFileSync(counter, 'utf8')).toBe('checked\n');
  expect(fs.readFileSync(path.join(root, 'feature.js'), 'utf8')).toContain('return 1');
  expect(engine.intents.listTasks()[0].status).toBe('done');
});

it('keeps a real imported contract outside the worker write scope in its actual MCP grant', async () => {
  fs.mkdirSync(path.join(root, 'src/shared'), {recursive: true}); fs.mkdirSync(path.join(root, 'src/ui'));
  fs.writeFileSync(path.join(root, 'src/shared/api.ts'), 'export interface SharedApi {id: string}\n');
  fs.writeFileSync(path.join(root, 'src/ui/page.ts'), "import {SharedApi} from '../shared/api';\nexport function render(api: SharedApi): string {return api.id}\n");
  engine.depGraph.indexRepositoryFiles();
  expect(engine.depGraph.getTransitiveDependents('src/shared/api.ts').some(d => d.filePath === 'src/ui/page.ts')).toBe(true);
  const c = await connect();
  const grant = await call(c, 'kith_begin_work', {agentId: 'ui', title: 'Render UI', scopeGlobs: ['src/ui/**']});
  expect(grant.publishedContracts.some((c: any) => c.symbol_name === 'SharedApi')).toBe(true);
  expect(grant.publishedContractsComplete).toBe(true);
  expect(grant.locks.every((l: any) => l.pattern.startsWith('src/ui'))).toBe(true);
  expect(fs.readFileSync(path.join(root, 'src/shared/api.ts'), 'utf8')).toBe('export interface SharedApi {id: string}\n');
});

it('preserves every breaking contract beyond the preview size and advertises omitted ordinary context', async () => {
  const breaking = Array.from({length: 40}, (_, n) => record(`Breaking${n}`, true));
  const report = compactPublishedContracts([...breaking, record('ordinary')]);
  expect(report.publishedContracts.map(c => c.symbol_name)).toEqual(breaking.map(c => c.symbol_name));
  expect(report.publishedContractsComplete).toBe(false); expect(report.publishedContractsOmitted).toBe(1);
  expect(report.contractDetails).toContain('includeContracts: true');
  engine.fencing.registerAgent({id: 'publisher'});
  for (const c of [...breaking, record('ordinary')]) {
    engine.depGraph.publishExplicitContract({agentId: 'publisher', filePath: c.file_path, symbolName: c.symbol_name, kind: c.kind, signature: c.signature});
  }
  engine.coordDb.db.prepare("UPDATE contracts SET is_breaking=1 WHERE symbol_name LIKE 'Breaking%'").run();
  engine.intents.addTask({title: 'Queued', scopeGlobs: ['src/ui/**']});
  const c = await connect(), grant = await call(c, 'kith_claim_next_task', {agentId: 'worker'});
  expect(grant.publishedContracts.filter((c: any) => c.is_breaking)).toHaveLength(40);
  expect(grant.publishedContractsOmitted).toBe(1);
  const full = await call(c, 'kith_get_status', {includeContracts: true});
  expect(full.contracts).toHaveLength(41); expect(full.contracts.some((c: any) => c.symbol_name === 'ordinary')).toBe(true);
  expect(full.contractsIncluded).toBe(true);
});

it('preserves linked module exports and all existing incompleteness/ownership flags', () => {
  const link: LinkedWorkspaceContract = {alias: '@shared', sourceRepo: root, sourceRepoName: 'provider', filePath: 'api.ts', absolutePath: path.join(root, 'api.ts'), symbols: Array.from({length: 12}, (_, n) => ({symbolName: `Item${n}`, kind: 'interface', signature: `interface Item${n}`, astHash: 'hash'})), exportsComplete: true, ownershipAvailable: true, dirtyInCheckout: false, lockedByAgent: null, activeWorktreeDrifts: []};
  const report = compactLinkedContracts([link])![0];
  expect(report.symbols).toHaveLength(12); expect(report.exportsComplete).toBe(true);
  expect((report.symbols as any[]).map(s => s.symbolName)).toEqual(link.symbols.map(s => s.symbolName));
  const unknown = compactLinkedContracts([{...link, exportsComplete: false, ownershipAvailable: false, dirtyInCheckout: null}])![0];
  expect(unknown.exportsComplete).toBe(false); expect(unknown.ownershipAvailable).toBe(false); expect(unknown.dirtyInCheckout).toBeNull(); expect(unknown.totalSymbolsInFile).toBeNull();
});

it('preserves each downstream owner/distance and reconstructs a grouped footer without losing its other metadata', () => {
  const common = {modifiedFile: 'src/api.ts', symbolName: 'Api', previousSignature: 'interface Api {id:string}', newSignature: 'interface Api {id:number}'};
  const alerts: BlastRadiusAlert[] = [
    {...common, affectedDownstreamFile: 'src/a.ts', affectedAgentId: 'alice', hopDistance: 1},
    {...common, affectedDownstreamFile: 'src/b.ts', affectedAgentId: 'bob', hopDistance: 2},
    {...common, affectedDownstreamFile: 'src/c.ts', affectedAgentId: 'alice', hopDistance: 3},
  ];
  const different = alerts.map((a, i) => i === 2 ? {...a, affectedAgentId: 'bob', hopDistance: 1} : a);
  expect(compactBreakingChanges(alerts)).not.toEqual(compactBreakingChanges(different));
  const payload = {filePath: 'src/api.ts', fencingToken: 42, breakingChanges: alerts};
  const footer = `• [contract_breaking_change] by peer: ${JSON.stringify(payload)}`;
  const compacted = compactDeltaFooter(footer), decoded = JSON.parse(compacted.slice(compacted.indexOf('{')));
  const reconstructed = decoded.breakingChanges.flatMap(({affected, ...common}: any) => affected.map((consumer: any) => ({...common, ...consumer})));
  expect(reconstructed).toEqual(alerts); expect(decoded.fencingToken).toBe(42);
  const separateSignatures = compactBreakingChanges([...alerts, {...alerts[0], newSignature: null}]);
  expect(separateSignatures).toHaveLength(2);
  const edit = compactFileEditResult({filePath: 'src/api.ts', contractReport: {filePath: 'src/api.ts', upsertedContracts: Array.from({length: 35}, (_, n) => record(`Changed${n}`)), removedSymbols: ['Removed'], breakingChanges: alerts, transitiveDependents: [{filePath: 'src/c.ts', hopDistance: 3}]}, dirtyMergeConflicts: [], warnings: ['Keep recovery guidance']});
  expect((edit.contractReport as any).breakingChanges).toEqual(alerts);
  expect((edit.contractReport as any).upsertedContracts).toHaveLength(35);
  expect((edit.contractReport as any).transitiveDependents).toEqual([{filePath: 'src/c.ts', hopDistance: 3}]);
  expect(edit.warnings).toEqual(['Keep recovery guidance']);
});

it('retrieves completed history through the advertised MCP option and retains live lock lease records', async () => {
  const c = await connect();
  const past = await call(c, 'kith_begin_work', {agentId: 'past', title: 'Completed', scopeGlobs: ['past.js'], isolateWorktree: true});
  const checkout = past.worktree.worktreePath;
  fs.writeFileSync(path.join(checkout, 'past.js'), 'export const done = true;\n');
  for (const args of [['add', 'past.js'], ['commit', '-qm', 'Complete task']]) execFileSync('git', args, {cwd: checkout, stdio: 'ignore'});
  const failed = await c.callTool({name: 'kith_complete_work', arguments: {agentId: 'past', verificationCmd: 'node -e "process.exit(17)"'}});
  expect(failed.isError).toBe(true); expect(failed.structuredContent?.ok).toBe(false);
  const needsRepair = await call(c, 'kith_get_status');
  expect(needsRepair.mergeQueue.some((entry: any) => entry.status === 'failed' && entry.diagnostics_output)).toBe(true);
  expect((await call(c, 'kith_complete_work', {agentId: 'past', verificationCmd: 'node --check past.js'})).ok).toBe(true);
  const current = await call(c, 'kith_begin_work', {agentId: 'current', title: 'Current', scopeGlobs: ['src/current.ts']});
  const normal = await call(c, 'kith_get_status');
  expect(normal.tasks).toHaveLength(1); expect(normal.completedTaskCount).toBe(1); expect(normal.historyIncluded).toBe(false);
  expect(normal.locks[0]).toEqual(current.locks[0]); expect(normal.locks[0].expires_at).toBeGreaterThan(Date.now());
  expect(normal.completedIntegrationCount).toBe(1);
  expect(normal.mergeQueue.some((entry: any) => entry.status === 'merged')).toBe(false);
  expect(normal.mergeQueue.filter((entry: any) => entry.status === 'failed')).toEqual(needsRepair.mergeQueue);
  const full = await call(c, 'kith_get_status', {includeHistory: true});
  expect(full.tasks).toHaveLength(2); expect(full.historyIncluded).toBe(true);
  expect(full.tasks.some((t: any) => t.title === 'Completed' && t.status === 'done')).toBe(true);
  expect(full.mergeQueue.some((entry: any) => entry.status === 'merged' && entry.diagnostics_output)).toBe(true);
  const tools = (await c.listTools()).tools;
  expect((tools.find(t => t.name === 'kith_get_status')!.inputSchema.properties as any).includeHistory).toBeDefined();
});

it('keeps the established breaking-alert fields over MCP and preserves consumer ownership in its grouped footer', async () => {
  fs.mkdirSync(path.join(root, 'src/shared'), {recursive: true}); fs.mkdirSync(path.join(root, 'src/ui'));
  fs.writeFileSync(path.join(root, 'src/shared/api.ts'), 'export function lookup(id: string): string {return id}\n');
  fs.writeFileSync(path.join(root, 'src/ui/page.ts'), "import {lookup} from '../shared/api';\nexport function render(id: string): string {return lookup(id)}\n");
  git('add', '.'); git('commit', '-qm', 'Shared API'); engine.depGraph.indexRepositoryFiles();
  const provider = await connect(), consumer = await connect();
  await call(provider, 'kith_begin_work', {agentId: 'provider', title: 'Change API', scopeGlobs: ['src/shared/**']});
  await call(consumer, 'kith_begin_work', {agentId: 'consumer', title: 'Consume API', scopeGlobs: ['src/ui/**']});
  fs.writeFileSync(path.join(root, 'src/shared/api.ts'), 'export function lookup(id: number): string {return String(id)}\n');
  const edited = await call(provider, 'kith_record_file_edit', {agentId: 'provider', filePath: 'src/shared/api.ts'});
  expect(edited.contractReport.breakingChanges).toEqual(expect.arrayContaining([expect.objectContaining({
    modifiedFile: 'src/shared/api.ts', symbolName: 'lookup', affectedDownstreamFile: 'src/ui/page.ts', affectedAgentId: 'consumer', hopDistance: 1,
  })]));
  expect(edited.warnings.some((w: string) => w.includes('BLAST RADIUS ALERT'))).toBe(true);
  const heartbeat = await consumer.callTool({name: 'kith_heartbeat', arguments: {agentId: 'consumer'}});
  expect(heartbeat.isError).toBe(false);
  const footer = (heartbeat.content as any[]).filter(c => c.type === 'text').map(c => c.text).join('\n');
  const event = footer.split('\n').find((line: string) => line.includes('[contract_breaking_change]'));
  expect(event).toBeDefined();
  const payload = JSON.parse(event!.slice(event!.indexOf('{')));
  expect(payload.breakingChanges[0].affected).toEqual(expect.arrayContaining([expect.objectContaining({affectedDownstreamFile: 'src/ui/page.ts', affectedAgentId: 'consumer', hopDistance: 1})]));
});
