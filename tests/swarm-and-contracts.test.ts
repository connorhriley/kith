import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  buildSwarmPrompts,
  inspectWorkspaceContracts,
  KithEngine,
} from '../src/core/engine.js';

let tempDir: string;
const engines: KithEngine[] = [];

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function createRepo(name: string): string {
  const root = path.join(tempDir, name);
  fs.mkdirSync(root, { recursive: true });
  git(root, 'init', '-q');
  git(root, 'config', 'user.name', 'Test User');
  git(root, 'config', 'user.email', 'test@example.invalid');
  fs.writeFileSync(path.join(root, '.gitignore'), '.coord/\nnode_modules/\n');
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.writeFileSync(path.join(root, 'src/index.mjs'), 'export const ready = true;\n');
  git(root, 'add', '.');
  git(root, 'commit', '-qm', 'initial');
  return root;
}

function openEngine(root: string): KithEngine {
  const engine = new KithEngine(root);
  engines.push(engine);
  return engine;
}

beforeEach(() => {
  tempDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kith-swarm-contracts-')));
});

afterEach(() => {
  while (engines.length > 0) {
    engines.pop()?.close();
  }
  fs.rmSync(tempDir, { recursive: true, force: true });
});

describe('Cross-agent DAG task queue & worktree handoff', () => {
  it('queues a multi-step DAG and lets parallel workers claim tasks with isolated worktrees and shared contracts', async () => {
    const root = createRepo('app');
    const engine = openEngine(root);

    engine.fencing.registerAgent({ id: 'architect', client: 'claude-code' });
    engine.depGraph.publishExplicitContract({
      agentId: 'architect',
      filePath: 'src/schema/user.mjs',
      symbolName: 'validateUser',
      kind: 'function',
      signature: 'function validateUser(input: unknown): boolean',
    });

    const schemaTask = engine.intents.addTask({
      id: 'task-schema',
      title: 'Create user schema',
      scopeGlobs: ['src/schema/**'],
      priority: 100,
    });
    const apiTask = engine.intents.addTask({
      id: 'task-api',
      title: 'Build user API handler',
      scopeGlobs: ['src/api/**'],
      dependsOn: [schemaTask.id],
      priority: 80,
    });
    const uiTask = engine.intents.addTask({
      id: 'task-ui',
      title: 'Build user profile view',
      scopeGlobs: ['src/ui/**'],
      dependsOn: [schemaTask.id],
      priority: 70,
    });

    engine.fencing.registerAgent({ id: 'worker-schema', client: 'codex' });
    engine.fencing.registerAgent({ id: 'worker-api', client: 'antigravity' });
    engine.fencing.registerAgent({ id: 'worker-ui', client: 'cursor' });

    // Before schemaTask completes, only schemaTask is claimable
    const claim1 = engine.claimNextTask({ agentId: 'worker-schema', isolateWorktree: true });
    expect(claim1.ok).toBe(true);
    expect(claim1.claimed).toBe(true);
    expect(claim1.task?.id).toBe('task-schema');
    expect(claim1.worktree?.worktreePath).toBeTruthy();
    expect(claim1.publishedContracts.some((c) => c.symbol_name === 'validateUser')).toBe(true);

    // Dependent tasks cannot be claimed yet
    const blockedClaim = engine.claimNextTask({ agentId: 'worker-api', isolateWorktree: true });
    expect(blockedClaim.ok).toBe(false);
    expect(blockedClaim.claimed).toBe(false);
    expect(blockedClaim.worktree).toBeNull();
    expect(blockedClaim.reason).toBe('all_queued_tasks_blocked_by_dependencies_or_locks');

    // Complete schemaTask in its isolated worktree and merge via Speculative Merge Train
    const schemaWt = claim1.worktree!.worktreePath;
    fs.mkdirSync(path.join(schemaWt, 'src/schema'), { recursive: true });
    fs.writeFileSync(
      path.join(schemaWt, 'src/schema/user.mjs'),
      'export function validateUser(input) { return Boolean(input && input.id); }\n'
    );
    engine.processPostFileEdit({
      agentId: 'worker-schema',
      filePath: 'src/schema/user.mjs',
    });
    git(schemaWt, 'add', '.');
    git(schemaWt, 'commit', '-qm', 'Add user schema');

    // Start worker-api waiting for an unblocked task while worker-schema completes
    const waitingApiPromise = engine.claimNextTaskWhenAvailable({
      agentId: 'worker-api',
      isolateWorktree: true,
      waitTimeoutMs: 5000,
    });

    const completeSchema = engine.completeWork({
      agentId: 'worker-schema',
      verificationCmd: 'node --check src/schema/user.mjs',
    });
    expect(completeSchema.ok).toBe(true);

    const claimApi = await waitingApiPromise;
    expect(claimApi.ok).toBe(true);
    expect(claimApi.claimed).toBe(true);
    expect(claimApi.task?.id).toBe(apiTask.id);
    expect(claimApi.worktree?.worktreePath).toBeTruthy();

    // worker-ui can simultaneously claim the remaining parallel task
    const claimUi = engine.claimNextTask({ agentId: 'worker-ui', isolateWorktree: true });
    expect(claimUi.ok).toBe(true);
    expect(claimUi.claimed).toBe(true);
    expect(claimUi.task?.id).toBe(uiTask.id);
    expect(claimUi.worktree?.worktreePath).toBeTruthy();
    expect(claimUi.activeSiblingIntents.map((t) => t.id)).toContain(apiTask.id);

    const prompts = buildSwarmPrompts(root);
    expect(prompts.architect).toContain('kith_add_task');
    expect(prompts.worker).toContain('kith_claim_next_task');
  });
});

