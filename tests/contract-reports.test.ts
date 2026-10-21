import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { KithEngine } from '../src/index.js';

describe('Advisory contract reports', () => {
  let tmpDir: string;
  let engine: KithEngine;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kith-ast-test-'));
    fs.mkdirSync(path.join(tmpDir, 'src/lib'), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, 'src/services'), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, 'src/routes'), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, 'src/helpers'), { recursive: true });

    // Create a 2-hop dependency chain:
    // src/routes/checkout.ts -> src/services/order.ts -> src/lib/auth.ts
    fs.writeFileSync(
      path.join(tmpDir, 'src/lib/auth.ts'),
      `// Verifies a signed JWT token\nexport function verifyToken(token: string): boolean {\n  return token.length > 0;\n}\n`,
      'utf8'
    );
    fs.writeFileSync(
      path.join(tmpDir, 'src/services/order.ts'),
      `import { verifyToken } from '../lib/auth.js';\nexport function createOrder(token: string, itemId: string): string {\n  if (!verifyToken(token)) throw new Error('Unauthorized');\n  return itemId;\n}\n`,
      'utf8'
    );
    fs.writeFileSync(
      path.join(tmpDir, 'src/routes/checkout.ts'),
      `import { createOrder } from '../services/order.js';\nexport async function POST(reqToken: string): Promise<string> {\n  return createOrder(reqToken, 'item-1');\n}\n`,
      'utf8'
    );

    engine = new KithEngine(tmpDir);
    engine.depGraph.indexRepositoryFiles(tmpDir);
  });

  afterEach(() => {
    engine.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('detects transitive 2-hop breaking changes and alerts downstream locked agents', () => {
    engine.fencing.registerAgent({ id: 'agent-auth' });
    engine.fencing.registerAgent({ id: 'agent-checkout' });

    // agent-checkout locks src/routes/checkout.ts (2 hops downstream of src/lib/auth.ts)
    engine.locks.acquireLocks({
      agentId: 'agent-checkout',
      patterns: ['src/routes/checkout.ts'],
    });

    // agent-auth modifies verifyToken signature in src/lib/auth.ts (breaking change!)
    const updatedAuthCode = `export function verifyToken(token: string, requiredRole: string): Promise<boolean> {\n  return Promise.resolve(token.length > 0 && requiredRole.length > 0);\n}\n`;
    fs.writeFileSync(path.join(tmpDir, 'src/lib/auth.ts'), updatedAuthCode, 'utf8');

    const postRes = engine.processPostFileEdit({
      agentId: 'agent-auth',
      filePath: 'src/lib/auth.ts',
      content: updatedAuthCode,
    });

    expect(postRes.contractReport.breakingChanges.length).toBeGreaterThanOrEqual(2);
    const hop2Alert = postRes.contractReport.breakingChanges.find(
      (b) => b.affectedDownstreamFile === 'src/routes/checkout.ts'
    );
    expect(hop2Alert).toBeDefined();
    expect(hop2Alert?.hopDistance).toBe(2);
    expect(hop2Alert?.affectedAgentId).toBe('agent-checkout');
    expect(postRes.warnings.some((w) => w.includes('BLAST RADIUS ALERT'))).toBe(true);

    // Verify agent-checkout automatically receives the breaking change in its unread delta footer
    const delta = engine.consumeAgentDelta('agent-checkout');
    expect(delta.formattedFooter).toContain('contract_breaking_change');
    expect(delta.activeConflicts.some((c) => c.severity === 'transitive_contract_break')).toBe(
      true
    );
  });

  it('warns about an exact name in another file without blocking ownership or retaining stale matches', () => {
    engine.fencing.registerAgent({ id: 'worker' });
    const begun = engine.beginWork({ agentId: 'worker', title: 'Add helper', scopeGlobs: ['src/helpers/**'] });
    expect(begun.ok).toBe(true);
    const content = 'export function verifyToken(value: number): number { return value; }\n';
    const report = engine.processPostFileEdit({ agentId: 'worker', filePath: 'src/helpers/token.ts', content });
    expect(report.warnings.filter(w => w.includes('[EXISTING SYMBOL]'))).toEqual([
      "[EXISTING SYMBOL] 'verifyToken' (function) is also recorded in 'src/lib/auth.ts'. Consider reuse if it serves the same purpose.",
    ]);
    expect(report.contractReport.upsertedContracts[0].symbol_name).toBe('verifyToken');
    expect(engine.intents.getTask(begun.task!.id)?.status).toBe('active');
    expect(engine.locks.listLocks()[0].owner_agent_id).toBe('worker');
    engine.fencing.registerAgent({ id: 'peer' });
    engine.processPostFileEdit({ agentId: 'peer', filePath: 'src/lib/auth.ts', content: 'export function authenticate(): boolean { return true; }' });
    const retried = engine.processPostFileEdit({ agentId: 'worker', filePath: 'src/helpers/token.ts', content });
    expect(retried.warnings.filter(w => w.includes('[EXISTING SYMBOL]'))).toEqual([]);
  });

  it('ignores self matches, case variants, synonyms and different symbol kinds', () => {
    engine.fencing.registerAgent({ id: 'worker' });
    for (const [filePath, content] of [
      ['src/lib/auth.ts', fs.readFileSync(path.join(tmpDir, 'src/lib/auth.ts'), 'utf8')],
      ['src/helpers/token.ts', 'export function VerifyToken(token: string): boolean { return true; }'],
      ['src/helpers/token.ts', 'export function validateToken(token: string): boolean { return true; }'],
      ['src/helpers/token.ts', 'export const verifyToken = true;'],
      ['src/helpers/token.ts', ''],
    ]) {
      const report = engine.processPostFileEdit({ agentId: 'worker', filePath, content });
      expect(report.warnings.filter(w => w.includes('[EXISTING SYMBOL]'))).toEqual([]);
    }
  });

});


it('reports only actual contract changes while retaining unchanged signatures', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kith-contract-delta-'));
  const engine = new KithEngine(root);
  try {
    engine.fencing.registerAgent({ id: 'editor' });
    const file = 'helpers.ts';
    const source = 'export function keep(value: string): string { return value; }\n'
      + 'export function change(value: string): string { return value; }\n';
    const first = engine.processPostFileEdit({ agentId: 'editor', filePath: file, content: source });
    expect(first.contractReport.upsertedContracts).toHaveLength(2);
    const changed = engine.processPostFileEdit({ agentId: 'editor', filePath: file,
      content: source.replace('change(value: string)', 'change(value: number)') });
    expect(changed.contractReport.upsertedContracts.map(c => c.symbol_name)).toEqual(['change']);
    expect(engine.depGraph.listContracts()).toHaveLength(2);
    const removed = engine.processPostFileEdit({ agentId: 'editor', filePath: file,
      content: 'export function keep(value: string): string { return value.trim(); }\n' });
    expect(removed.contractReport.upsertedContracts).toEqual([]);
    expect(removed.contractReport.removedSymbols).toEqual(['change']);
    expect(engine.depGraph.listContracts().map(c => c.symbol_name)).toEqual(['keep']);
  } finally { engine.close(); fs.rmSync(root, { recursive: true, force: true }); }
});
