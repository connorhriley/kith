import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { KithEngine } from '../src/index.js';

describe('Pillar 3 & 4: Import-Graph Blast Radius, Zero-Touch Contracts & FTS5 Deduplicator', () => {
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

  it('catches semantic duplicate helper functions across different files via FTS5 + AST fingerprints', () => {
    engine.fencing.registerAgent({ id: 'agent-a' });
    engine.fencing.registerAgent({ id: 'agent-b' });

    // Agent A creates formatCurrency in src/lib/currency.ts
    const codeA = `// Formats cents into display currency string\nexport function formatCurrency(cents: number, currencyCode: string): string {\n  return \`\${currencyCode} \${(cents / 100).toFixed(2)}\`;\n}\n`;
    fs.writeFileSync(path.join(tmpDir, 'src/lib/currency.ts'), codeA, 'utf8');
    engine.processPostFileEdit({
      agentId: 'agent-a',
      filePath: 'src/lib/currency.ts',
      content: codeA,
    });

    // Agent B writes a duplicate utility `formatMoney(amount: number, currency: string): string` in src/helpers/money.ts
    const codeB = `export function formatMoney(amount: number, currency: string): string {\n  return \`$\${amount}\`;\n}\n`;
    fs.writeFileSync(path.join(tmpDir, 'src/helpers/money.ts'), codeB, 'utf8');
    const postB = engine.processPostFileEdit({
      agentId: 'agent-b',
      filePath: 'src/helpers/money.ts',
      content: codeB,
    });

    expect(postB.duplicates.length).toBeGreaterThan(0);
    expect(postB.duplicates[0].existingContract.symbol_name).toBe('formatCurrency');
    expect(postB.duplicates[0].existingContract.file_path).toBe('src/lib/currency.ts');
    expect(postB.warnings.some((w) => w.includes('DUPLICATE SYMBOL WARNING'))).toBe(true);
  });
});
