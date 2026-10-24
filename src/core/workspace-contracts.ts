import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { AstAnalyzer, ExtractedSymbol } from './ast-analyzer.js';
import { LockEngine } from './locks.js';
import { readCoordinationState } from './observation.js';
import { discoverRepository, isWithin, physicalPath, repositoryFile } from './repository.js';

export interface LinkedWorkspaceContract {
  alias: string;
  sourceRepo: string;
  sourceRepoName: string;
  filePath: string;
  absolutePath: string;
  symbols: Array<{
    symbolName: string;
    kind: ExtractedSymbol['kind'];
    signature: string;
    astHash: string;
  }>;
  dirtyInCheckout: boolean;
  lockedByAgent: string | null;
  activeWorktreeDrifts: Array<{
    agentId: string;
    worktreePath: string;
    changedSymbols: string[];
    removedSymbols: string[];
  }>;
}

export interface WorkspaceContractReport {
  linkedContracts: LinkedWorkspaceContract[];
  warnings: string[];
}

export interface SwarmPrompts {
  architect: string;
  worker: string;
}

export function buildSwarmPrompts(repoRoot: string): SwarmPrompts {
  const cleanRoot = physicalPath(repoRoot);
  return {
    architect: `Use Kith on repository ${cleanRoot} to plan parallel multi-agent work:
1. Call kith_start_session with a unique agentId (e.g. "architect-1") and repository "${cleanRoot}".
2. Publish any shared interfaces, routes, or schemas upfront via kith_publish_contract.
3. Enqueue parallelizable tasks with disjoint file scopes using kith_add_task (passing title, intentSummary, scopeGlobs, priority, and dependsOn for sequential steps).
4. Summarize the queued task IDs and scopes so worker agents can claim them in parallel.`,
    worker: `Use Kith on repository ${cleanRoot} to claim and execute the next queued task:
1. Call kith_claim_next_task with a unique agentId, repository "${cleanRoot}", and isolateWorktree: true.
2. Edit only inside the returned worktree.worktreePath and within the task's locked scopeGlobs, respecting publishedContracts and linkedContracts.
3. After each file edit, call kith_record_file_edit to check contract blast radius and live dirty-tree conflicts.
4. Commit your changes in the worktree and call kith_complete_work with a read-only verificationCmd to verify and merge.`,
  };
}

/**
 * Strips // line comments, block comments, and trailing commas from JSONC files (such as tsconfig.json)
 * while preserving string literals.
 */
export function parseJsoncObject(raw: string): Record<string, unknown> | null {
  let out = '';
  let inString = false;
  let stringQuote = '"';
  let i = 0;

  while (i < raw.length) {
    const ch = raw[i];
    const next = raw[i + 1];

    if (inString) {
      out += ch;
      if (ch === '\\' && i + 1 < raw.length) {
        out += raw[i + 1];
        i += 2;
        continue;
      }
      if (ch === stringQuote) {
        inString = false;
      }
      i++;
      continue;
    }

    if (ch === '"' || ch === "'") {
      inString = true;
      stringQuote = ch;
      out += ch;
      i++;
      continue;
    }

    if (ch === '/' && next === '/') {
      i += 2;
      while (i < raw.length && raw[i] !== '\n') i++;
      continue;
    }

    if (ch === '/' && next === '*') {
      i += 2;
      while (i + 1 < raw.length && !(raw[i] === '*' && raw[i + 1] === '/')) i++;
      i += 2;
      continue;
    }

    out += ch;
    i++;
  }

  const withoutTrailingCommas = out.replace(/,\s*([}\]])/g, '$1');
  try {
    const parsed = JSON.parse(withoutTrailingCommas);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function primaryRepositoryRoot(repoRoot: string): string {
  try {
    const layout = discoverRepository(repoRoot);
    if (layout.commonGitDir && path.basename(layout.commonGitDir) === '.git') {
      return physicalPath(path.dirname(layout.commonGitDir));
    }
    return layout.checkoutRoot;
  } catch {
    return physicalPath(repoRoot);
  }
}

function resolveCandidateContractFiles(baseDirs: string[], rawTarget: string): string[] {
  const cleanedTarget = rawTarget.replace(/\/?\*$/, '');
  const hasWildcard = rawTarget.includes('*');

  for (const baseDir of baseDirs) {
    const candidateBase = path.resolve(baseDir, cleanedTarget);
    if (hasWildcard) {
      if (fs.existsSync(candidateBase) && fs.statSync(candidateBase).isDirectory()) {
        const files: string[] = [];
        for (const entry of fs.readdirSync(candidateBase, { withFileTypes: true })) {
          if (
            entry.isFile() &&
            /\.(ts|tsx|js|jsx|mjs)$/.test(entry.name) &&
            !entry.name.endsWith('.test.ts') &&
            !entry.name.endsWith('.spec.ts')
          ) {
            files.push(physicalPath(path.join(candidateBase, entry.name)));
            if (files.length >= 20) break;
          }
        }
        if (files.length > 0) return files;
      }
      continue;
    }

    const candidates = [
      candidateBase,
      `${candidateBase}.ts`,
      `${candidateBase}.tsx`,
      `${candidateBase}.d.ts`,
      `${candidateBase}.js`,
      path.join(candidateBase, 'index.ts'),
      path.join(candidateBase, 'index.tsx'),
    ];
    for (const candidate of candidates) {
      try {
        if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
          return [physicalPath(candidate)];
        }
      } catch {
        // Ignore inaccessible paths
      }
    }
  }
  return [];
}

