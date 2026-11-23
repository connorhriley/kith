import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { CoordDatabase } from './db.js';
import type { AgentRecord, FencingAndAgentManager } from './fencing.js';
import { discoverRepository, isWithin, physicalPath } from './repository.js';

export type WorktreeProvenance = 'created' | 'adopted';
export type WorktreeSource = 'kith' | 'claude-code' | 'external';

export interface ListedWorktree {
  path: string;
  head: string;
  branch: string | null;
  detached: boolean;
  locked: boolean;
  lockReason: string | null;
}

export interface WorktreeRegistration {
  agentId: string;
  worktreePath: string;
  provenance: WorktreeProvenance;
  source: WorktreeSource;
  branch: string | null;
  head: string | null;
  detached: boolean;
  dirty: boolean;
  branchCheckedOutElsewhere: boolean;
  registeredAt: number;
}

/** A workspace binding stored for the agent. `branch` is null when HEAD is detached. */
export interface WorktreeBinding {
  agentId: string;
  worktreePath: string;
  branch: string | null;
  hydrationMethod: 'apfs-cow' | 'reflink-cow' | 'copy' | 'none';
  hydratedDirs: string[];
  durationMs: number;
  provenance: WorktreeProvenance;
  source: WorktreeSource;
  detached: boolean;
  dirty: boolean;
  branchCheckedOutElsewhere: boolean;
  alreadyRegistered: boolean;
  notes: string[];
}

export interface LiveAdoption {
  worktreePath: string;
  branch: string | null;
  detached: boolean;
  dirty: boolean;
  branchCheckedOutElsewhere: boolean;
  source: WorktreeSource;
  provenance: 'adopted';
  /** Set when integration must not run. The worktree is left unchanged. */
  integrationError: string | null;
  /** Set when `kith commit` must not move a branch another checkout is using. */
  commitError: string | null;
}

interface Inspection {
  checkoutRoot: string;
  branch: string | null;
  head: string;
  detached: boolean;
  dirty: boolean;
  branchCheckedOutElsewhere: boolean;
  source: WorktreeSource;
  provenance: WorktreeProvenance;
  locked: boolean;
  lockReason: string | null;
}

const REGISTRATION_SQL = `SELECT agent_id, worktree_path, provenance, source, branch, head, detached, dirty, branch_elsewhere, registered_at
  FROM worktree_registrations`;

export function detachedIntegrationError(): string {
  return 'Adopted worktree HEAD is detached. Check out a branch before integrating. The worktree was left unchanged.';
}

export function branchElsewhereError(branch: string): string {
  return `Branch '${branch}' is checked out in another worktree. Integration and kith commit are refused until this worktree is the only checkout of that branch. The worktree was left unchanged.`;
}

export function parseWorktreePorcelain(output: string): ListedWorktree[] {
  const entries: ListedWorktree[] = [];
  let current: ListedWorktree | null = null;
  const push = () => { if (current) entries.push(current); };
  for (const line of output.split(/\r?\n/)) {
    if (!line) continue;
    if (line.startsWith('worktree ')) {
      push();
      current = { path: line.slice('worktree '.length).trim(), head: '', branch: null, detached: false, locked: false, lockReason: null };
    } else if (!current) {
      continue;
    } else if (line.startsWith('HEAD ')) {
      current.head = line.slice('HEAD '.length).trim();
    } else if (line.startsWith('branch ')) {
      current.branch = line.slice('branch '.length).replace(/^refs\/heads\//, '').trim() || null;
    } else if (line === 'detached') {
      current.detached = true;
      current.branch = null;
    } else if (line === 'locked' || line.startsWith('locked ')) {
      current.locked = true;
      const reason = line.slice('locked'.length).trim();
      current.lockReason = reason || null;
    }
  }
  push();
  return entries;
}

export function listGitWorktrees(repoRoot: string): ListedWorktree[] {
  try {
    const out = execFileSync('git', ['worktree', 'list', '--porcelain'], {
      cwd: repoRoot, encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'pipe'],
    });
    return parseWorktreePorcelain(out);
  } catch {
    return [];
  }
}

