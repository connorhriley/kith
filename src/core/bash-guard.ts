import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { discoverRepository, isWithin, physicalPath } from './repository.js';
import fs from 'node:fs';
import path from 'node:path';
import { CoordDatabase } from './db.js';
import { DependencyAndContractEngine } from './dep-graph.js';
import { FencingAndAgentManager, type AgentRecord } from './fencing.js';
import { ignoredPaths, walkNonIgnoredFiles } from './git-ignore.js';
import { LockEngine } from './locks.js';
import type { RecordedTask } from './recorded-files.js';
import { ShadowGitEngine } from './shadow-git.js';
import {
  DESTRUCTIVE_SHARED_REFS,
  DESTRUCTIVE_SHARED_TREE,
  assessSharedCheckoutUpdate,
  casCommandDirectories,
  commandMovesSharedCheckout,
  firewallReason,
  foreignRefLease,
  settleDeferredRefUpdate,
  suggestKithCommit,
  type RefHost,
} from './shared-ref-update.js';

const require = createRequire(import.meta.url);

export interface FileSnapshotEntry {
  relPath: string;
  mtimeMs: number;
  size: number;
  sha256: string;
  lockedByOther: boolean;
  backupContentBase64?: string;
}

export interface QuarantineRecord {
  id: string;
  agent_id: string;
  command: string;
  file_path: string;
  patch_path: string;
  reason: string;
  created_at: number;
}

export interface BashGuardPostReport {
  allowed: boolean;
  authorizedModifiedFiles: string[];
  quarantinedViolations: QuarantineRecord[];
}

const SAFE_GIT_GLOBALS = new Set([
  '--no-pager', '-P', '--paginate', '-p',
  '--literal-pathspecs', '--no-optional-locks', '--no-replace-objects',
]);

type ShellSep = '&&' | '||' | ';' | '|' | '&' | '\n' | 'end';

type RefOp =
  | { kind: 'block' }
  | { kind: 'update-ref'; dir: string; ref: string; noDeref: boolean; stdin: boolean }
  | { kind: 'symbolic-read' }
  | { kind: 'symbolic-write'; dir: string; name: string; target: string | null; delete: boolean };

interface IsolatedOwner {
  worktree: string;
  branch: string;
  integrationBranch: string | null;
}

/**
 * Checkouts whose index should be resynced after a command that ran `git update-ref`.
 * Each directory is the worktree root of a classified `update-ref` (after `git -C` and `cd`).
 * Unparsed commands and stdin batches yield nothing, so the post-hook does not reset an unrelated index.
 */
export function refUpdateResyncRoots(command: string, startDir: string): string[] {
  const dirs: string[] = [];
  const ops = parseRefOps(command, startDir);
  if (ops) {
    for (const op of ops) {
      if (op.kind === 'update-ref' && !op.stdin && op.ref) dirs.push(op.dir);
    }
  }
  // A value like "$NEW" is not a word the strict parser can trust, so it contributes no
  // directory. The compare-and-swap shape still names the checkout that should be resynced.
  if (dirs.length === 0) dirs.push(...casCommandDirectories(command, startDir));
  if (dirs.length === 0) return [];
  let anchor: string | null = null;
  try { anchor = discoverRepository(startDir).commonGitDir; } catch { anchor = null; }
  const roots: string[] = [];
  for (const dir of dirs) {
    let checkout: string;
    let common: string | null;
    try {
      const layout = discoverRepository(dir);
      checkout = layout.checkoutRoot;
      common = layout.commonGitDir;
    } catch { continue; }
    if (!common) continue;
    if (anchor && common !== anchor) continue;
    if (!roots.includes(checkout)) roots.push(checkout);
  }
  return roots;
}

function sharedRefUpdatesAreOwned(
  command: string,
  startDir: string,
  agent: AgentRecord | null,
  peers: AgentRecord[],
): boolean {
  const ops = parseRefOps(command, startDir);
  if (!ops) return false;
  if (ops.some(op => op.kind === 'block')) return false;
  const needsOwner = ops.some(op => op.kind === 'update-ref' || op.kind === 'symbolic-write');
  if (!needsOwner) return true;
  if (!agent?.worktree_path || !agent.branch) return false;
  const owner = isolatedOwner(agent, peers);
  for (const op of ops) {
    if (op.kind === 'update-ref' && !updateRefOwned(op, owner)) return false;
    if (op.kind === 'symbolic-write' && !symbolicWriteOwned(op, owner)) return false;
  }
  return true;
}

function isolatedOwner(agent: AgentRecord, peers: AgentRecord[]): IsolatedOwner | null {
  if (!agent.worktree_path || !agent.branch) return null;
  let worktree: string;
  try { worktree = physicalPath(agent.worktree_path); } catch { return null; }
  const main = mainCheckout(worktree);
  if (!main || main.path === worktree) return null;
  if (main.branch && agent.branch === main.branch) return null;
  for (const peer of peers) {
    if (peer.branch === agent.branch) return null;
    // A null worktree_path is the primary checkout: registration stores a path only for linked worktrees.
    try {
      if (physicalPath(peer.worktree_path ?? main.path) === worktree) return null;
    } catch { return null; }
  }
  return { worktree, branch: agent.branch, integrationBranch: main.branch };
}