describe('Multi-repo tsconfig.json contract linking & drift warnings', () => {
  it('links sibling repo contracts via tsconfig.json paths without mutating the sibling repo and warns on mismatch or drift', () => {
    const providerRoot = createRepo('service-package');
    const frontendRoot = createRepo('web-client');

    const contractRel = 'workers/contracts/publicApi.ts';
    const contractAbs = path.join(providerRoot, contractRel);
    fs.mkdirSync(path.dirname(contractAbs), { recursive: true });
    fs.writeFileSync(
      contractAbs,
      [
        'export const API_VERSION = "2.0.0";',
        'export interface PublicRecord { id: string; title: string; }',
        'export function fetchDossier(id: string): Promise<PublicRecord> { return Promise.resolve({ id, title: "ok" }); }',
      ].join('\n') + '\n'
    );
    git(providerRoot, 'add', '.');
    git(providerRoot, 'commit', '-qm', 'Add investigation contract');

    // Write tsconfig.json with JSONC comments and trailing commas in web-client
    fs.writeFileSync(
      path.join(frontendRoot, 'tsconfig.json'),
      `{
        // Cross-repo contract links into sibling service-package repo
        "compilerOptions": {
          "baseUrl": ".",
          "paths": {
            "@/*": ["./src/*"],
            "@public-api": ["../service-package/workers/contracts/publicApi.ts"],
          },
        },
      }\n`
    );
    git(frontendRoot, 'add', '.');
    git(frontendRoot, 'commit', '-qm', 'Configure tsconfig paths');

    // Inspecting frontend contracts must NOT initialize .coord in service-package
    const report = inspectWorkspaceContracts(frontendRoot);
    expect(fs.existsSync(path.join(providerRoot, '.coord'))).toBe(false);
    expect(report.linkedContracts).toHaveLength(1);
    expect(report.linkedContracts[0]).toMatchObject({
      alias: '@public-api',
      sourceRepoName: 'service-package',
      filePath: contractRel,
      dirtyInCheckout: false,
      lockedByAgent: null,
    });
    expect(report.linkedContracts[0].symbols.map((s) => s.symbolName)).toEqual(
      expect.arrayContaining(['API_VERSION', 'PublicRecord', 'fetchDossier'])
    );

    // Frontend agent begins work in an isolated worktree and receives linkedContracts
    const frontendEngine = openEngine(frontendRoot);
    frontendEngine.fencing.registerAgent({ id: 'fe-agent', client: 'antigravity' });
    const begun = frontendEngine.beginWork({
      agentId: 'fe-agent',
      title: 'Consume investigation contract',
      scopeGlobs: ['src/**'],
      isolateWorktree: true,
    });
    expect(begun.ok).toBe(true);
    expect(begun.linkedContracts).toHaveLength(1);
    expect(begun.linkedContracts[0].alias).toBe('@public-api');

    // Editing a file that imports a non-existent symbol from @public-api triggers a mismatch warning
    const consumerRel = 'src/consumer.ts';
    const consumerAbs = path.join(begun.worktree!.worktreePath, consumerRel);
    fs.writeFileSync(
      consumerAbs,
      `import { fetchDossier, NonExistentContractSymbol } from '@public-api';\nexport const run = () => fetchDossier('1');\n`
    );
    const editRes = frontendEngine.processPostFileEdit({
      agentId: 'fe-agent',
      filePath: consumerRel,
    });
    expect(editRes.warnings.some((w) => w.includes('[CROSS-REPO CONTRACT MISMATCH]') && w.includes('NonExistentContractSymbol'))).toBe(true);

    // Now a sibling agent in service-package claims the contract and modifies it in an isolated worktree
    const intelEngine = openEngine(providerRoot);
    intelEngine.fencing.registerAgent({ id: 'intel-agent', client: 'codex' });
    const intelWork = intelEngine.beginWork({
      agentId: 'intel-agent',
      title: 'Update dossier signature',
      scopeGlobs: ['workers/contracts/**'],
      isolateWorktree: true,
    });
    expect(intelWork.ok).toBe(true);

    fs.writeFileSync(
      path.join(intelWork.worktree!.worktreePath, contractRel),
      [
        'export const API_VERSION = "3.0.0";',
        'export interface PublicRecord { id: string; title: string; version: number; }',
      ].join('\n') + '\n'
    );

    const driftEditRes = frontendEngine.processPostFileEdit({
      agentId: 'fe-agent',
      filePath: consumerRel,
    });
    expect(driftEditRes.warnings.some((w) => w.includes('[CROSS-REPO ACTIVE LOCK]') && w.includes('intel-agent'))).toBe(true);
    expect(driftEditRes.warnings.some((w) => w.includes('[CROSS-REPO WORKTREE DRIFT]') && w.includes('intel-agent'))).toBe(true);
  });
});