export function branchIsCheckedOutElsewhere(entries: ListedWorktree[], worktreePath: string, branch: string | null): boolean {
  if (!branch) return false;
  let here: string;
  try { here = physicalPath(worktreePath); } catch { here = path.resolve(worktreePath); }
  return entries.some(entry => {
    if (entry.branch !== branch) return false;
    try { return physicalPath(entry.path) !== here; } catch { return path.resolve(entry.path) !== here; }
  });
}

export function kithWorktreesRoot(coord: CoordDatabase): string {
  return physicalPath(path.join(coord.coordDir, 'worktrees'));
}

export function isKithOwnedWorktree(coord: CoordDatabase, worktreePath: string): boolean {
  try {
    const root = kithWorktreesRoot(coord);
    const target = physicalPath(worktreePath);
    return target !== root && isWithin(root, target);
  } catch {
    return false;
  }
}

/** The non-linked checkout of the repository that contains `start`. */
export function primaryCheckoutOf(start: string): string {
  const layout = discoverRepository(start);
  if (!layout.commonGitDir || !layout.isLinkedWorktree) return layout.checkoutRoot;
  for (const entry of listGitWorktrees(layout.checkoutRoot)) {
    try {
      const item = discoverRepository(entry.path);
      if (!item.isLinkedWorktree && item.commonGitDir === layout.commonGitDir) return item.checkoutRoot;
    } catch { /* Skip entries git can list but not open. */ }
  }
  return layout.checkoutRoot;
}

export function registrationFromRow(row: {
  agent_id: string; worktree_path: string; provenance: string; source: string;
  branch: string | null; head: string | null; detached: number | boolean; dirty: number | boolean;
  branch_elsewhere: number | boolean; registered_at: number;
}): WorktreeRegistration {
  const source: WorktreeSource = row.source === 'kith' || row.source === 'claude-code' ? row.source : 'external';
  return {
    agentId: row.agent_id,
    worktreePath: row.worktree_path,
    provenance: row.provenance === 'created' ? 'created' : 'adopted',
    source,
    branch: row.branch,
    head: row.head,
    detached: Boolean(row.detached),
    dirty: Boolean(row.dirty),
    branchCheckedOutElsewhere: Boolean(row.branch_elsewhere),
    registeredAt: Number(row.registered_at),
  };
}

function registrationsTable(coord: CoordDatabase): boolean {
  return Boolean(coord.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='worktree_registrations'").get());
}

export function readRegistration(coord: CoordDatabase, agentId: string): WorktreeRegistration | null {
  if (!registrationsTable(coord)) return null;
  const row = coord.db.prepare(`${REGISTRATION_SQL} WHERE agent_id = ?`).get(agentId) as Parameters<typeof registrationFromRow>[0] | undefined;
  return row ? registrationFromRow(row) : null;
}

export function listRegistrations(coord: CoordDatabase): WorktreeRegistration[] {
  if (!registrationsTable(coord)) return [];
  return (coord.db.prepare(`${REGISTRATION_SQL} ORDER BY registered_at`).all() as Parameters<typeof registrationFromRow>[0][])
    .map(registrationFromRow);
}

export function clearRegistration(coord: CoordDatabase, agentId: string): void {
  if (!registrationsTable(coord)) return;
  coord.db.prepare('DELETE FROM worktree_registrations WHERE agent_id = ?').run(agentId);
}

function worktreeDirty(cwd: string): boolean {
  try {
    const out = execFileSync('git', ['status', '--porcelain', '--untracked-files=normal'], {
      cwd, encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'pipe'],
    });
    return out.trim().length > 0;
  } catch {
    throw new Error(`Cannot inspect worktree status at ${cwd}.`);
  }
}

