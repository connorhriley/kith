import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import { KithEngine } from '../src/core/engine.js';
import {
  compactContract,
  compactContractsForScope,
  compactDeltaFooter,
  compactFileEditResult,
  compactLinkedContracts,
  compactStatusResult,
} from '../src/mcp/compact.js';

const tempDirs: string[] = [];

function createGitRepo(prefix: string): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  tempDirs.push(dir);
  execFileSync('git', ['init', '-b', 'main'], { cwd: dir, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.email', 'test@kith.local'], { cwd: dir, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.name', 'Kith Test'], { cwd: dir, stdio: 'ignore' });
  fs.writeFileSync(path.join(dir, '.gitignore'), '.coord/\nnode_modules/\n', 'utf8');
  execFileSync('git', ['add', '.gitignore'], { cwd: dir, stdio: 'ignore' });
  execFileSync('git', ['commit', '-m', 'init'], { cwd: dir, stdio: 'ignore' });
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup race
    }
  }
});

describe('MCP Context Compactor (Token Reduction without Signal Loss)', () => {
  it('filters unrelated contracts out of scoped work and strips internal fingerprint noise', () => {
    const repo = createGitRepo('kith-compact-scope-');
    fs.mkdirSync(path.join(repo, 'src/core'), { recursive: true });
    fs.mkdirSync(path.join(repo, 'src/menubar'), { recursive: true });

    const coreLines = Array.from({ length: 15 }, (_, idx) =>
      `export interface CoreContract${idx} { id: string; count: number; flag${idx}: boolean }`
    ).join('\n');
    fs.writeFileSync(path.join(repo, 'src/core/types.ts'), `${coreLines}\n`, 'utf8');
    fs.writeFileSync(
      path.join(repo, 'src/menubar/view.ts'),
      'export function renderMenu(title: string): string { return title; }\n',
      'utf8'
    );

    const engine = new KithEngine(repo);
    try {
      engine.depGraph.indexRepositoryFiles(repo);
      const allContracts = engine.depGraph.listContracts();
      expect(allContracts.length).toBe(16);

      const rawJson = JSON.stringify(allContracts);
      const scoped = compactContractsForScope(allContracts, ['src/menubar/**'], []);
      const compactJson = JSON.stringify(scoped);

      expect(scoped.totalPublishedContracts).toBe(16);
      expect(scoped.publishedContracts).toHaveLength(1);
      expect(scoped.publishedContracts[0].symbol_name).toBe('renderMenu');
      expect('params_fingerprint' in scoped.publishedContracts[0]).toBe(false);
      expect('ast_hash' in scoped.publishedContracts[0]).toBe(false);
      expect(compactJson.length).toBeLessThan(rawJson.length * 0.15);
    } finally {
      engine.close();
    }
  });

  it('omits completed task history and completed agents from status polls by default while preserving active/queued tasks', () => {
    const repo = createGitRepo('kith-compact-status-');
    const engine = new KithEngine(repo);
    try {
      for (let i = 0; i < 12; i++) {
        const id = `worker-done-${i}`;
        engine.fencing.registerAgent({ id });
        const res = engine.beginWork({
          agentId: id,
          title: `Historical task ${i}`,
          scopeGlobs: [`src/mod${i}.ts`],
        });
        expect(res.ok).toBe(true);
        engine.completeWork({ agentId: id });
      }
      engine.intents.addTask({
        title: 'Active queued task',
        scopeGlobs: ['src/next.ts'],
      });

      const rawStatus = engine.getStatus();
      expect(rawStatus.tasks.length).toBe(13);

      const compact = compactStatusResult(rawStatus);
      expect((compact.tasks as unknown[]).length).toBe(1);
      expect(compact.completedTaskCount).toBe(12);
      expect(compact.historyIncluded).toBe(false);
      expect(JSON.stringify(compact).length).toBeLessThan(JSON.stringify(rawStatus).length * 0.4);

      const withHistory = compactStatusResult(rawStatus, { includeHistory: true });
      expect((withHistory.tasks as unknown[]).length).toBe(13);
    } finally {
      engine.close();
    }
  });

  it('compacts clean file edit receipts, linked contracts, and live breaking-change delta footers', () => {
    const repo = createGitRepo('kith-compact-edit-');
    fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
    const file = path.join(repo, 'src/api.ts');
    fs.writeFileSync(
      file,
      [
        'export function alpha(a: string): string { return a; }',
        'export function beta(b: number): number { return b; }',
        'export interface Gamma { x: number; y: number }',
      ].join('\n') + '\n',
      'utf8'
    );

    const engine = new KithEngine(repo);
    try {
      engine.fencing.registerAgent({ id: 'editor' });
      engine.beginWork({ agentId: 'editor', title: 'Edit API', scopeGlobs: ['src/**'] });
      const rawEdit = engine.processPostFileEdit({ agentId: 'editor', filePath: 'src/api.ts' });
      const compactEdit = compactFileEditResult(rawEdit);

      const report = compactEdit.contractReport as {
        upsertedCount: number;
        upsertedContracts: Array<Record<string, unknown>>;
      };
      expect(report.upsertedCount).toBe(3);
      expect(report.upsertedContracts).toHaveLength(3);
      expect('params_fingerprint' in report.upsertedContracts[0]).toBe(false);
      expect('ast_hash' in report.upsertedContracts[0]).toBe(false);
      expect(JSON.stringify(compactEdit).length).toBeLessThan(JSON.stringify(rawEdit).length * 0.65);

      const linked = compactLinkedContracts([
        {
          alias: '@shared/api',
          sourceRepo: '/tmp/shared',
          sourceRepoName: 'shared',
          filePath: 'src/index.ts',
          absolutePath: '/tmp/shared/src/index.ts',
          symbols: Array.from({ length: 12 }, (_, i) => ({
            symbolName: `fn${i}`,
            kind: 'function',
            signature: `function fn${i}(): void`,
            astHash: `hash_${i}`,
          })),
          dirtyInCheckout: false,
          exportsComplete: true,
          ownershipAvailable: true,
          lockedByAgent: null,
          activeWorktreeDrifts: [],
        },
      ]);
      expect(linked).toHaveLength(1);
      expect(linked![0].totalSymbolsInFile).toBe(12);
      expect((linked![0].symbols as unknown[]).length).toBe(8);
      expect('astHash' in (linked![0].symbols as Array<Record<string, unknown>>)[0]).toBe(false);
      expect(compactContract(rawEdit.contractReport.upsertedContracts[0]).symbol_name).toBe('alpha');

      // Test live delta footer deduplication when 10 downstream files import the same changed contract
      const repeatedAlerts = Array.from({ length: 10 }, (_, i) => ({
        modifiedFile: 'src/core/types.ts',
        symbolName: 'SharedConfig',
        previousSignature: 'interface SharedConfig { oldField: string; count: number; enabled: boolean }',
        newSignature: 'interface SharedConfig { newField: string; count: number; enabled: boolean; strict: boolean }',
        affectedDownstreamFile: `src/consumer${i}.ts`,
        hopDistance: 1,
        affectedAgentId: null,
      }));
      const rawFooter = `--- KITH LIVE SIBLING DELTA ---\n• [contract_breaking_change] by peer: ${JSON.stringify({
        filePath: 'src/core/types.ts',
        breakingChanges: repeatedAlerts,
      })}`;
      const compactedFooter = compactDeltaFooter(rawFooter);
      expect(compactedFooter.length).toBeLessThan(rawFooter.length * 0.35);
      expect(compactedFooter).toContain('affectedDownstreamFiles');
      expect(compactedFooter).toContain('src/consumer9.ts');
    } finally {
      engine.close();
    }
  });
});
