import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { AgentRecord } from './fencing.js';
import type { LockRecord } from './locks.js';
import { isWithin, physicalPath } from './repository.js';
import {
  collectRecordedFiles,
  listDirtyFiles,
  pathRecordedByCaller,
  peerClaimOnPath,
  type RecordedTask,
} from './recorded-files.js';

/**
 * Shared-checkout exception to the Bash ref firewall.
 *
 * A temporary-index commit may advance the shared branch while peers are active only
 * when it is a compare-and-swap fast-forward of exactly one commit, and every path in
 * `git diff-tree -r --name-only` (both sides of a rename, and deletions) is a file this
 * caller has claimed, locked, or recorded the way `kith commit` records files.
 *
 * Literal values are checked before the command runs, so a known-bad update never
 * lands. Shell variables and command substitutions are not executed during that check.
 * The same compare-and-swap shape is allowed through, a short lease keeps other agents
 * from moving the ref, and the post-hook repeats the ownership check on the commit that
 * actually landed. A failure compare-and-swaps the ref back. If that compare-and-swap
 * loses to a later update, the hook says so and does not force the ref.
 */

const LEASE_MS = 30_000;
const GIT_PREFIX = String.raw`\bgit(?:\s+(?:-C|-c|--git-dir|--work-tree)(?:=|\s+)(?:"[^"]*"|'[^']*'|[^\s;&|]+)|\s+--(?:no-pager|literal-pathspecs|no-optional-locks))*\s+`;
export const DESTRUCTIVE_SHARED_REFS = new RegExp(GIT_PREFIX + String.raw`(?:update-ref|symbolic-ref|worktree\s+(?:remove|prune)|branch\s+(?:-[dDmMfF]|--(?:delete|move|force)))\b`);
export const DESTRUCTIVE_SHARED_TREE = new RegExp(GIT_PREFIX + String.raw`(?:reset|clean|checkout|restore|switch|stash|merge|rebase|pull|cherry-pick|revert|am)\b`);

const SAFE_GIT_GLOBALS = new Set([
  '--no-pager', '-P', '--paginate', '-p',
  '--literal-pathspecs', '--no-optional-locks', '--no-replace-objects',
]);
const CHECKOUT_REWRITE = new Set([
  'reset', 'clean', 'checkout', 'restore', 'switch', 'stash', 'merge', 'rebase',
  'pull', 'cherry-pick', 'revert', 'am', 'commit',
]);

const SAFE_REV = /^(?!-)[A-Za-z0-9._/^~:@{}-]+$/;

export interface RefHost {
  repoRoot: string;
  coordDir: string;
  agentId: string;
  agent: AgentRecord | null;
  locks: LockRecord[];
  tasks: RecordedTask[];
  presenceTouched: string[];
  logEvent?: (agentId: string | null, eventType: string, payload: Record<string, unknown>) => void;
}

export interface AssessResult {
  action: 'allow' | 'defer' | 'block' | 'skip';
  reason?: string;
}

interface ShellWord { text: string; expansion: boolean }
type ShellSep = '&&' | '||' | ';' | '|' | '&' | '\n' | 'end';
interface Segment { raw: string; nextSep: ShellSep }
interface CasUpdate {
  dir: string;
  ref: string;
  noDeref: boolean;
  newWord: ShellWord;
  oldWord: ShellWord;
}
interface Scan {
  sawUpdateRef: boolean;
  updates: CasUpdate[];
  failure: string | null;
  checkoutRewrite: boolean;
  otherRefWrite: boolean;
}
interface PendingUpdate { dir: string; ref: string; old: string; noDeref: boolean }
interface PendingFile {
  agentId: string;
  command: string;
  createdAt: number;
  expiresAt: number;
  updates: PendingUpdate[];
}

export function commandMovesSharedCheckout(command: string): boolean {
  return DESTRUCTIVE_SHARED_REFS.test(command)
    || DESTRUCTIVE_SHARED_TREE.test(command)
    || /\bgit(?:\s+\S+)*?\s+commit(?![\w-])/.test(command);
}

export function firewallReason(suggestion: string, specific?: string): string {
  const detail = specific ? `${specific.endsWith('.') ? specific : `${specific}.`} ` : '';
  return `Git operation can replace shared work or refs while peer agents are active. ${detail}To commit only your own files safely while peers are active, run: ${suggestion}`;
}