function claudeMarker(worktreePath: string): { marker: boolean; lockReason: string | null } {
  let admin: string | null = null;
  try {
    const text = fs.readFileSync(path.join(worktreePath, '.git'), 'utf8');
    const match = /^gitdir:\s*(.+)\s*$/m.exec(text);
    if (match?.[1]) admin = path.resolve(worktreePath, match[1].trim());
  } catch { return { marker: false, lockReason: null }; }
  if (!admin) return { marker: false, lockReason: null };
  let lockReason: string | null = null;
  try { lockReason = fs.readFileSync(path.join(admin, 'locked'), 'utf8').trim() || null; } catch { /* unlocked */ }
  const names = ['claude', 'claude.json', 'claude-worktree'];
  const marker = names.some(name => {
    try { return fs.existsSync(path.join(admin!, name)); } catch { return false; }
  }) || Boolean(lockReason && /claude/i.test(lockReason));
  return { marker, lockReason };
}

function pathHasClaudeWorktrees(worktreePath: string): boolean {
  const parts = worktreePath.split(path.sep);
  for (let i = 0; i < parts.length - 1; i++) {
    if (parts[i] === '.claude' && parts[i + 1] === 'worktrees' && parts.length >= i + 3) return true;
  }
  return false;
}

function classifySource(coord: CoordDatabase, worktreePath: string, lockReason: string | null): WorktreeSource {
  if (isKithOwnedWorktree(coord, worktreePath)) return 'kith';
  const marker = claudeMarker(worktreePath);
  if (pathHasClaudeWorktrees(worktreePath) || marker.marker || (lockReason && /claude/i.test(lockReason))) return 'claude-code';
  return 'external';
}

function inspectLinkedWorktree(coord: CoordDatabase, requested: string): Inspection {
  if (!fs.existsSync(requested)) throw new Error(`Not a linked worktree of this repository: ${requested}`);
  const dir = fs.statSync(requested).isDirectory() ? requested : path.dirname(requested);
  let layout;
  try { layout = discoverRepository(dir); }
  catch { throw new Error(`Not a linked worktree of this repository: ${requested}`); }
  if (!layout.commonGitDir || layout.commonGitDir !== coord.commonGitDir) {
    throw new Error(`Not a linked worktree of this repository: ${requested}`);
  }
  if (!layout.isLinkedWorktree) {
    throw new Error('Cannot adopt the primary checkout. Pass a linked worktree from git worktree list.');
  }
  const entries = listGitWorktrees(coord.repoRoot);
  const checkoutRoot = physicalPath(layout.checkoutRoot);
  const match = entries.find(entry => {
    try { return physicalPath(entry.path) === checkoutRoot; } catch { return false; }
  });
  if (!match) throw new Error(`Not a linked worktree of this repository: ${checkoutRoot}`);
  const detached = match.detached || !match.branch;
  const branch = detached ? null : match.branch;
  return {
    checkoutRoot,
    branch,
    head: match.head,
    detached,
    dirty: worktreeDirty(checkoutRoot),
    branchCheckedOutElsewhere: branchIsCheckedOutElsewhere(entries, checkoutRoot, branch),
    source: classifySource(coord, checkoutRoot, match.lockReason),
    provenance: isKithOwnedWorktree(coord, checkoutRoot) ? 'created' : 'adopted',
    locked: match.locked,
    lockReason: match.lockReason,
  };
}

function adoptionNotes(inspected: Inspection): string[] {
  if (inspected.provenance !== 'adopted') return [];
  const notes = [
    'Kith did not create this worktree and will not delete it. Unregister with `kith worktree forget`, or remove it explicitly with `kith worktree remove --delete-adopted`.',
  ];
  if (inspected.dirty) notes.unshift('Adopted worktree has uncommitted changes. They were left as they are.');
  if (inspected.detached) notes.unshift(detachedIntegrationError());
  else if (inspected.branchCheckedOutElsewhere && inspected.branch) notes.unshift(branchElsewhereError(inspected.branch));
  return notes;
}

