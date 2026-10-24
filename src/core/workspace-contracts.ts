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
  dirtyInCheckout: boolean | null;
  exportsComplete: boolean;
  ownershipAvailable: boolean;
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
  complete: boolean;
}

export interface SwarmPrompts {
  architect: string;
  worker: string;
}

export function buildSwarmPrompts(repoRoot: string): SwarmPrompts {
  const layout = discoverRepository(repoRoot);
  if (!layout.commonGitDir) throw new Error('Select a Git checkout for task prompts, not a parent workspace.');
  const cleanRoot = layout.checkoutRoot;
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


// Advisory work is bounded independently of a repository's size. Never return source
// initializers: callers can inspect an explicitly selected repository themselves.
const MAX_SOURCE_BYTES = 64 * 1024;
const MAX_REPLY_BYTES = 16 * 1024;
const MAX_LINKS = 8;
const MAX_SYMBOLS = 64;
function git(root: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'core.fsmonitor=false', ...args], {
    cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 2000, maxBuffer: MAX_SOURCE_BYTES, env: {...process.env, GIT_OPTIONAL_LOCKS: '0'},
  }).trim();
}
function readBounded(file: string): string {
  const fd = fs.openSync(file, 'r');
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size > MAX_SOURCE_BYTES) throw new Error('Contract/config file exceeds inspection limit or is not a regular file');
    const bytes = Buffer.alloc(MAX_SOURCE_BYTES + 1);
    const size = fs.readSync(fd, bytes, 0, bytes.length, 0);
    if (size > MAX_SOURCE_BYTES) throw new Error('Contract/config file exceeds inspection limit');
    return bytes.subarray(0, size).toString('utf8');
  } finally { fs.closeSync(fd); }
}
function resolveFile(base: string): string | undefined {
  for (const name of [base, `${base}.ts`, `${base}.tsx`, `${base}.d.ts`, `${base}.js`, `${base}.jsx`, path.join(base, 'index.ts'), path.join(base, 'index.js')]) {
    if (fs.existsSync(name) && fs.statSync(name).isFile()) return physicalPath(name);
  }
}

/** Inspect explicit local TS/JS path aliases, never arbitrary directories or a global file crawl.
 * Wildcards are resolved against concrete imports at edit time, not unioned across a folder.
 * This is advisory static inspection, not a compiler or a cross-language compatibility verdict.
 */