function isFileDirtyInGit(checkoutRoot: string, relFilePath: string): boolean {
  try {
    const out = execFileSync(
      'git',
      ['-c', 'core.fsmonitor=false', 'status', '--porcelain=v1', '--', relFilePath],
      {
        cwd: checkoutRoot,
        encoding: 'utf8',
        timeout: 2000,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
      }
    );
    return out.trim().length > 0;
  } catch {
    return false;
  }
}

/**
 * Resolves cross-repository contracts referenced via tsconfig.json / jsconfig.json `compilerOptions.paths`
 * without mutating or initializing any sibling repository state.
 */
export function inspectWorkspaceContracts(
  repoRoot: string,
  worktreeDir?: string
): WorkspaceContractReport {
  const primaryRoot = primaryRepositoryRoot(repoRoot);
  const activeRoot = worktreeDir ? physicalPath(worktreeDir) : physicalPath(repoRoot);
  const configSearchRoots = activeRoot !== primaryRoot ? [activeRoot, primaryRoot] : [primaryRoot];
  const configNames = ['tsconfig.json', 'tsconfig.base.json', 'tsconfig.app.json', 'jsconfig.json'];

  const pathMappings = new Map<string, string[]>();
  let baseUrlRel = '.';

  for (const root of configSearchRoots) {
    for (const cfgName of configNames) {
      const cfgPath = path.join(root, cfgName);
      if (!fs.existsSync(cfgPath)) continue;
      try {
        const parsed = parseJsoncObject(fs.readFileSync(cfgPath, 'utf8'));
        const compilerOptions =
          parsed?.compilerOptions && typeof parsed.compilerOptions === 'object'
            ? (parsed.compilerOptions as Record<string, unknown>)
            : undefined;
        if (!compilerOptions) continue;
        if (typeof compilerOptions.baseUrl === 'string') {
          baseUrlRel = compilerOptions.baseUrl;
        }
        const pathsObj =
          compilerOptions.paths && typeof compilerOptions.paths === 'object'
            ? (compilerOptions.paths as Record<string, unknown>)
            : undefined;
        if (!pathsObj) continue;
        for (const [alias, targets] of Object.entries(pathsObj)) {
          if (!Array.isArray(targets)) continue;
          const stringTargets = targets.filter((t): t is string => typeof t === 'string');
          if (stringTargets.length > 0 && !pathMappings.has(alias)) {
            pathMappings.set(alias, stringTargets);
          }
        }
      } catch {
        // Ignore unreadable config
      }
    }
    if (pathMappings.size > 0) break;
  }

  if (pathMappings.size === 0) {
    return { linkedContracts: [], warnings: [] };
  }

  const baseDirs = configSearchRoots.map((r) => path.resolve(r, baseUrlRel));
  const siblingStateCache = new Map<string, ReturnType<typeof readCoordinationState>>();
  const linkedContracts: LinkedWorkspaceContract[] = [];
  const warnings: string[] = [];
  const seenTargets = new Set<string>();

  for (const [alias, rawTargets] of pathMappings.entries()) {
    for (const rawTarget of rawTargets) {
      const resolvedFiles = resolveCandidateContractFiles(baseDirs, rawTarget);
      for (const externalFile of resolvedFiles) {
        if (isWithin(primaryRoot, externalFile) || isWithin(activeRoot, externalFile)) {
          continue; // Internal path alias, not cross-repo
        }
        const dedupeKey = `${alias}::${externalFile}`;
        if (seenTargets.has(dedupeKey)) continue;
        seenTargets.add(dedupeKey);

        let siblingRoot: string;
        let relFilePath: string;
        try {
          const layout = discoverRepository(path.dirname(externalFile));
          siblingRoot =
            layout.commonGitDir && path.basename(layout.commonGitDir) === '.git'
              ? physicalPath(path.dirname(layout.commonGitDir))
              : layout.checkoutRoot;
          relFilePath = repositoryFile(siblingRoot, externalFile);
        } catch {
          siblingRoot = path.dirname(externalFile);
          relFilePath = path.basename(externalFile);
        }

        const siblingRepoName = path.basename(siblingRoot);
        let content = '';
        try {
          content = fs.readFileSync(externalFile, 'utf8');
        } catch {
          continue;
        }

        const extracted = AstAnalyzer.extractExports(content);
        const symbols = extracted.map((s) => ({
          symbolName: s.symbolName,
          kind: s.kind,
          signature: s.signature,
          astHash: s.astHash,
        }));

        const dirtyInCheckout = isFileDirtyInGit(siblingRoot, relFilePath);
        let lockedByAgent: string | null = null;
        const activeWorktreeDrifts: LinkedWorkspaceContract['activeWorktreeDrifts'] = [];

        let siblingState = siblingStateCache.get(siblingRoot);
        if (!siblingState) {
          siblingState = readCoordinationState(siblingRoot, { coordinationOnly: true });
          siblingStateCache.set(siblingRoot, siblingState);
        }

        if (siblingState.state === 'ready') {
          const activeAgents = siblingState.agents.filter(
            (a) =>
              a.status === 'active' &&
              Number.isFinite(a.lease_expires_at) &&
              a.lease_expires_at > siblingState.observedAt &&
              siblingState.sessionEpochs[a.id] !== undefined
          );
          const activeAgentById = new Map(activeAgents.map((a) => [a.id, a]));

          for (const lock of siblingState.locks) {
            const ownerId = String(lock.owner_agent_id ?? '');
            const owner = activeAgentById.get(ownerId);
            if (!owner) continue;
            if (Number(lock.expires_at) <= siblingState.observedAt) continue;
            if (Number(lock.fencing_token) < siblingState.sessionEpochs[ownerId]) continue;
            if (LockEngine.patternsOverlap(relFilePath, String(lock.pattern))) {
              lockedByAgent = ownerId;
              break;
            }
          }

          const baseSymbolMap = new Map(symbols.map((s) => [s.symbolName, s.astHash]));
          for (const agent of activeAgents) {
            if (!agent.worktree_path || physicalPath(agent.worktree_path) === siblingRoot) continue;
            const wtFile = path.join(agent.worktree_path, relFilePath);
            if (!fs.existsSync(wtFile)) continue;
            try {
              const wtContent = fs.readFileSync(wtFile, 'utf8');
              if (wtContent === content) continue;
              const wtSymbols = AstAnalyzer.extractExports(wtContent);
              const wtSymbolMap = new Map(wtSymbols.map((s) => [s.symbolName, s.astHash]));
              const changedSymbols: string[] = [];
              const removedSymbols: string[] = [];

              for (const [symName, baseHash] of baseSymbolMap.entries()) {
                const wtHash = wtSymbolMap.get(symName);
                if (!wtHash) removedSymbols.push(symName);
                else if (wtHash !== baseHash) changedSymbols.push(symName);
              }
              for (const [symName] of wtSymbolMap.entries()) {
                if (!baseSymbolMap.has(symName)) changedSymbols.push(symName);
              }

              if (changedSymbols.length > 0 || removedSymbols.length > 0) {
                activeWorktreeDrifts.push({
                  agentId: agent.id,
                  worktreePath: agent.worktree_path,
                  changedSymbols,
                  removedSymbols,
                });
              }
            } catch {
              // Ignore unreadable worktree file
            }
          }
        }

        linkedContracts.push({
          alias,
          sourceRepo: siblingRoot,
          sourceRepoName: siblingRepoName,
          filePath: relFilePath,
          absolutePath: externalFile,
          symbols,
          dirtyInCheckout,
          lockedByAgent,
          activeWorktreeDrifts,
        });

        if (lockedByAgent) {
          warnings.push(
            `[CROSS-REPO ACTIVE LOCK] Linked contract '${alias}' (${siblingRepoName}/${relFilePath}) is actively claimed by agent '${lockedByAgent}' in sibling repository '${siblingRepoName}'.`
          );
        }
        if (dirtyInCheckout) {
          warnings.push(
            `[CROSS-REPO CONTRACT DRIFT] Linked contract '${alias}' (${siblingRepoName}/${relFilePath}) has uncommitted modifications in sibling repository '${siblingRepoName}'.`
          );
        }
        for (const drift of activeWorktreeDrifts) {
          const detail = [
            drift.changedSymbols.length ? `modified: ${drift.changedSymbols.join(', ')}` : '',
            drift.removedSymbols.length ? `removed: ${drift.removedSymbols.join(', ')}` : '',
          ]
            .filter(Boolean)
            .join('; ');
          warnings.push(
            `[CROSS-REPO WORKTREE DRIFT] Linked contract '${alias}' (${siblingRepoName}/${relFilePath}) has unmerged signature changes in sibling agent '${drift.agentId}' worktree (${detail}).`
          );
        }
      }
    }
  }

  return { linkedContracts, warnings };
}