function bindingFrom(agentId: string, inspected: Inspection, started: number, alreadyRegistered: boolean): WorktreeBinding {
  return {
    agentId,
    worktreePath: inspected.checkoutRoot,
    branch: inspected.branch,
    hydrationMethod: 'none',
    hydratedDirs: [],
    durationMs: Date.now() - started,
    provenance: inspected.provenance,
    source: inspected.source,
    detached: inspected.detached,
    dirty: inspected.dirty,
    branchCheckedOutElsewhere: inspected.branchCheckedOutElsewhere,
    alreadyRegistered,
    notes: adoptionNotes(inspected),
  };
}

function writeRegistration(coord: CoordDatabase, fencing: FencingAndAgentManager, agentId: string, inspected: Inspection, already: WorktreeRegistration | null, log = true): void {
  coord.withTransaction(() => {
    fencing.assertSession(agentId);
    coord.db.prepare(`
      INSERT INTO worktree_registrations (
        agent_id, worktree_path, provenance, source, branch, head, detached, dirty, branch_elsewhere, registered_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(agent_id) DO UPDATE SET
        worktree_path = excluded.worktree_path, provenance = excluded.provenance, source = excluded.source,
        branch = excluded.branch, head = excluded.head, detached = excluded.detached,
        branch_elsewhere = excluded.branch_elsewhere,
        dirty = CASE WHEN worktree_registrations.worktree_path = excluded.worktree_path THEN worktree_registrations.dirty ELSE excluded.dirty END,
        registered_at = CASE WHEN worktree_registrations.worktree_path = excluded.worktree_path THEN worktree_registrations.registered_at ELSE excluded.registered_at END
    `).run(
      agentId, inspected.checkoutRoot, inspected.provenance, inspected.source, inspected.branch, inspected.head,
      inspected.detached ? 1 : 0, inspected.dirty ? 1 : 0, inspected.branchCheckedOutElsewhere ? 1 : 0, Date.now(),
    );
    coord.db.prepare('UPDATE agents SET worktree_path = ?, branch = ? WHERE id = ?')
      .run(inspected.checkoutRoot, inspected.branch, agentId);
    const changed = !already
      || physicalPath(already.worktreePath) !== inspected.checkoutRoot
      || already.branch !== inspected.branch
      || already.detached !== inspected.detached
      || already.branchCheckedOutElsewhere !== inspected.branchCheckedOutElsewhere
      || already.source !== inspected.source;
    if (log && changed) {
      coord.logEvent(agentId, inspected.provenance === 'created' ? 'worktree_spawned' : 'worktree_adopted', {
        worktreePath: inspected.checkoutRoot,
        branch: inspected.branch,
        source: inspected.source,
        provenance: inspected.provenance,
        detached: inspected.detached,
        dirty: inspected.dirty,
        branchCheckedOutElsewhere: inspected.branchCheckedOutElsewhere,
      });
    }
  });
}

export function adoptWorktree(coord: CoordDatabase, fencing: FencingAndAgentManager, params: {
  agentId: string; path?: string; explicit: boolean;
}): WorktreeBinding {
  fencing.assertSession(params.agentId);
  const started = Date.now();
  const requested = params.path ? path.resolve(params.path) : process.cwd();
  const inspected = inspectLinkedWorktree(coord, requested);
  const agent = fencing.getAgent(params.agentId);
  if (agent?.worktree_path && physicalPath(agent.worktree_path) !== inspected.checkoutRoot) {
    throw new Error(`This session already has a different worktree at ${agent.worktree_path}. Forget it with \`kith worktree forget\` before adopting another.`);
  }
  const peer = fencing.listAgents(true).find(other =>
    other.id !== params.agentId && other.worktree_path && physicalPath(other.worktree_path) === inspected.checkoutRoot);
  if (peer) throw new Error(`Worktree is already registered to active agent '${peer.id}'.`);
  const already = readRegistration(coord, params.agentId);
  const same = Boolean(already
    && physicalPath(already.worktreePath) === inspected.checkoutRoot
    && already.branch === inspected.branch
    && already.detached === inspected.detached
    && already.branchCheckedOutElsewhere === inspected.branchCheckedOutElsewhere
    && already.source === inspected.source
    && already.provenance === inspected.provenance);
  if (!same) writeRegistration(coord, fencing, params.agentId, inspected, already);
  return bindingFrom(params.agentId, inspected, started, Boolean(already && physicalPath(already.worktreePath) === inspected.checkoutRoot));
}