function mainCheckout(cwd: string): { path: string; branch: string | null } | null {
  let out: string;
  try {
    out = execFileSync('git', ['worktree', 'list', '--porcelain'], {
      cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000,
    });
  } catch { return null; }
  const first = out.split(/\n\s*\n/)[0] ?? '';
  let wt: string | null = null;
  let branch: string | null = null;
  let detached = false;
  for (const line of first.split('\n')) {
    if (line.startsWith('worktree ')) wt = line.slice('worktree '.length).trim();
    else if (line.startsWith('branch ')) branch = line.slice('branch '.length).replace(/^refs\/heads\//, '').trim();
    else if (line === 'detached' || line.startsWith('detached ')) detached = true;
  }
  if (!wt) return null;
  try { return { path: physicalPath(wt), branch: detached ? null : branch }; }
  catch { return null; }
}

function updateRefOwned(
  op: { dir: string; ref: string; noDeref: boolean; stdin: boolean },
  owner: IsolatedOwner | null,
): boolean {
  if (op.stdin || !owner || !directoryInside(op.dir, owner.worktree)) return false;
  if (op.ref === 'HEAD') {
    if (op.noDeref) return true;
    const checked = checkedOutBranch(op.dir);
    if (!checked.ok) return false;
    if (checked.branch === null) return true;
    return checked.branch === owner.branch && checked.branch !== owner.integrationBranch;
  }
  const branch = headsBranch(op.ref);
  if (!branch || branch !== owner.branch || branch === owner.integrationBranch) return false;
  const checked = checkedOutBranch(op.dir);
  return checked.ok && checked.branch === branch;
}

/** A symbolic-ref write is safe only when it points this worktree's HEAD at the caller's own branch. */
function symbolicWriteOwned(
  op: { dir: string; name: string; target: string | null; delete: boolean },
  owner: IsolatedOwner | null,
): boolean {
  if (op.delete || !op.target || !owner || op.name !== 'HEAD') return false;
  if (!directoryInside(op.dir, owner.worktree)) return false;
  if (owner.integrationBranch && owner.branch === owner.integrationBranch) return false;
  return op.target === `refs/heads/${owner.branch}`;
}

function headsBranch(ref: string): string | null {
  if (!ref.startsWith('refs/heads/')) return null;
  const name = ref.slice('refs/heads/'.length);
  if (!name || name.startsWith('/') || name.endsWith('/') || name.includes('@{') || name.includes('..')) return null;
  return name;
}

function directoryInside(dir: string, worktree: string): boolean {
  try {
    const resolved = physicalPath(dir);
    return resolved === worktree || isWithin(worktree, resolved);
  } catch { return false; }
}

function checkedOutBranch(dir: string): { ok: true; branch: string | null } | { ok: false } {
  try {
    const out = execFileSync('git', ['symbolic-ref', '-q', '--short', 'HEAD'], {
      cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000,
    }).trim();
    return { ok: true, branch: out || null };
  } catch (error) {
    if ((error as { status?: number }).status === 1) return { ok: true, branch: null };
    return { ok: false };
  }
}

function parseRefOps(command: string, startDir: string): RefOp[] | null {
  const segments = splitShellSegments(command);
  if (!segments) return null;
  let cwd = path.resolve(startDir);
  let trusted = true;
  const ops: RefOp[] = [];
  for (const segment of segments) {
    const words = shellWords(segment.raw);
    const matched = DESTRUCTIVE_SHARED_REFS.test(segment.raw);
    if (!words) {
      if (matched) ops.push({ kind: 'block' });
      if (continuesShell(segment.nextSep) && /\b(?:cd|pushd|popd|export|source)\b|\bGIT_DIR\b/.test(segment.raw)) trusted = false;
      continue;
    }
    const { danger, argv } = stripLeadingEnv(words);
    if (argv.length === 0) continue;
    const head = argv[0];
    if (head === 'cd') {
      const next = applyCd(argv, cwd);
      if (next && continuesShell(segment.nextSep)) cwd = next;
      else if (!next && continuesShell(segment.nextSep)) trusted = false;
      continue;
    }
    if (head === 'pushd' || head === 'popd' || head === 'source' || (head === '.' && argv.length > 1)) {
      if (continuesShell(segment.nextSep)) trusted = false;
      continue;
    }
    if (head === 'export') {
      if (argv.slice(1).some(arg => dangerousGitEnv(arg.split('=')[0] ?? arg))) trusted = false;
      continue;
    }
    if (!isGitBinary(head) || danger || !trusted) {
      if (matched) ops.push({ kind: 'block' });
      continue;
    }
    const parsed = parseGitInvocation(argv, cwd);
    if (parsed.kind === 'unclassified') {
      if (matched) ops.push({ kind: 'block' });
      continue;
    }
    if (parsed.kind !== 'other') ops.push(parsed);
  }
  return ops;
}

function continuesShell(sep: ShellSep): boolean {
  return sep === '&&' || sep === ';' || sep === '\n';
}

function splitShellSegments(command: string): Array<{ raw: string; nextSep: ShellSep }> | null {
  const parts: Array<{ raw: string; nextSep: ShellSep }> = [];
  let buf = '';
  let quote: "'" | '"' | null = null;
  const push = (sep: ShellSep) => {
    const raw = buf.trim();
    buf = '';
    if (raw) parts.push({ raw, nextSep: sep });
  };
  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    if (quote === "'") {
      buf += ch;
      if (ch === "'") quote = null;
      continue;
    }
    if (quote === '"') {
      if (ch === '\\' && i + 1 < command.length) {
        const next = command[i + 1];
        if (next === '$' || next === '`' || next === '"' || next === '\\' || next === '\n') {
          buf += ch + next;
          i++;
          continue;
        }
      }
      buf += ch;
      if (ch === '"') quote = null;
      continue;
    }
    if (ch === '\\' && i + 1 < command.length) {
      if (command[i + 1] === '\n') { i++; continue; }
      buf += ch + command[i + 1];
      i++;
      continue;
    }
    if (ch === "'" || ch === '"') { quote = ch; buf += ch; continue; }
    if (ch === '&' && command[i + 1] === '&') { push('&&'); i++; continue; }
    if (ch === '|' && command[i + 1] === '|') { push('||'); i++; continue; }
    if (ch === '\r' && command[i + 1] === '\n') { push('\n'); i++; continue; }
    if (ch === '\n') { push('\n'); continue; }
    if (ch === ';') { push(';'); continue; }
    if (ch === '|') { push('|'); continue; }
    if (ch === '&') { push('&'); continue; }
    buf += ch;
  }
  if (quote) return null;
  push('end');
  return parts;
}