export function inspectWorkspaceContracts(repoRoot: string, worktreeDir?: string, imports?: string[]): WorkspaceContractReport {
  const report: WorkspaceContractReport = {linkedContracts: [], warnings: [], complete: true};
  const unavailable = (detail: string) => {
    report.complete = false;
    if (report.warnings.length < 8) report.warnings.push(`[CROSS-REPO UNAVAILABLE] ${detail.slice(0, 300)}`);
  };
  try {
    const layout = discoverRepository(worktreeDir ?? repoRoot);
    if (!layout.commonGitDir) return report;
    const activeRoot = layout.checkoutRoot;
    let config: Record<string, unknown> | null = null;
    for (const name of ['tsconfig.json', 'jsconfig.json']) {
      const file = path.join(activeRoot, name);
      if (!fs.existsSync(file)) continue;
      repositoryFile(activeRoot, file); // Refuse config symlinks outside the checkout.
      config = parseJsoncObject(readBounded(file));
      if (!config) unavailable(`Cannot parse ${name}; aliases were not inspected.`);
      break;
    }
    if (!config) return report;
    const options = config.compilerOptions as {baseUrl?: unknown; paths?: Record<string, unknown>} | undefined;
    if (config.extends || config.references) { unavailable('Inherited/referenced configuration is not inspected; use your normal compiler checks.'); return report; }
    if (!options?.paths || typeof options.paths !== 'object') return report;
    const caller = discoverRepository(repoRoot);
    if (caller.commonGitDir !== layout.commonGitDir) { unavailable('Worktree repository identity differs from the caller.'); return report; }
    const bases = [...new Set([activeRoot, caller.checkoutRoot])].map(root => path.resolve(root, typeof options.baseUrl === 'string' ? options.baseUrl : '.'));
    let symbolBudget = MAX_SYMBOLS;
    const aliases = Object.entries(options.paths).sort(([a], [b]) => b.length - a.length);
    if (aliases.length > 32) unavailable('Alias limit reached; inspection is partial.');
    const externalTargets = (targets: unknown) => Array.isArray(targets) && targets.slice(0, 8).some(target => typeof target === 'string' && !isWithin(caller.checkoutRoot, physicalPath(path.resolve(bases[bases.length - 1], target.replace('*', '')))));
    const selected = imports ? [...new Set(imports)].slice(0, 32) : aliases.slice(0, 32).filter(([a]) => !a.includes('*')).map(([a]) => a);
    if (imports && imports.length > 32) unavailable('Import limit reached; inspection is partial.');
    if (!imports && aliases.some(([a, targets]) => a.includes('*') && externalTargets(targets))) unavailable('Wildcard aliases are checked for concrete imports after edits; not enumerated by status.');
    for (const specifier of selected) {
      const match = aliases.slice(0, 32).find(([alias]) => {
        if (!alias.includes('*')) return alias === specifier;
        const [prefix, suffix, extra] = alias.split('*');
        return extra === undefined && specifier.startsWith(prefix) && specifier.endsWith(suffix) && specifier.length >= prefix.length + suffix.length;
      });
      if (!match || !Array.isArray(match[1])) continue;
      const [alias, targets] = match;
      if (!externalTargets(targets)) continue;
      const star = alias.indexOf('*');
      const substitution = star < 0 ? '' : specifier.slice(star, specifier.length - (alias.length - star - 1));
      if (substitution.split(/[\\/]/).some(part => part === '..')) { unavailable('Alias traversal was not inspected.'); continue; }
      let externalFile: string | undefined;
      for (const target of targets.slice(0, 8)) {
        if (typeof target !== 'string' || (target.match(/\*/g)?.length ?? 0) > 1) continue;
        for (const base of bases) { externalFile = resolveFile(path.resolve(base, target.replace('*', substitution))); if (externalFile) break; }
        if (externalFile) break;
      }
      if (!externalFile) { unavailable(`Cannot resolve '${specifier}'; no compatibility verdict available.`); continue; }
      if (isWithin(activeRoot, externalFile)) continue;
      const sibling = discoverRepository(path.dirname(externalFile));
      if (!sibling.commonGitDir || sibling.commonGitDir === layout.commonGitDir) {
        unavailable(`'${specifier}' does not select a separate Git repository; no external source was read.`); continue;
      }
      const siblingRoot = sibling.checkoutRoot;
      const relative = repositoryFile(siblingRoot, externalFile);
      // Untracked/private files and aliases escaping the discovered checkout are not contracts.
      git(siblingRoot, 'ls-files', '--error-unmatch', '--', relative);
      if (report.linkedContracts.length >= MAX_LINKS || symbolBudget <= 0) { unavailable('Contract/symbol limit reached; inspection is partial.'); break; }
      const content = readBounded(externalFile);
      const extracted = AstAnalyzer.extractExports(content);
      const symbols = extracted.slice(0, symbolBudget).map(s => ({
        symbolName: s.symbolName.slice(0, 128), kind: s.kind,
        signature: `${s.kind} ${s.symbolName}`.slice(0, 160), astHash: s.astHash,
      }));
      symbolBudget -= symbols.length;
      const exportsComplete = extracted.length === symbols.length && !/export\s+(?:\*|\{)/.test(content);
      if (!exportsComplete) unavailable(`'${specifier}' exports are partial or re-exported; missing-export checks are unavailable.`);
      let dirtyInCheckout: boolean | null = null;
      try { dirtyInCheckout = Boolean(git(siblingRoot, 'status', '--porcelain=v1', '--', relative)); }
      catch { unavailable(`'${specifier}' Git status is unavailable.`); }
      const state = readCoordinationState(siblingRoot, {coordinationOnly: true});
      const ownershipAvailable = state.state === 'missing' || state.state === 'ready' && state.schemaVersion === 3 && !state.truncated;
      if (!ownershipAvailable) unavailable(`'${specifier}' sibling ownership is unavailable or partial; inspect its stopped state before recovery.`);
      const agents = state.state === 'ready' ? state.agents.filter(a => a.status === 'active' && a.lease_expires_at > state.observedAt && state.sessionEpochs[a.id] !== undefined) : [];
      const locked = state.locks.find(l => agents.some(a => a.id === l.owner_agent_id) && Number(l.expires_at) > state.observedAt && Number(l.fencing_token) >= state.sessionEpochs[String(l.owner_agent_id)] && LockEngine.patternsOverlap(relative, String(l.pattern)));
      const drifts: LinkedWorkspaceContract['activeWorktreeDrifts'] = [];
      for (const agent of agents.slice(0, 8)) {
        if (!agent.worktree_path || physicalPath(agent.worktree_path) === siblingRoot) continue;
        try {
          const wt = discoverRepository(agent.worktree_path);
          if (wt.checkoutRoot !== physicalPath(agent.worktree_path) || wt.commonGitDir !== sibling.commonGitDir) throw new Error('Worktree identity changed');
          const file = path.join(wt.checkoutRoot, relative);
          repositoryFile(wt.checkoutRoot, file);
          const current = AstAnalyzer.extractExports(readBounded(file));
          const original = new Map(extracted.map(s => [s.symbolName, s.astHash]));
          const updated = new Map(current.map(s => [s.symbolName, s.astHash]));
          const changed = [...updated].filter(([name, hash]) => original.get(name) !== hash).map(([name]) => name);
          const removed = [...original.keys()].filter(name => !updated.has(name));
          if (changed.length || removed.length) drifts.push({agentId: agent.id, worktreePath: wt.checkoutRoot, changedSymbols: changed.slice(0, 16), removedSymbols: removed.slice(0, 16)});
          if (changed.length > 16 || removed.length > 16) unavailable(`'${specifier}' drift detail is partial.`);
        } catch { unavailable(`'${specifier}' recorded worktree is unavailable; drift has not been verified.`); }
      }
      if (agents.length > 8) unavailable(`'${specifier}' owner/worktree inspection limit reached.`);
      const link: LinkedWorkspaceContract = {alias: specifier, sourceRepo: siblingRoot, sourceRepoName: path.basename(siblingRoot), filePath: relative, absolutePath: externalFile, symbols, exportsComplete, ownershipAvailable, dirtyInCheckout, lockedByAgent: locked ? String(locked.owner_agent_id) : null, activeWorktreeDrifts: drifts};
      report.linkedContracts.push(link);
      if (Buffer.byteLength(JSON.stringify(report)) > MAX_REPLY_BYTES - 3000) {
        report.linkedContracts.pop(); unavailable('Reply byte limit reached; inspection is partial.'); break;
      }
      if (locked) report.warnings.push(`[CROSS-REPO ACTIVE LOCK] '${specifier}' is claimed by '${locked.owner_agent_id}'.`.slice(0, 300));
      if (dirtyInCheckout) report.warnings.push(`[CROSS-REPO CONTRACT DRIFT] '${specifier}' has uncommitted changes.`.slice(0, 300));
      for (const drift of drifts) report.warnings.push(`[CROSS-REPO WORKTREE DRIFT] '${specifier}' has unmerged signature changes in '${drift.agentId}'.`.slice(0, 300));
      if (report.warnings.length > 8) { report.warnings = report.warnings.slice(0, 7); unavailable('Warning limit reached; inspection is partial.'); }
    }
  } catch { unavailable('Contract inspection could not finish; existing claims/work remain valid. Use normal project verification.'); }
  return report;
}

export function verifyCrossRepoImportsForFile(params: {repoRoot: string; worktreeDir?: string; filePath: string; content: string}): string[] {
  if (Buffer.byteLength(params.content) > MAX_SOURCE_BYTES) return ['[CROSS-REPO UNAVAILABLE] Edited file exceeds inspection limit; use normal project verification.'];
  const imports = AstAnalyzer.extractImports(params.worktreeDir ?? params.repoRoot, params.filePath, params.content);
  const report = inspectWorkspaceContracts(params.repoRoot, params.worktreeDir, imports.map(i => i.rawSpecifier));
  const warnings = [...report.warnings];
  const namedImports = [...params.content.matchAll(/import\s+(?:type\s+)?(?:[\w$]+\s*,\s*)?\{([^}]+)\}\s*from\s*['"]([^'"]+)['"]/g)];
  for (const imp of namedImports.slice(0, 32)) {
    const link = report.linkedContracts.find(l => l.alias === imp[2]);
    if (!link?.exportsComplete) continue;
    const exported = new Set(link.symbols.map(s => s.symbolName));
    for (const binding of imp[1].split(',')) {
      const symbol = binding.trim().replace(/^type\s+/, '').split(/\s+as\s+/)[0];
      if (!symbol || exported.has(symbol)) continue;
      if (warnings.length >= 8) break;
      warnings.push(`[CROSS-REPO CONTRACT MISMATCH] '${params.filePath.slice(0, 120)}' imports '${symbol.slice(0, 120)}' from '${imp[2].slice(0, 120)}', but that module has no such recorded export.`);
    }
  }
  return warnings;
}