export function recordCreatedWorktree(coord: CoordDatabase, fencing: FencingAndAgentManager, params: {
  agentId: string; worktreePath: string; branch: string; head: string | null;
}): void {
  const inspected: Inspection = {
    checkoutRoot: physicalPath(params.worktreePath),
    branch: params.branch,
    head: params.head ?? '',
    detached: false,
    dirty: false,
    branchCheckedOutElsewhere: false,
    source: 'kith',
    provenance: 'created',
    locked: false,
    lockReason: null,
  };
  writeRegistration(coord, fencing, params.agentId, inspected, readRegistration(coord, params.agentId), false);
}

/** Fill provenance for a checkout the session already recorded, without switching worktrees. */
export function syncRegistration(coord: CoordDatabase, fencing: FencingAndAgentManager, agentId: string): WorktreeRegistration | null {
  const agent = fencing.getAgent(agentId);
  if (!agent?.worktree_path) return null;
  const existing = readRegistration(coord, agentId);
  if (existing) {
    try {
      if (physicalPath(existing.worktreePath) === physicalPath(agent.worktree_path)) return existing;
    } catch { return existing; }
  }
  try {
    adoptWorktree(coord, fencing, { agentId, path: agent.worktree_path, explicit: false });
  } catch {
    return readRegistration(coord, agentId);
  }
  return readRegistration(coord, agentId);
}

/**
 * Adopt when the hook cwd is exactly one linked worktree of this repository and the session
 * does not already own a different checkout. Anything else is left alone.
 */
export function adoptIfUnambiguous(coord: CoordDatabase, fencing: FencingAndAgentManager, params: {
  agentId: string; cwd: string;
}): WorktreeBinding | null {
  const agent = fencing.getAgent(params.agentId);
  if (!agent || agent.status !== 'active') return null;
  let layout;
  try { layout = discoverRepository(params.cwd); } catch { return null; }
  if (!layout.isLinkedWorktree || !layout.commonGitDir || layout.commonGitDir !== coord.commonGitDir) return null;
  if (agent.worktree_path) {
    try {
      if (physicalPath(agent.worktree_path) !== physicalPath(layout.checkoutRoot)) return null;
    } catch { return null; }
  }
  const peer = fencing.listAgents(true).some(other =>
    other.id !== params.agentId && other.worktree_path && (() => {
      try { return physicalPath(other.worktree_path) === physicalPath(layout.checkoutRoot); } catch { return false; }
    })());
  if (peer) return null;
  try {
    return adoptWorktree(coord, fencing, { agentId: params.agentId, path: layout.checkoutRoot, explicit: false });
  } catch {
    return null;
  }
}