/**
 * Checks a modified source file's imports against linked cross-repo contracts (`tsconfig.json` `paths`),
 * returning actionable warnings if imported symbols do not exist or if the linked contract is drifting.
 */
export function verifyCrossRepoImportsForFile(params: {
  repoRoot: string;
  worktreeDir?: string;
  filePath: string;
  content: string;
}): string[] {
  const report = inspectWorkspaceContracts(params.repoRoot, params.worktreeDir);
  if (report.linkedContracts.length === 0) return [];

  const imports = AstAnalyzer.extractImports(
    params.worktreeDir ?? params.repoRoot,
    params.filePath,
    params.content
  );
  if (imports.length === 0) return [];

  const warnings: string[] = [];
  for (const imp of imports) {
    if (imp.rawSpecifier.startsWith('.')) continue;
    const matchedLinks = report.linkedContracts.filter((link) => {
      if (link.alias === imp.rawSpecifier) return true;
      if (link.alias.endsWith('/*')) {
        const prefix = link.alias.slice(0, -1);
        return imp.rawSpecifier.startsWith(prefix);
      }
      return false;
    });
    if (matchedLinks.length === 0) continue;

    const exportedNames = new Set(
      matchedLinks.flatMap((l) => l.symbols.map((s) => s.symbolName))
    );

    for (const sym of imp.importedSymbols) {
      if (!sym || sym === '*' || sym.startsWith('* as ')) continue;
      if (!exportedNames.has(sym)) {
        const targetLabel = matchedLinks
          .map((l) => `${l.sourceRepoName}/${l.filePath}`)
          .join(', ');
        warnings.push(
          `[CROSS-REPO CONTRACT MISMATCH] '${params.filePath}' imports '${sym}' from '${imp.rawSpecifier}' (${targetLabel}), but '${sym}' is not exported by that contract.`
        );
      }
    }

    for (const link of matchedLinks) {
      if (link.lockedByAgent) {
        warnings.push(
          `[CROSS-REPO ACTIVE LOCK] '${params.filePath}' imports '${imp.rawSpecifier}' (${link.sourceRepoName}/${link.filePath}), which is currently locked by sibling agent '${link.lockedByAgent}'.`
        );
      }
      if (link.dirtyInCheckout) {
        warnings.push(
          `[CROSS-REPO CONTRACT DRIFT] '${params.filePath}' imports '${imp.rawSpecifier}' (${link.sourceRepoName}/${link.filePath}), which has uncommitted changes in '${link.sourceRepoName}'.`
        );
      }
      for (const drift of link.activeWorktreeDrifts) {
        warnings.push(
          `[CROSS-REPO WORKTREE DRIFT] '${params.filePath}' imports '${imp.rawSpecifier}' (${link.sourceRepoName}/${link.filePath}), which has unmerged signature changes in sibling agent '${drift.agentId}' worktree.`
        );
      }
    }
  }

  return [...new Set(warnings)];
}