/** Words of one simple command. Null when expansion, substitution, or a redirect makes the argv unreliable. */
function shellWords(segment: string): string[] | null {
  const words: string[] = [];
  let buf = '';
  let quote: "'" | '"' | null = null;
  let word = false;
  const flush = () => {
    if (word) words.push(buf);
    buf = '';
    word = false;
  };
  for (let i = 0; i < segment.length; i++) {
    const ch = segment[i];
    if (quote === "'") {
      if (ch === "'") quote = null;
      else { buf += ch; word = true; }
      continue;
    }
    if (quote === '"') {
      if (ch === '\\' && i + 1 < segment.length) {
        const next = segment[i + 1];
        if ('$`"\\'.includes(next)) { buf += next; word = true; i++; continue; }
        if (next === '\n') { i++; continue; }
      }
      if (ch === '"') { quote = null; word = true; continue; }
      if (ch === '`' || ch === '$') return null;
      buf += ch;
      word = true;
      continue;
    }
    if (ch === '\\' && i + 1 < segment.length) { buf += segment[i + 1]; word = true; i++; continue; }
    if (ch === "'" || ch === '"') { quote = ch; word = true; continue; }
    if (ch === '`' || ch === '$' || ch === '(' || ch === ')' || ch === '<' || ch === '>') return null;
    if (ch === '#' && !word) break;
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') { flush(); continue; }
    buf += ch;
    word = true;
  }
  if (quote) return null;
  flush();
  return words;
}

function stripLeadingEnv(argv: string[]): { danger: boolean; argv: string[] } {
  let i = 0;
  let danger = false;
  while (i < argv.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(argv[i])) {
    if (dangerousGitEnv(argv[i].slice(0, argv[i].indexOf('=')))) danger = true;
    i++;
  }
  return { danger, argv: argv.slice(i) };
}

function dangerousGitEnv(name: string): boolean {
  return name === 'GIT_DIR' || name === 'GIT_WORK_TREE' || name === 'GIT_COMMON_DIR'
    || name === 'GIT_NAMESPACE' || name === 'GIT_OBJECT_DIRECTORY' || name === 'GIT_ALTERNATE_OBJECT_DIRECTORIES'
    || name === 'GIT_CONFIG_PARAMETERS' || name === 'GIT_CONFIG_COUNT' || name === 'GIT_CONFIG_GLOBAL'
    || name === 'GIT_CONFIG_SYSTEM' || /^GIT_CONFIG_(?:KEY|VALUE)_\d+$/.test(name);
}

function applyCd(argv: string[], cwd: string): string | null {
  let args = argv.slice(1);
  if (args[0] === '--') args = args.slice(1);
  if (args.length !== 1 || args[0] === '-' || args[0].startsWith('-') || args[0].startsWith('~')) return null;
  return path.resolve(cwd, args[0]);
}