export function suggestKithCommit(host: RefHost, command: string): string {
  const message = extractCommitMessage(command) ?? '<message>';
  let files: string[] = [];
  try {
    const root = checkoutOf(host).checkout;
    files = collectRecordedFiles({
      worktreeRoot: root,
      callerAgentIds: new Set([host.agentId]),
      locks: host.locks,
      tasks: host.tasks,
      presenceTouched: host.presenceTouched,
      dirtyFiles: listDirtyFiles(root),
    });
  } catch { files = []; }
  const shown = files.slice(0, 20).map(quoteArg);
  const more = files.length > 20 ? ' ...' : '';
  const filePart = shown.length ? ` ${shown.join(' ')}${more}` : ' [files...]';
  return `kith commit -m ${quoteArg(message)}${filePart}`;
}

export function assessSharedCheckoutUpdate(host: RefHost, command: string, startDir: string): AssessResult {
  const place = checkoutOf(host);
  if (!place.shared) return { action: 'skip' };
  let scan: Scan;
  try {
    scan = scanCommand(command, startDir);
  } catch {
    clearSharedRefLease(host.coordDir, host.agentId);
    return block(host, command, 'The ref command could not be parsed.');
  }
  if (!scan.sawUpdateRef) {
    clearSharedRefLease(host.coordDir, host.agentId);
    return { action: 'skip' };
  }
  if (scan.updates.length > 1) scan.failure = scan.failure ?? 'Multiple update-ref commands cannot be verified together.';
  if (scan.updates.length >= 1 && (scan.checkoutRewrite || scan.otherRefWrite)) {
    scan.failure = scan.failure ?? 'The command mixes update-ref with another ref or checkout rewrite.';
  }
  if (scan.failure || scan.updates.length !== 1) {
    clearSharedRefLease(host.coordDir, host.agentId);
    return block(host, command, scan.failure ?? 'The update-ref command could not be verified.');
  }
  const verdict = verifyCandidate(host, place.checkout, scan.updates[0]!);
  if (!verdict.ok) {
    clearSharedRefLease(host.coordDir, host.agentId);
    return block(host, command, verdict.reason);
  }
  if (verdict.defer) {
    writeLease(host, {
      agentId: host.agentId,
      command,
      createdAt: Date.now(),
      expiresAt: Date.now() + LEASE_MS,
      updates: [{ dir: verdict.dir, ref: verdict.ref, old: verdict.old, noDeref: verdict.noDeref }],
    });
    return { action: 'defer' };
  }
  clearSharedRefLease(host.coordDir, host.agentId);
  return { action: 'allow' };
}

/** Directories of compare-and-swap update-ref commands, including ones whose values are shell expansions. */
export function casCommandDirectories(command: string, startDir: string): string[] {
  try {
    const scan = scanCommand(command, startDir);
    if (scan.failure || scan.checkoutRewrite || scan.otherRefWrite || scan.updates.length !== 1) return [];
    return [scan.updates[0]!.dir];
  } catch {
    return [];
  }
}

export function settleDeferredRefUpdate(host: RefHost, command: string): { warnings: string[]; reverted: boolean } {
  const pending = readLease(host.coordDir, host.agentId);
  if (!pending || pending.command !== command) return { warnings: [], reverted: false };
  clearSharedRefLease(host.coordDir, host.agentId);
  const warnings: string[] = [];
  let reverted = false;
  const suggestion = suggestKithCommit(host, command);
  for (const update of pending.updates) {
    if (!isSafeHeadRef(update.ref) || !isFullSha(update.old)) {
      warnings.push(`[KITH BASH FIREWALL] Dropped an unreadable shared-checkout update record for ${host.agentId}.`);
      continue;
    }
    const current = readCommitRef(update.dir, update.ref);
    if (!current) {
      warnings.push(`[KITH BASH FIREWALL] Could not read ${update.ref} after update-ref. To commit only your own files safely while peers are active, run: ${suggestion}`);
      continue;
    }
    if (current === update.old) continue;
    const verdict = verifyFastForward(host, update.dir, current, update.old);
    if (verdict.ok) continue;
    const didRevert = revertRef(update, current);
    reverted = reverted || didRevert;
    const action = didRevert
      ? `Reverted ${update.ref} from ${short(current)} to ${short(update.old)}`
      : `Could not revert ${update.ref} from ${short(current)} to ${short(update.old)} because a later update won the compare-and-swap`;
    warnings.push(`[KITH BASH FIREWALL] ${action}: ${verdict.reason} To commit only your own files safely while peers are active, run: ${suggestion}`);
    host.logEvent?.(host.agentId, didRevert ? 'shared_ref_update_reverted' : 'shared_ref_update_revert_failed', {
      ref: update.ref,
      from: current,
      to: update.old,
      reason: verdict.reason,
    });
  }
  return { warnings, reverted };
}