describe('Subpackage internal symlink lock isolation', () => {
  it('does not treat internal node_modules/.bin symlinks inside a locked subpackage glob as overlapping unrelated scopes', () => {
    const root = createRepo('monorepo');
    const binDir = path.join(root, 'extensions/editor/node_modules/.bin');
    const pkgBin = path.join(root, 'extensions/editor/node_modules/esbuild/bin');
    fs.mkdirSync(binDir, { recursive: true });
    fs.mkdirSync(pkgBin, { recursive: true });
    fs.writeFileSync(path.join(pkgBin, 'esbuild'), '#!/usr/bin/env node\n');
    fs.symlinkSync('../esbuild/bin/esbuild', path.join(binDir, 'esbuild'));

    const engine = openEngine(root);
    engine.fencing.registerAgent({ id: 'editor-agent' });
    engine.fencing.registerAgent({ id: 'core-agent' });

    const lockEditor = engine.locks.acquireLocks({
      agentId: 'editor-agent',
      patterns: ['extensions/editor/**'],
    });
    expect(lockEditor.ok).toBe(true);

    const lockCore = engine.locks.acquireLocks({
      agentId: 'core-agent',
      patterns: ['src/core/**'],
    });
    expect(lockCore.ok).toBe(true);
    expect(
      engine.locks.checkFileWriteAccess({
        agentId: 'core-agent',
        filePath: 'src/index.mjs',
      }).allowed
    ).toBe(true);
  });
});