function isGitBinary(word: string): boolean {
  const base = word.slice(Math.max(word.lastIndexOf('/'), word.lastIndexOf('\\')) + 1);
  return base === 'git' || base.toLowerCase() === 'git.exe';
}

function parseGitInvocation(argv: string[], cwd: string): RefOp | { kind: 'other' } | { kind: 'unclassified' } {
  let i = 1;
  let dir = cwd;
  while (i < argv.length) {
    const token = argv[i];
    if (token === '--') { i++; break; }
    if (token === '-C') {
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('~')) return { kind: 'unclassified' };
      if (next !== '') dir = path.isAbsolute(next) ? next : path.resolve(dir, next);
      i += 2;
      continue;
    }
    if (token.startsWith('-C') && token.length > 2) {
      const next = token.slice(2);
      if (next.startsWith('~')) return { kind: 'unclassified' };
      dir = path.isAbsolute(next) ? next : path.resolve(dir, next);
      i++;
      continue;
    }
    if (SAFE_GIT_GLOBALS.has(token)) { i++; continue; }
    if (token.startsWith('-')) return { kind: 'unclassified' };
    break;
  }
  const sub = argv[i];
  if (!sub) return { kind: 'other' };
  const args = argv.slice(i + 1);
  if (sub === 'update-ref') return parseUpdateRef(dir, args);
  if (sub === 'symbolic-ref') return parseSymbolicRef(dir, args);
  if (sub === 'worktree') return args.some(arg => arg === 'remove' || arg === 'prune')
    ? { kind: 'block' }
    : { kind: 'other' };
  if (sub === 'branch') return branchArgsAreDestructive(args) ? { kind: 'block' } : { kind: 'other' };
  return { kind: 'other' };
}

function branchArgsAreDestructive(args: string[]): boolean {
  for (const arg of args) {
    if (arg === '--') break;
    if (arg === '--delete' || arg === '--move' || arg === '--force') return true;
    if (arg.startsWith('--delete') || arg.startsWith('--move') || arg.startsWith('--force')) return true;
    if (arg.startsWith('-') && !arg.startsWith('--') && /[dDmMfF]/.test(arg.slice(1))) return true;
  }
  return false;
}

function parseUpdateRef(dir: string, args: string[]): RefOp | { kind: 'unclassified' } {
  let noDeref = false;
  let deleteRef = false;
  let stdin = false;
  let end = false;
  const positionals: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (!end && arg === '--') { end = true; continue; }
    if (!end && arg.startsWith('-')) {
      if (arg === '--no-deref') { noDeref = true; continue; }
      if (arg === '--deref') { noDeref = false; continue; }
      if (arg === '--create-reflog' || arg === '--no-create-reflog' || arg === '--no-stdin') continue;
      if (arg === '--stdin' || arg === '-z') { stdin = true; continue; }
      if (arg === '-d') { deleteRef = true; continue; }
      if (arg === '-m' || arg === '--message') {
        if (args[i + 1] === undefined) return { kind: 'unclassified' };
        i++;
        continue;
      }
      if (arg.startsWith('-m') && arg.length > 2) continue;
      if (arg.startsWith('--message=')) continue;
      return { kind: 'unclassified' };
    }
    positionals.push(arg);
  }
  if (stdin) return { kind: 'update-ref', dir, ref: '', noDeref, stdin: true };
  const expected = deleteRef ? [1, 2] : [2, 3];
  if (!expected.includes(positionals.length) || !positionals[0]) return { kind: 'unclassified' };
  return { kind: 'update-ref', dir, ref: positionals[0], noDeref, stdin: false };
}

function parseSymbolicRef(dir: string, args: string[]): RefOp | { kind: 'unclassified' } {
  let deleteRef = false;
  let end = false;
  const positionals: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (!end && arg === '--') { end = true; continue; }
    if (!end && arg.startsWith('-')) {
      if (arg === '-q' || arg === '--quiet' || arg === '--no-quiet' || arg === '--short' || arg === '--no-short') continue;
      if (arg === '--recurse' || arg === '--no-recurse') continue;
      if (arg === '-d' || arg === '--delete') { deleteRef = true; continue; }
      if (arg === '--no-delete') { deleteRef = false; continue; }
      if (arg === '-m' || arg === '--message') {
        if (args[i + 1] === undefined) return { kind: 'unclassified' };
        i++;
        continue;
      }
      if (arg.startsWith('-m') && arg.length > 2) continue;
      if (arg.startsWith('--message=')) continue;
      return { kind: 'unclassified' };
    }
    positionals.push(arg);
  }
  if (deleteRef) {
    if (positionals.length !== 1) return { kind: 'unclassified' };
    return { kind: 'symbolic-write', dir, name: positionals[0], target: null, delete: true };
  }
  if (positionals.length === 1) return { kind: 'symbolic-read' };
  if (positionals.length === 2) return { kind: 'symbolic-write', dir, name: positionals[0], target: positionals[1], delete: false };
  return { kind: 'unclassified' };
}