export function liveAdoption(coord: CoordDatabase, fencing: FencingAndAgentManager, agent: AgentRecord | null | undefined): LiveAdoption | null {
  if (!agent?.worktree_path) return null;
  const registration = readRegistration(coord, agent.id);
  const adopted = registration?.provenance === 'adopted'
    || (!registration && !isKithOwnedWorktree(coord, agent.worktree_path));
  if (!adopted) return null;
  let inspected: Inspection;
  try { inspected = inspectLinkedWorktree(coord, agent.worktree_path); }
  catch {
    return {
      worktreePath: agent.worktree_path,
      branch: agent.branch,
      detached: registration?.detached ?? !agent.branch,
      dirty: registration?.dirty ?? false,
      branchCheckedOutElsewhere: registration?.branchCheckedOutElsewhere ?? false,
      source: registration?.source ?? 'external',
      provenance: 'adopted',
      integrationError: registration?.detached || !agent.branch
        ? detachedIntegrationError()
        : (registration?.branchCheckedOutElsewhere && agent.branch ? branchElsewhereError(agent.branch) : null),
      commitError: registration?.branchCheckedOutElsewhere && agent.branch ? branchElsewhereError(agent.branch) : null,
    };
  }
  if (registration?.branch !== inspected.branch
    || registration?.detached !== inspected.detached
    || registration?.branchCheckedOutElsewhere !== inspected.branchCheckedOutElsewhere) {
    try { writeRegistration(coord, fencing, agent.id, inspected, registration); } catch { /* Keep the live answer either way. */ }
  }
  const integrationError = inspected.detached
    ? detachedIntegrationError()
    : (inspected.branchCheckedOutElsewhere && inspected.branch ? branchElsewhereError(inspected.branch) : null);
  return {
    worktreePath: inspected.checkoutRoot,
    branch: inspected.branch,
    detached: inspected.detached,
    dirty: inspected.dirty,
    branchCheckedOutElsewhere: inspected.branchCheckedOutElsewhere,
    source: inspected.source,
    provenance: 'adopted',
    integrationError,
    commitError: inspected.branchCheckedOutElsewhere && inspected.branch ? branchElsewhereError(inspected.branch) : null,
  };
}

/** Move an adopted or created workspace from one agent onto another, leaving the directory in place. */
export function transferWorktreeRegistration(coord: CoordDatabase, fromId: string, toId: string): boolean {
  if (fromId === toId) return false;
  const from = coord.db.prepare('SELECT worktree_path, branch FROM agents WHERE id = ?').get(fromId) as { worktree_path: string | null; branch: string | null } | undefined;
  const to = coord.db.prepare('SELECT worktree_path FROM agents WHERE id = ?').get(toId) as { worktree_path: string | null } | undefined;
  if (!from?.worktree_path || !to || to.worktree_path) return false;
  coord.db.prepare('UPDATE agents SET worktree_path = ?, branch = ? WHERE id = ?').run(from.worktree_path, from.branch, toId);
  coord.db.prepare('UPDATE agents SET worktree_path = NULL, branch = NULL WHERE id = ?').run(fromId);
  if (!registrationsTable(coord)) return true;
  const row = coord.db.prepare(`${REGISTRATION_SQL} WHERE agent_id = ?`).get(fromId) as Parameters<typeof registrationFromRow>[0] | undefined;
  if (!row) return true;
  coord.db.prepare('DELETE FROM worktree_registrations WHERE agent_id = ?').run(fromId);
  coord.db.prepare(`
    INSERT INTO worktree_registrations (
      agent_id, worktree_path, provenance, source, branch, head, detached, dirty, branch_elsewhere, registered_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(agent_id) DO UPDATE SET
      worktree_path = excluded.worktree_path, provenance = excluded.provenance, source = excluded.source,
      branch = excluded.branch, head = excluded.head, detached = excluded.detached, dirty = excluded.dirty,
      branch_elsewhere = excluded.branch_elsewhere, registered_at = excluded.registered_at
  `).run(
    toId, row.worktree_path, row.provenance, row.source, row.branch, row.head,
    Number(row.detached), Number(row.dirty), Number(row.branch_elsewhere), row.registered_at,
  );
  return true;
}

export function forgetWorktree(coord: CoordDatabase, fencing: FencingAndAgentManager, agentId: string): boolean {
  fencing.assertSession(agentId);
  const agent = fencing.getAgent(agentId);
  const had = Boolean(agent?.worktree_path || readRegistration(coord, agentId));
  coord.withTransaction(() => {
    fencing.assertSession(agentId);
    clearRegistration(coord, agentId);
    coord.db.prepare('UPDATE agents SET worktree_path = NULL, branch = NULL WHERE id = ?').run(agentId);
    coord.logEvent(agentId, 'worktree_forgotten', { worktreePath: agent?.worktree_path ?? null });
  });
  return had;
}