export function foreignRefLease(coordDir: string, agentId: string): { agentId: string } | null {
  for (const pending of listLeases(coordDir)) {
    if (pending.agentId !== agentId) return { agentId: pending.agentId };
  }
  return null;
}

export function waitForSharedRefLease(coordDir: string, agentId: string | null, timeoutMs = 15_000): string | null {
  const started = Date.now();
  while (true) {
    const foreign = foreignRefLease(coordDir, agentId ?? '');
    if (!foreign) return null;
    if (Date.now() - started >= timeoutMs) {
      return `Timed out waiting for agent ${foreign.agentId} to finish verifying a shared-checkout commit. Retry shortly.`;
    }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 40);
  }
}

export function clearSharedRefLease(coordDir: string, agentId: string): void {
  try { fs.unlinkSync(leasePath(coordDir, agentId)); } catch { /* already gone */ }
}

function block(host: RefHost, command: string, specific: string): AssessResult {
  return { action: 'block', reason: firewallReason(suggestKithCommit(host, command), specific) };
}

function checkoutOf(host: RefHost): { shared: boolean; checkout: string } {
  let checkout = host.repoRoot;
  try { checkout = physicalPath(host.agent?.worktree_path ?? host.repoRoot); }
  catch { return { shared: false, checkout: host.repoRoot }; }
  if (!host.agent?.worktree_path) return { shared: true, checkout };
  const main = mainCheckout(checkout);
  if (!main) return { shared: false, checkout };
  return { shared: main.path === checkout, checkout };
}

function verifyCandidate(
  host: RefHost,
  checkout: string,
  update: CasUpdate,
): { ok: true; defer: false } | { ok: true; defer: true; dir: string; ref: string; old: string; noDeref: boolean } | { ok: false; reason: string } {
  if (!directoryInside(update.dir, checkout)) {
    return { ok: false, reason: 'update-ref runs outside this shared checkout' };
  }
  if (!isSafeHeadRef(update.ref)) return { ok: false, reason: 'The ref must be a literal HEAD or refs/heads/<current branch>.' };
  const checked = checkedOutBranch(update.dir);
  if (!checked.ok) return { ok: false, reason: 'The current branch could not be read.' };
  const currentBranch = checked.branch ? `refs/heads/${checked.branch}` : null;
  if (update.ref !== 'HEAD' && update.ref !== currentBranch) {
    return { ok: false, reason: `Ref ${update.ref} is not HEAD or the current branch${currentBranch ? ` (${currentBranch})` : ''}.` };
  }
  if (update.noDeref && symbolicRef(update.dir, update.ref)) {
    return { ok: false, reason: '--no-deref would update the symbolic ref itself instead of fast-forwarding the branch.' };
  }
  const current = readCommitRef(update.dir, update.ref);
  if (!current) return { ok: false, reason: `The current value of ${update.ref} could not be read.` };

  if (!update.oldWord.expansion) {
    const old = resolveCommit(update.dir, update.oldWord.text);
    if (!old.ok) return { ok: false, reason: `Compare-and-swap old value ${old.reason}` };
    if (old.sha !== current) {
      return { ok: false, reason: `Compare-and-swap old value ${short(old.sha)} does not equal current ${update.ref} (${short(current)}).` };
    }
  }

  if (!update.newWord.expansion) {
    const created = resolveCommit(update.dir, update.newWord.text);
    if (!created.ok) return { ok: false, reason: `New value ${created.reason}` };
    const ff = verifyFastForward(host, checkout, created.sha, current);
    if (!ff.ok) return ff;
    if (update.oldWord.expansion) {
      return { ok: true, defer: true, dir: update.dir, ref: update.ref, old: current, noDeref: update.noDeref };
    }
    return { ok: true, defer: false };
  }

  return { ok: true, defer: true, dir: update.dir, ref: update.ref, old: current, noDeref: update.noDeref };
}