const WRITE_PRIMITIVE_RE = /(?:>>?|\b(?:tee|rm|mv|cp|dd|patch|truncate|touch|unlink|writeFileSync|writeFile|appendFileSync|appendFile|createWriteStream)\b|\bsed\s+(?:-[a-zA-Z]*i|--in-place)|\bperl\s+-[a-zA-Z]*i|\.write_(?:text|bytes)\(|open\([^)]*['"][wa+])/u;
const READ_ONLY_CMD_RE = /^\s*(?:[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|[^\s;&|]+)\s+)*(?:ls|tail|head|cat|less|more|grep|egrep|fgrep|rg|find|fd|wc|stat|file|du|df|pwd|echo|printf|true|false|which|whereis|type|uname|whoami|id|date|env|printenv|ps|lsof|jq|awk|cut|sort|uniq|tr|diff|shasum|sha256sum|md5|git\s+(?:status|diff|log|show|branch|rev-parse|ls-files|check-ignore| blame)\b|kith\s+(?:status|brief|doctor|mode|lock\s+list|task\s+list|handoff\s+list)\b|(?:node\s+)?(?:\S*\/)?stack\.mjs\s+status\b)/u;

/**
 * True when a shell command is purely observational (e.g. `ls`, `tail`, `git status`, `stack.mjs status`)
 * and contains no file-redirection or write primitives.
 */
export function isReadOnlyShellCommand(command: string): boolean {
  const stripped = command
    .replace(/\b\d*>&\d+\b/g, '')
    .replace(/\b\d*>\s*\/dev\/null\b/g, '')
    .trim();
  if (!stripped) return true;
  if (WRITE_PRIMITIVE_RE.test(stripped)) return false;
  const segments = stripped.split(/(?:&&|\|\||[;|&\n])+/u).map(s => s.trim()).filter(Boolean);
  return segments.length > 0 && segments.every(seg => READ_ONLY_CMD_RE.test(seg));
}

/**
 * True when `command` explicitly references `relPath` (or its filename) and contains a write/mutation
 * indicator. Prevents blaming unrelated or read-only commands for concurrent edits made by the live
 * lock holder in a shared checkout.
 */
export function commandTargetsFileForWrite(command: string, relPath: string): boolean {
  if (isReadOnlyShellCommand(command)) return false;
  const stripped = command
    .replace(/\b\d*>&\d+\b/g, '')
    .replace(/\b\d*>\s*\/dev\/null\b/g, '');
  if (!WRITE_PRIMITIVE_RE.test(stripped)) return false;
  const norm = relPath.replace(/\\/g, '/');
  if (stripped.includes(norm)) return true;
  const base = path.posix.basename(norm);
  return base.length >= 4 && stripped.includes(base);
}

export class BashMerkleGuard {
  constructor(
    private readonly coordDb: CoordDatabase,
    private readonly fencing: FencingAndAgentManager,
    private readonly lockEngine: LockEngine,
    private readonly depGraph: DependencyAndContractEngine,
    private readonly shadowGit: ShadowGitEngine
  ) {}

  /**
   * Checks whether a shell command is safe to execute in the workspace.
   */
  public checkCommandSafety(params: {
    agentId: string;
    command: string;
    inIsolatedWorktree?: boolean;
  }): { safe: boolean; reason?: string; deferred?: boolean } {
    this.fencing.assertSession(params.agentId);
    const agent = this.fencing.getAgent(params.agentId);
    const repoRoot = this.coordDb.repoRoot;
    const root = physicalPath(agent?.worktree_path ?? repoRoot);
    const peers = this.fencing.listAgents(true).filter(a => a.id !== params.agentId);
    const sharesCheckout = peers.some(a => physicalPath(a.worktree_path ?? repoRoot) === root);
    const startDir = agent?.worktree_path ?? repoRoot;
    const refuse = (specific?: string) => ({
      safe: false as const,
      reason: firewallReason(suggestKithCommit(this.refHost(params.agentId), params.command), specific),
    });
    if (peers.length && sharesCheckout && commandMovesSharedCheckout(params.command)) {
      const foreign = foreignRefLease(this.coordDb.coordDir, params.agentId);
      if (foreign) {
        return refuse(`Agent ${foreign.agentId} is verifying a shared-checkout commit; retry shortly.`);
      }
    }
    // Ref updates are refused while any peer is active, except a ref that belongs only to this
    // agent's isolated worktree, or a proved one-commit fast-forward of the caller's own files.
    if (peers.length && DESTRUCTIVE_SHARED_REFS.test(params.command)
      && !sharedRefUpdatesAreOwned(params.command, startDir, agent, peers)) {
      try {
        const decision = assessSharedCheckoutUpdate(this.refHost(params.agentId), params.command, startDir);
        if (decision.action === 'allow') return { safe: true };
        if (decision.action === 'defer') return { safe: true, deferred: true };
        if (decision.action === 'block' && decision.reason) return { safe: false, reason: decision.reason };
      } catch {
        return refuse('The shared-checkout update could not be verified.');
      }
      return refuse();
    }
    if (sharesCheckout && DESTRUCTIVE_SHARED_TREE.test(params.command)) {
      return refuse();
    }
    return { safe: true };
  }

  /**
   * Post-hook half of a deferred shared-checkout update-ref. Literal SHAs are decided in
   * checkCommandSafety; shell variables are checked against the commit that landed.
   */
  public settleDeferredRefUpdate(params: { agentId: string; command: string }): { warnings: string[]; reverted: boolean } {
    return settleDeferredRefUpdate(this.refHost(params.agentId), params.command);
  }

  private refHost(agentId: string): RefHost {
    const agent = this.fencing.getAgent(agentId);
    return {
      repoRoot: this.coordDb.repoRoot,
      coordDir: this.coordDb.coordDir,
      agentId,
      agent,
      locks: this.lockEngine.listLocks(),
      tasks: this.recordedTasks(),
      presenceTouched: presenceTouchedFor(this.coordDb.commonGitDir, agent),
      logEvent: (id, type, payload) => this.coordDb.logEvent(id, type, payload),
    };
  }

  private recordedTasks(): RecordedTask[] {
    try {
      const rows = this.coordDb.db.prepare(
        `SELECT owner_agent_id, status, scope_globs_json FROM tasks`,
      ).all() as Array<{ owner_agent_id: string | null; status: string; scope_globs_json: string }>;
      return rows.map((row) => ({
        owner_agent_id: row.owner_agent_id,
        status: row.status,
        scope_globs: parseScopeGlobs(row.scope_globs_json),
      }));
    } catch {
      return [];
    }
  }

  private getSnapshotFilePath(agentId: string): string {
    const epoch = this.fencing.assertSession(agentId);
    const safeId = crypto.createHash('sha256').update(`${agentId}:${epoch}`).digest('hex');
    return path.join(this.coordDb.coordDir, 'snapshots', `${safeId}.json`);
  }

  /**
   * Captures a Merkle snapshot of workspace files before a Bash tool execution.
   * For any file locked by another active agent, stores a full lossless backup so
   * unauthorized mutations by bash scripts (`sed`, `python`, etc.) can be reverted atomically.
   */
  public capturePreBashSnapshot(agentId: string, rootDir = this.coordDb.repoRoot): string {
    const activeLocks = this.lockEngine
      .listLocks()
      .filter((l) => l.owner_agent_id !== agentId);

    const snapPath = this.getSnapshotFilePath(agentId);
    let prevEntries: Record<string, FileSnapshotEntry> = {};
    if (fs.existsSync(snapPath)) {
      try {
        const parsed = JSON.parse(fs.readFileSync(snapPath, 'utf8')) as { rootDir?: string; entries?: Record<string, FileSnapshotEntry> };
        if (parsed.rootDir === rootDir && parsed.entries) prevEntries = parsed.entries;
      } catch { /* Ignore damaged prior snapshot cache */ }
    }

    const now = Date.now();
    const entries: Record<string, FileSnapshotEntry> = {};
    const files = this.walkWorkspaceFiles(rootDir);

    for (const absPath of files) {
      const relPath = path.relative(rootDir, absPath).replace(/\\/g, '/');
      const stat = fs.statSync(absPath);
      if (stat.size > 5 * 1024 * 1024) continue; // Skip >5MB binaries

      const lockedByOther = activeLocks.some((l) =>
        LockEngine.patternsOverlap(relPath, l.pattern)
      );
      const cached = prevEntries[relPath];
      const unchanged = cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size && stat.mtimeMs < now - 2000;
      if (unchanged && (!lockedByOther || cached.backupContentBase64 !== undefined)) {
        entries[relPath] = {
          ...cached,
          lockedByOther,
          backupContentBase64: lockedByOther ? cached.backupContentBase64 : undefined,
        };
        continue;
      }

      const buf = fs.readFileSync(absPath);
      const sha256 = unchanged ? cached.sha256 : crypto.createHash('sha256').update(buf).digest('hex');

      entries[relPath] = {
        relPath,
        mtimeMs: stat.mtimeMs,
        size: stat.size,
        sha256,
        lockedByOther,
        backupContentBase64: lockedByOther ? buf.toString('base64') : undefined,
      };
    }

    fs.writeFileSync(
      snapPath,
      JSON.stringify({ timestamp: Date.now(), rootDir, entries }),
      { encoding: 'utf8', mode: 0o600 }
    );
    return snapPath;
  }

  /**
   * Compares workspace state after a Bash command completes against the pre-Bash Merkle snapshot.
   * Saves recovery copies of edits to files locked by sibling agents. Restoration is opt-in,
   * and indexes authorized modifications into the AST Contract Blackboard & Dirty-Tree Conflict Radar.
   */
  public verifyPostBashAndQuarantine(params: {
    agentId: string;
    command: string;
    rootDir?: string;
    restoreLockedFiles?: boolean;
  }): BashGuardPostReport {
    const snapPath = this.getSnapshotFilePath(params.agentId);
    if (!fs.existsSync(snapPath)) {
      return { allowed: true, authorizedModifiedFiles: [], quarantinedViolations: [] };
    }

    const rawSnap = JSON.parse(fs.readFileSync(snapPath, 'utf8')) as {
      timestamp: number;
      rootDir: string;
      entries: Record<string, FileSnapshotEntry>;
    };
    const rootDir = params.rootDir ?? rawSnap.rootDir ?? this.coordDb.repoRoot;
    const beforeEntries = rawSnap.entries;

    const currentFiles = this.walkWorkspaceFiles(rootDir);
    const seenCurrentRelPaths = new Set<string>();
    const candidates: Array<{ relPath: string; buf: Buffer | null; prev: FileSnapshotEntry | null }> = [];
    const authorizedModifiedFiles: string[] = [];
    const quarantinedViolations: QuarantineRecord[] = [];

    for (const absPath of currentFiles) {
      const relPath = path.relative(rootDir, absPath).replace(/\\/g, '/');
      seenCurrentRelPaths.add(relPath);
      const stat = fs.statSync(absPath);
      if (stat.size > 5 * 1024 * 1024) continue;

      const prev = beforeEntries[relPath];
      if (prev && prev.mtimeMs === stat.mtimeMs && prev.size === stat.size) {
        continue;
      }

      const buf = fs.readFileSync(absPath);
      const sha256 = crypto.createHash('sha256').update(buf).digest('hex');
      if (prev && prev.sha256 === sha256) {
        continue;
      }

      candidates.push({ relPath, buf, prev: prev ?? null });
    }

    // Also check if any previously existing file was deleted by the bash command
    for (const [relPath, prev] of Object.entries(beforeEntries)) {
      if (!seenCurrentRelPaths.has(relPath)) {
        candidates.push({ relPath, buf: null, prev });
      }
    }

    const ignored = candidates.length
      ? ignoredPaths(rootDir, candidates.map((c) => c.relPath))
      : new Set<string>();
    const physRoot = physicalPath(rootDir);
    const livePeersInCheckout = new Set(
      this.fencing
        .listAgents(true)
        .filter((a) => a.id !== params.agentId && physicalPath(a.worktree_path ?? this.coordDb.repoRoot) === physRoot)
        .map((a) => a.id)
    );
    const myLocks = this.lockEngine.listLocks().filter((l) => l.owner_agent_id === params.agentId);
    const readOnlyCmd = isReadOnlyShellCommand(params.command);

    for (const c of candidates) {
      if (ignored.has(c.relPath)) continue;
      const access = this.lockEngine.checkFileWriteAccess({
        agentId: params.agentId,
        filePath: c.relPath,
      });
      if (!access.allowed) {
        const holderId = access.conflictingLock?.owner_agent_id;
        if (!params.restoreLockedFiles) {
          // When another live agent holds the lock in the same shared checkout, concurrent edits on disk
          // belong to that lock holder unless this command itself explicitly targeted the file for writing.
          if (readOnlyCmd || (holderId && livePeersInCheckout.has(holderId) && !commandTargetsFileForWrite(params.command, c.relPath))) {
            continue;
          }
        }
        const defaultReason = c.buf === null ? 'Deleted file locked by another agent' : 'Locked by another agent';
        quarantinedViolations.push(this.quarantineAndRevertFile({
          agentId: params.agentId,
          command: params.command,
          rootDir,
          relPath: c.relPath,
          unauthorizedBuf: c.buf,
          restoreLockedFiles: params.restoreLockedFiles ?? false,
          prevEntry: c.prev,
          reason: access.reason ?? defaultReason,
        }));
      } else {
        if (readOnlyCmd) continue;
        if (livePeersInCheckout.size > 0 && myLocks.length > 0) {
          const claimedByCaller = myLocks.some((l) => l.pattern !== '**' && LockEngine.patternsOverlap(LockEngine.literalScope(c.relPath), l.pattern));
          if (!claimedByCaller && !commandTargetsFileForWrite(params.command, c.relPath)) {
            continue;
          }
        }
        authorizedModifiedFiles.push(c.relPath);
      }
    }

    // Clean up snapshot file
    try {
      fs.unlinkSync(snapPath);
    } catch {
      // Ignore
    }

    // Update AST contracts and shadow git tree for authorized modifications
    if (authorizedModifiedFiles.length > 0) {
      for (const relFile of authorizedModifiedFiles) {
        const absFile = path.join(rootDir, relFile);
        if (fs.existsSync(absFile) && /\.(ts|tsx|js|jsx|mjs|py)$/.test(relFile)) {
          this.depGraph.recordFileModification(params.agentId, relFile, fs.readFileSync(absFile, 'utf8'));
        }
      }
      this.shadowGit.probeAllActiveConflicts(
        params.agentId,
        authorizedModifiedFiles.map((f) => ({ filePath: f })),
        rootDir
      );
    }

    return {
      allowed: quarantinedViolations.length === 0,
      authorizedModifiedFiles,
      quarantinedViolations,
    };
  }

  private quarantineAndRevertFile(params: {
    agentId: string;
    command: string;
    rootDir: string;
    relPath: string;
    unauthorizedBuf: Buffer | null;
    restoreLockedFiles: boolean;
    prevEntry: FileSnapshotEntry | null;
    reason: string;
  }): QuarantineRecord {
    const id = `quar_${crypto.randomBytes(6).toString('hex')}`;
    const now = Date.now();
    const safeName = params.relPath.replace(/[^a-zA-Z0-9._-]/g, '_');
    const patchPath = path.join(
      this.coordDb.coordDir,
      'quarantine',
      `${id}_${safeName}.quarantine`
    );

    if (params.unauthorizedBuf) {
      fs.writeFileSync(patchPath, params.unauthorizedBuf, { mode: 0o600 });
    } else {
      fs.writeFileSync(patchPath, `[DELETED BY COMMAND: ${params.command}]\n`, { encoding: 'utf8', mode: 0o600 });
    }

    if (params.prevEntry?.backupContentBase64 !== undefined) {
      fs.writeFileSync(patchPath + '.before', Buffer.from(params.prevEntry.backupContentBase64, 'base64'), { mode: 0o600 });
    }
    const absTarget = path.join(params.rootDir, params.relPath);
    if (params.restoreLockedFiles && params.prevEntry === null) {
      // Newly created unauthorized file -> remove it
      if (fs.existsSync(absTarget)) {
        fs.unlinkSync(absTarget);
      }
    } else if (params.restoreLockedFiles && params.prevEntry?.backupContentBase64 !== undefined) {
      // Restore exact pre-command bytes
      fs.mkdirSync(path.dirname(absTarget), { recursive: true });
      fs.writeFileSync(
        absTarget,
        Buffer.from(params.prevEntry.backupContentBase64, 'base64')
      );
    }

    const record: QuarantineRecord = {
      id,
      agent_id: params.agentId,
      command: params.command,
      file_path: params.relPath,
      patch_path: patchPath,
      reason: params.reason,
      created_at: now,
    };

    this.coordDb.withTransaction(() => {
      this.coordDb.db
        .prepare(`
          INSERT INTO quarantine (id, agent_id, command, file_path, patch_path, reason, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `)
        .run(
          record.id,
          record.agent_id,
          record.command,
          record.file_path,
          record.patch_path,
          record.reason,
          record.created_at
        );

      this.coordDb.logEvent(params.agentId, 'bash_mutation_quarantined', {
        filePath: params.relPath,
        command: params.command,
        patchPath,
        reason: params.reason,
      });
    });

    return record;
  }

  private static readonly SKIP_DIRS = new Set([
    '.git', '.coord', 'node_modules', 'dist', 'build', 'out', 'coverage',
    '.next', '.turbo', '.venv', 'venv', '.pytest_cache', '__pycache__', 'target',
  ]);

  private walkWorkspaceFiles(rootDir: string): string[] {
    return walkNonIgnoredFiles({ rootDir, skipDirNames: BashMerkleGuard.SKIP_DIRS });
  }

  public listQuarantined(): QuarantineRecord[] {
    return this.coordDb.db
      .prepare(`SELECT * FROM quarantine ORDER BY created_at DESC`)
      .all() as unknown as QuarantineRecord[];
  }
}

function parseScopeGlobs(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed.filter((entry): entry is string => typeof entry === 'string') : [];
  } catch {
    return [];
  }
}

/**
 * Touched paths from presence.db for this agent. A single process-tree match is included even
 * when the presence row's agent id differs, matching the caller discovery `kith commit` uses.
 * Loaded lazily so the guard does not import the auto-session module during engine startup.
 */
function presenceTouchedFor(commonGitDir: string | null, agent: AgentRecord | null): string[] {
  if (!commonGitDir || !agent) return [];
  try {
    const { listRepoPresence, ownedByCaller } = require('../cli/auto-session.js') as typeof import('../cli/auto-session.js');
    const peers = listRepoPresence(undefined, commonGitDir);
    const touched = new Set<string>();
    for (const peer of peers) {
      if (peer.agentId === agent.id) for (const file of peer.touchedFiles) touched.add(file);
    }
    const byPid = peers.filter((peer) => ownedByCaller(peer.pid, agent.pid));
    if (byPid.length === 1) for (const file of byPid[0]!.touchedFiles) touched.add(file);
    return [...touched];
  } catch {
    return [];
  }
}