function verifyFastForward(
  host: RefHost,
  checkout: string,
  newSha: string,
  oldSha: string,
): { ok: true } | { ok: false; reason: string } {
  const parents = commitParents(checkout, newSha);
  if (!parents) return { ok: false, reason: 'The new commit could not be read.' };
  if (parents.length === 0) return { ok: false, reason: 'New commit has no parent (not a one-commit fast-forward).' };
  if (parents.length > 1) {
    return { ok: false, reason: `New commit is a merge (${parents.length} parents); only a one-commit fast-forward is allowed.` };
  }
  if (parents[0] !== oldSha) {
    return { ok: false, reason: `New commit parent ${short(parents[0]!)} is not ${short(oldSha)} (not a one-commit fast-forward).` };
  }
  const paths = changedPaths(checkout, oldSha, newSha);
  if (!paths) return { ok: false, reason: 'The commit diff could not be read.' };
  const caller = new Set([host.agentId]);
  const problems: string[] = [];
  for (const rel of paths) {
    const peer = peerClaimOnPath({ relPath: rel, callerAgentIds: caller, locks: host.locks });
    if (peer) {
      problems.push(`path ${rel} is claimed by agent ${peer.agentId}`);
      continue;
    }
    if (!pathRecordedByCaller({
      worktreeRoot: checkout,
      relPath: rel,
      callerAgentIds: caller,
      locks: host.locks,
      tasks: host.tasks,
      presenceTouched: host.presenceTouched,
    })) {
      problems.push(`path ${rel} is not claimed, locked, or recorded by this session`);
    }
  }
  if (problems.length === 0) return { ok: true };
  const shown = problems.slice(0, 5).join('; ');
  const more = problems.length > 5 ? `; and ${problems.length - 5} more` : '';
  return { ok: false, reason: `${shown}${more}` };
}

function resolveCommit(dir: string, rev: string): { ok: true; sha: string } | { ok: false; reason: string } {
  if (!isSafeRev(rev)) return { ok: false, reason: 'is not a literal commit.' };
  const type = git(dir, ['cat-file', '-t', '--end-of-options', rev]);
  if (type !== 'commit') {
    return { ok: false, reason: type ? `resolves to a ${type}, not a commit.` : 'does not resolve to a commit.' };
  }
  const sha = git(dir, ['rev-parse', '--verify', '--end-of-options', `${rev}^{commit}`]);
  if (!sha || !isFullSha(sha)) return { ok: false, reason: 'does not resolve to a commit.' };
  return { ok: true, sha };
}

function commitParents(dir: string, sha: string): string[] | null {
  if (!isFullSha(sha)) return null;
  const text = gitRaw(dir, ['cat-file', '-p', '--end-of-options', sha]);
  if (text === null) return null;
  const parents: string[] = [];
  for (const line of text.split('\n')) {
    if (line === '') break;
    if (!line.startsWith('parent ')) continue;
    const parent = line.slice('parent '.length).trim();
    if (!isFullSha(parent)) return null;
    parents.push(parent);
  }
  return parents;
}

/** `--no-renames` keeps both sides of a rename. `git diff-tree -M --name-only` would drop the source. */
function changedPaths(dir: string, oldSha: string, newSha: string): string[] | null {
  if (!isFullSha(oldSha) || !isFullSha(newSha)) return null;
  const out = gitRaw(dir, [
    'diff-tree', '-r', '-z', '--name-only', '--no-renames', '--end-of-options', oldSha, newSha,
  ]);
  if (out === null) return null;
  return [...new Set(out.split('\0').filter(Boolean).map((entry) => entry.replace(/\\/g, '/')))];
}

function revertRef(update: PendingUpdate, current: string): boolean {
  if (!isSafeHeadRef(update.ref) || !isFullSha(update.old) || !isFullSha(current)) return false;
  const args = ['update-ref'];
  if (update.noDeref) args.push('--no-deref');
  args.push('-m', 'kith: revert shared-checkout update that failed ownership checks', update.ref, update.old, current);
  try {
    execFileSync('git', args, { cwd: update.dir, stdio: ['ignore', 'pipe', 'pipe'], timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

function readCommitRef(dir: string, ref: string): string | null {
  if (!isSafeHeadRef(ref)) return null;
  const sha = git(dir, ['rev-parse', '--verify', '--end-of-options', ref]);
  return sha && isFullSha(sha) ? sha : null;
}

function symbolicRef(dir: string, ref: string): string | null {
  if (!isSafeHeadRef(ref)) return null;
  const value = git(dir, ['symbolic-ref', '-q', '--end-of-options', ref]);
  return value || null;
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

function directoryInside(dir: string, root: string): boolean {
  try {
    const resolved = physicalPath(dir);
    const base = physicalPath(root);
    return resolved === base || isWithin(base, resolved);
  } catch { return false; }
}

function git(dir: string, args: string[]): string | null {
  const out = gitRaw(dir, args);
  return out === null ? null : out.trim();
}

function gitRaw(dir: string, args: string[]): string | null {
  try {
    return execFileSync('git', args, {
      cwd: dir,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 5000,
      maxBuffer: 8 * 1024 * 1024,
    });
  } catch {
    return null;
  }
}

function isFullSha(value: string): boolean {
  return /^[0-9a-f]{40}$/.test(value);
}

function isSafeRev(rev: string): boolean {
  return rev.length > 0 && rev.length < 200 && SAFE_REV.test(rev) && !rev.includes('..');
}

function isSafeHeadRef(ref: string): boolean {
  if (ref === 'HEAD') return true;
  if (!ref.startsWith('refs/heads/')) return false;
  const name = ref.slice('refs/heads/'.length);
  if (!name || name.startsWith('/') || name.endsWith('/') || name.includes('..') || name.includes('@{')) return false;
  return /^[A-Za-z0-9._/-]+$/.test(name);
}

function short(sha: string): string {
  return sha.length > 12 ? sha.slice(0, 12) : sha;
}

function leasePath(coordDir: string, agentId: string): string {
  const name = crypto.createHash('sha256').update(agentId).digest('hex') + '.json';
  return path.join(coordDir, 'ref-guards', name);
}

function writeLease(host: RefHost, pending: PendingFile): void {
  const dir = path.join(host.coordDir, 'ref-guards');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const target = leasePath(host.coordDir, host.agentId);
  const tmp = `${target}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(pending), { mode: 0o600 });
  fs.renameSync(tmp, target);
}

function readLease(coordDir: string, agentId: string): PendingFile | null {
  return listLeases(coordDir).find((pending) => pending.agentId === agentId) ?? null;
}

function listLeases(coordDir: string): PendingFile[] {
  const dir = path.join(coordDir, 'ref-guards');
  let names: string[] = [];
  try { names = fs.readdirSync(dir); } catch { return []; }
  const now = Date.now();
  const pending: PendingFile[] = [];
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    const file = path.join(dir, name);
    let parsed: PendingFile | null = null;
    try { parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as PendingFile; } catch { parsed = null; }
    if (!parsed || typeof parsed.agentId !== 'string' || !Array.isArray(parsed.updates) || typeof parsed.expiresAt !== 'number') {
      try { fs.unlinkSync(file); } catch { /* ignore */ }
      continue;
    }
    if (parsed.expiresAt <= now) {
      try { fs.unlinkSync(file); } catch { /* ignore */ }
      continue;
    }
    pending.push(parsed);
  }
  return pending;
}

function extractCommitMessage(command: string): string | null {
  const fromTree = flagMessage(command, 'commit-tree');
  if (fromTree) return subject(fromTree);
  const fromRef = flagMessage(command, 'update-ref');
  if (!fromRef) return null;
  return subject(fromRef.replace(/^commit:\s*/, ''));
}

function flagMessage(command: string, subcommand: string): string | null {
  const re = new RegExp(String.raw`\b${subcommand}\b[\s\S]{0,500}?(?:-m|--message)(?:=|\s+)(?:'([^']*)'|"([^"]*)"|(\S+))`);
  const match = re.exec(command);
  const text = match?.[1] ?? match?.[2] ?? match?.[3];
  const trimmed = text?.trim();
  return trimmed ? trimmed : null;
}

function subject(message: string): string | null {
  const line = message.split(/\r?\n/, 1)[0]?.trim() ?? '';
  if (!line) return null;
  return line.length > 200 ? `${line.slice(0, 200)}…` : line;
}

function quoteArg(value: string): string {
  if (/^[A-Za-z0-9._@/:+=,-]+$/.test(value)) return value;
  if (!/["\\$`]/.test(value)) return `"${value}"`;
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

function scanCommand(command: string, startDir: string): Scan {
  const scan: Scan = { sawUpdateRef: false, updates: [], failure: null, checkoutRewrite: false, otherRefWrite: false };
  const segments = splitShellSegments(command);
  if (!segments) {
    scan.sawUpdateRef = /\bupdate-ref\b/.test(command);
    scan.failure = 'The ref command could not be parsed.';
    return scan;
  }
  let cwd = path.resolve(startDir);
  let untrusted = false;
  for (const segment of segments) {
    const matched = DESTRUCTIVE_SHARED_REFS.test(segment.raw);
    const sawRef = /\bupdate-ref\b/.test(segment.raw);
    if (sawRef) scan.sawUpdateRef = true;
    const words = tokenizeShell(segment.raw);
    if (!words) {
      if (matched || sawRef) scan.failure = scan.failure ?? 'The ref command could not be parsed.';
      if (continuesShell(segment.nextSep) && /\b(?:cd|pushd|popd|export|source)\b|\bGIT_DIR\b/.test(segment.raw)) untrusted = true;
      continue;
    }
    const { danger, argv } = stripLeadingEnv(words);
    if (argv.length === 0) continue;
    const head = argv[0]!;
    if (!head.expansion && head.text === 'cd') {
      const next = applyCd(argv, cwd);
      if (next && continuesShell(segment.nextSep)) cwd = next;
      else if (!next && continuesShell(segment.nextSep)) untrusted = true;
      continue;
    }
    if (!head.expansion && (head.text === 'pushd' || head.text === 'popd' || head.text === 'source' || (head.text === '.' && argv.length > 1))) {
      if (continuesShell(segment.nextSep)) untrusted = true;
      continue;
    }
    if (!head.expansion && head.text === 'export') {
      if (argv.slice(1).some((arg) => dangerousGitEnv(assignmentName(arg) ?? arg.text))) untrusted = true;
      continue;
    }
    if (head.expansion || !isGitBinary(head.text) || danger || untrusted) {
      if (matched || sawRef) {
        scan.failure = scan.failure ?? (untrusted || danger
          ? 'update-ref follows a directory or GIT_DIR change that could not be resolved.'
          : 'The ref command could not be classified.');
      }
      continue;
    }
    const parsed = parseLooseGit(argv, cwd);
    if (parsed.kind === 'unclassified') {
      if (matched || sawRef) scan.failure = scan.failure ?? 'The ref command could not be classified.';
      continue;
    }
    if (parsed.sub === 'update-ref') {
      scan.sawUpdateRef = true;
      const cas = parseCas(parsed.dir, parsed.args);
      if (cas.failure) scan.failure = scan.failure ?? cas.failure;
      if (cas.update) scan.updates.push(cas.update);
      continue;
    }
    if (parsed.sub === 'symbolic-ref') {
      const kind = classifySymbolic(parsed.args);
      if (kind !== 'read') scan.otherRefWrite = true;
      continue;
    }
    if (parsed.sub === 'worktree' && matched) { scan.otherRefWrite = true; continue; }
    if (parsed.sub === 'branch' && matched) { scan.otherRefWrite = true; continue; }
    if (CHECKOUT_REWRITE.has(parsed.sub)) scan.checkoutRewrite = true;
  }
  return scan;
}

function parseCas(dir: string, args: ShellWord[]): { update?: CasUpdate; failure?: string } {
  let noDeref = false;
  let deleteRef = false;
  let stdin = false;
  let end = false;
  const positionals: ShellWord[] = [];
  for (let i = 0; i < args.length; i++) {
    const word = args[i]!;
    if (!end && !word.expansion && word.text === '--') { end = true; continue; }
    if (!end && !word.expansion && word.text.startsWith('-')) {
      const arg = word.text;
      if (arg === '--no-deref') { noDeref = true; continue; }
      if (arg === '--deref') { noDeref = false; continue; }
      if (arg === '--create-reflog' || arg === '--no-create-reflog' || arg === '--no-stdin') continue;
      if (arg === '--stdin' || arg === '-z') { stdin = true; continue; }
      if (arg === '-d' || arg === '--delete') { deleteRef = true; continue; }
      if (arg === '-m' || arg === '--message') {
        if (args[i + 1] === undefined) return { failure: 'update-ref -m is missing its message.' };
        i++;
        continue;
      }
      if ((arg.startsWith('-m') && arg.length > 2) || arg.startsWith('--message=')) continue;
      return { failure: `Unrecognized update-ref option '${arg}'.` };
    }
    positionals.push(word);
  }
  if (stdin) return { failure: 'update-ref --stdin batches cannot be verified before they run.' };
  if (deleteRef) return { failure: 'Deleting a ref is not a one-commit fast-forward.' };
  if (positionals.length === 2) return { failure: 'No compare-and-swap old value.' };
  if (positionals.length !== 3 || !positionals[0]) return { failure: 'update-ref is missing a ref or value.' };
  const ref = positionals[0];
  if (ref.expansion || !ref.text) return { failure: 'The ref must be a literal HEAD or refs/heads/<current branch>.' };
  return {
    update: { dir, ref: ref.text, noDeref, newWord: positionals[1]!, oldWord: positionals[2]! },
  };
}

function classifySymbolic(args: ShellWord[]): 'read' | 'write' | 'unknown' {
  let deleteRef = false;
  let end = false;
  const positionals: ShellWord[] = [];
  for (let i = 0; i < args.length; i++) {
    const word = args[i]!;
    if (!end && !word.expansion && word.text === '--') { end = true; continue; }
    if (!end && !word.expansion && word.text.startsWith('-')) {
      const arg = word.text;
      if (arg === '-q' || arg === '--quiet' || arg === '--no-quiet' || arg === '--short' || arg === '--no-short') continue;
      if (arg === '--recurse' || arg === '--no-recurse') continue;
      if (arg === '-d' || arg === '--delete') { deleteRef = true; continue; }
      if (arg === '--no-delete') { deleteRef = false; continue; }
      if (arg === '-m' || arg === '--message') {
        if (args[i + 1] === undefined) return 'unknown';
        i++;
        continue;
      }
      if ((arg.startsWith('-m') && arg.length > 2) || arg.startsWith('--message=')) continue;
      return 'unknown';
    }
    if (word.expansion) return 'unknown';
    positionals.push(word);
  }
  if (deleteRef) return positionals.length === 1 ? 'write' : 'unknown';
  if (positionals.length === 1) return 'read';
  if (positionals.length === 2) return 'write';
  return 'unknown';
}

function parseLooseGit(argv: ShellWord[], cwd: string): { kind: 'unclassified' } | { kind: 'git'; dir: string; sub: string; args: ShellWord[] } {
  let i = 1;
  let dir = cwd;
  while (i < argv.length) {
    const token = argv[i]!;
    if (token.expansion) return { kind: 'unclassified' };
    const text = token.text;
    if (text === '--') { i++; break; }
    if (text === '-C') {
      const next = argv[i + 1];
      if (!next || next.expansion || next.text.startsWith('~')) return { kind: 'unclassified' };
      if (next.text !== '') dir = path.isAbsolute(next.text) ? next.text : path.resolve(dir, next.text);
      i += 2;
      continue;
    }
    if (text.startsWith('-C') && text.length > 2) {
      const next = text.slice(2);
      if (next.startsWith('~')) return { kind: 'unclassified' };
      dir = path.isAbsolute(next) ? next : path.resolve(dir, next);
      i++;
      continue;
    }
    if (SAFE_GIT_GLOBALS.has(text)) { i++; continue; }
    if (text.startsWith('-')) return { kind: 'unclassified' };
    break;
  }
  const sub = argv[i];
  if (!sub || sub.expansion) return { kind: 'unclassified' };
  return { kind: 'git', dir, sub: sub.text, args: argv.slice(i + 1) };
}

function stripLeadingEnv(words: ShellWord[]): { danger: boolean; argv: ShellWord[] } {
  let i = 0;
  let danger = false;
  while (i < words.length) {
    const name = assignmentName(words[i]!);
    if (!name) break;
    if (dangerousGitEnv(name)) danger = true;
    i++;
  }
  return { danger, argv: words.slice(i) };
}

function assignmentName(word: ShellWord): string | null {
  const eq = word.text.indexOf('=');
  if (eq <= 0) return null;
  const name = word.text.slice(0, eq);
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(name) ? name : null;
}

function dangerousGitEnv(name: string): boolean {
  return name === 'GIT_DIR' || name === 'GIT_WORK_TREE' || name === 'GIT_COMMON_DIR'
    || name === 'GIT_NAMESPACE' || name === 'GIT_OBJECT_DIRECTORY' || name === 'GIT_ALTERNATE_OBJECT_DIRECTORIES'
    || name === 'GIT_CONFIG_PARAMETERS' || name === 'GIT_CONFIG_COUNT' || name === 'GIT_CONFIG_GLOBAL'
    || name === 'GIT_CONFIG_SYSTEM' || /^GIT_CONFIG_(?:KEY|VALUE)_\d+$/.test(name);
}

function applyCd(argv: ShellWord[], cwd: string): string | null {
  let args = argv.slice(1);
  if (args[0] && !args[0].expansion && args[0].text === '--') args = args.slice(1);
  if (args.length !== 1 || !args[0] || args[0].expansion) return null;
  const target = args[0].text;
  if (target === '-' || target.startsWith('-') || target.startsWith('~')) return null;
  return path.resolve(cwd, target);
}

function isGitBinary(word: string): boolean {
  const base = word.slice(Math.max(word.lastIndexOf('/'), word.lastIndexOf('\\')) + 1);
  return base === 'git' || base.toLowerCase() === 'git.exe';
}

function continuesShell(sep: ShellSep): boolean {
  return sep === '&&' || sep === ';' || sep === '\n';
}

function splitShellSegments(command: string): Segment[] | null {
  const parts: Segment[] = [];
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

function tokenizeShell(segment: string): ShellWord[] | null {
  const words: ShellWord[] = [];
  let buf = '';
  let expansion = false;
  let quote: "'" | '"' | null = null;
  let word = false;
  const flush = () => {
    if (word) words.push({ text: buf, expansion });
    buf = '';
    expansion = false;
    word = false;
  };
  const mark = (text: string) => { buf += text; word = true; expansion = true; };
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
      if (ch === '`') {
        const end = segment.indexOf('`', i + 1);
        if (end < 0) return null;
        mark(segment.slice(i, end + 1));
        i = end;
        continue;
      }
      if (ch === '$') {
        const consumed = consumeExpansion(segment, i);
        if (!consumed) return null;
        mark(consumed.text);
        i = consumed.end - 1;
        continue;
      }
      buf += ch;
      word = true;
      continue;
    }
    if (ch === '\\' && i + 1 < segment.length) { buf += segment[i + 1]; word = true; i++; continue; }
    if (ch === "'" || ch === '"') { quote = ch; word = true; continue; }
    if (ch === '`') {
      const end = segment.indexOf('`', i + 1);
      if (end < 0) return null;
      mark(segment.slice(i, end + 1));
      i = end;
      continue;
    }
    if (ch === '$') {
      const consumed = consumeExpansion(segment, i);
      if (!consumed) return null;
      mark(consumed.text);
      i = consumed.end - 1;
      continue;
    }
    if (ch === '(' || ch === ')' || ch === '<' || ch === '>') return null;
    if (ch === '#' && !word) break;
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') { flush(); continue; }
    buf += ch;
    word = true;
  }
  if (quote) return null;
  flush();
  return words;
}

function consumeExpansion(segment: string, i: number): { text: string; end: number } | null {
  const next = segment[i + 1];
  if (next === '(') {
    let depth = 1;
    let quoted: "'" | '"' | null = null;
    for (let j = i + 2; j < segment.length; j++) {
      const ch = segment[j];
      if (quoted === "'") { if (ch === "'") quoted = null; continue; }
      if (quoted === '"') {
        if (ch === '\\' && j + 1 < segment.length) { j++; continue; }
        if (ch === '"') quoted = null;
        continue;
      }
      if (ch === '\\') { j++; continue; }
      if (ch === "'" || ch === '"') { quoted = ch; continue; }
      if (ch === '`') {
        const end = segment.indexOf('`', j + 1);
        if (end < 0) return null;
        j = end;
        continue;
      }
      if (ch === '(') depth++;
      else if (ch === ')') {
        depth--;
        if (depth === 0) return { text: segment.slice(i, j + 1), end: j + 1 };
      }
    }
    return null;
  }
  if (next === '{') {
    let depth = 1;
    for (let j = i + 2; j < segment.length; j++) {
      if (segment[j] === '{') depth++;
      else if (segment[j] === '}') {
        depth--;
        if (depth === 0) return { text: segment.slice(i, j + 1), end: j + 1 };
      }
    }
    return null;
  }
  if (next && /[A-Za-z_]/.test(next)) {
    let j = i + 2;
    while (j < segment.length && /[A-Za-z0-9_]/.test(segment[j])) j++;
    return { text: segment.slice(i, j), end: j };
  }
  return null;
}
