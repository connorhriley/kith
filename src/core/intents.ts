import crypto from 'node:crypto';
import { CoordDatabase } from './db.js';
import { FencingAndAgentManager } from './fencing.js';
import { LockConflict, LockEngine, LockRecord } from './locks.js';

export interface TaskRecord {
  id: string;
  title: string;
  intent_summary: string;
  status: 'queued' | 'active' | 'done' | 'blocked';
  priority: number;
  owner_agent_id: string | null;
  fencing_token: number | null;
  depends_on: string[];
  scope_globs: string[];
  created_at: number;
  updated_at: number;
}

export interface DeclareIntentResult {
  ok: boolean;
  task: TaskRecord | null;
  fencingToken: number;
  locks: LockRecord[];
  lockConflicts: LockConflict[];
  activeSiblingIntents: TaskRecord[];
}

export class IntentAndTaskEngine {
  constructor(
    private readonly coordDb: CoordDatabase,
    private readonly fencing: FencingAndAgentManager,
    private readonly lockEngine: LockEngine
  ) {}

  /**
   * Peer-to-Peer Mode: Declares an agent's intent, checks scope-lock collisions
   * and reserves the scope if available.
   */
  public declareIntent(params: {
    agentId: string;
    title: string;
    intentSummary?: string;
    scopeGlobs: string[];
  }): DeclareIntentResult {
    this.fencing.reapDeadAgents();
    const summary = params.intentSummary ?? params.title;

    return this.coordDb.withTransaction(() => {
      this.fencing.assertSession(params.agentId);
      const activeTasks = this.listTasks({ status: 'active' }).filter(
        (t) => t.owner_agent_id !== params.agentId
      );

      const taskId = `task_${crypto.randomBytes(6).toString('hex')}`;
      const lockRes = this.lockEngine.acquireLocks({
        agentId: params.agentId,
        patterns: params.scopeGlobs,
        taskId,
        reason: params.title,
      });

      if (!lockRes.ok) {
        return {
          ok: false,
          task: null,
          fencingToken: lockRes.fencingToken,
          locks: [],
          lockConflicts: lockRes.conflicts,
          activeSiblingIntents: activeTasks,
        };
      }

      const now = Date.now();
      const normGlobs = params.scopeGlobs.map((g) =>
        LockEngine.normalizePattern(this.fencing.getAgent(params.agentId)?.worktree_path ?? this.coordDb.repoRoot, g)
      );

      this.coordDb.db
        .prepare(`
          INSERT INTO tasks (
            id, title, intent_summary, status, priority,
            owner_agent_id, fencing_token, depends_on_json, scope_globs_json,
            created_at, updated_at
          )
          VALUES (?, ?, ?, 'active', 50, ?, ?, '[]', ?, ?, ?)
        `)
        .run(
          taskId,
          params.title,
          summary,
          params.agentId,
          lockRes.fencingToken,
          JSON.stringify(normGlobs),
          now,
          now
        );

      this.coordDb.logEvent(params.agentId, 'intent_declared', {
        taskId,
        title: params.title,
        scopeGlobs: normGlobs,
        fencingToken: lockRes.fencingToken,
      });

      return {
        ok: true,
        task: this.getTask(taskId),
        fencingToken: lockRes.fencingToken,
        locks: lockRes.locks,
        lockConflicts: [],
        activeSiblingIntents: activeTasks,
      };
    });
  }

  /**
   * Orchestrator Mode: Adds a task to the DAG queue with optional dependencies and priority.
   */
  public addTask(params: {
    id?: string;
    title: string;
    intentSummary?: string;
    priority?: number;
    dependsOn?: string[];
    scopeGlobs?: string[];
  }): TaskRecord {
    const id = params.id ?? `task_${crypto.randomBytes(6).toString('hex')}`;
    const dependsOn = params.dependsOn ?? [];
    const scopeGlobs = (params.scopeGlobs ?? []).map((g) =>
      LockEngine.normalizePattern(this.coordDb.repoRoot, g)
    );

    return this.coordDb.withTransaction(() => {
      for (const depId of dependsOn) {
        if (depId === id) {
          throw new Error(`Task '${id}' cannot depend on itself.`);
        }
        const dep = this.getTask(depId);
        if (!dep) {
          throw new Error(`Dependency task '${depId}' does not exist.`);
        }
        if (this.hasPathInDag(depId, id)) {
          throw new Error(`Circular dependency detected between '${id}' and '${depId}'.`);
        }
      }

      const now = Date.now();
      this.coordDb.db
        .prepare(`
          INSERT INTO tasks (
            id, title, intent_summary, status, priority,
            owner_agent_id, fencing_token, depends_on_json, scope_globs_json,
            created_at, updated_at
          )
          VALUES (?, ?, ?, 'queued', ?, NULL, NULL, ?, ?, ?, ?)
        `)
        .run(
          id,
          params.title,
          params.intentSummary ?? params.title,
          params.priority ?? 10,
          JSON.stringify(dependsOn),
          JSON.stringify(scopeGlobs),
          now,
          now
        );

      this.coordDb.logEvent(null, 'task_queued', { id, title: params.title, dependsOn });
      return this.getTask(id)!;
    });
  }

  private hasPathInDag(startId: string, targetId: string, visited = new Set<string>()): boolean {
    if (startId === targetId) return true;
    if (visited.has(startId)) return false;
    visited.add(startId);

    const task = this.getTask(startId);
    if (!task) return false;
    for (const dep of task.depends_on) {
      if (this.hasPathInDag(dep, targetId, visited)) return true;
    }
    return false;
  }

  /**
   * Orchestrator Mode: Atomically claims the highest-priority unblocked task whose scope locks are available.
   */
  public claimNextTask(agentId: string): {
    claimed: boolean;
    task: TaskRecord | null;
    fencingToken: number | null;
    locks: LockRecord[];
    reason?: string;
  } {
    this.fencing.reapDeadAgents();

    return this.coordDb.withTransaction(() => {
      this.fencing.assertSession(agentId);
      const allTasks = this.listTasks();
      const taskById = new Map(allTasks.map((t) => [t.id, t]));
      const queued = allTasks
        .filter((t) => t.status === 'queued')
        .sort((a, b) => b.priority - a.priority || a.created_at - b.created_at);

      if (queued.length === 0) {
        return { claimed: false, task: null, fencingToken: null, locks: [], reason: 'no_queued_tasks' };
      }

      for (const candidate of queued) {
        const depsSatisfied = candidate.depends_on.every(
          (depId) => taskById.get(depId)?.status === 'done'
        );
        if (!depsSatisfied) continue;

        let fencingToken = this.coordDb.currentFencingEpoch();
        let locks: LockRecord[] = [];

        if (candidate.scope_globs.length > 0) {
          const lockRes = this.lockEngine.acquireLocks({
            agentId,
            patterns: candidate.scope_globs,
            taskId: candidate.id,
            reason: candidate.title,
          });
          if (!lockRes.ok) {
            continue;
          }
          fencingToken = lockRes.fencingToken;
          locks = lockRes.locks;
        } else {
          fencingToken = this.coordDb.nextFencingToken();
        }

        const now = Date.now();
        this.coordDb.db
          .prepare(`
            UPDATE tasks
            SET status = 'active', owner_agent_id = ?, fencing_token = ?, updated_at = ?
            WHERE id = ?
          `)
          .run(agentId, fencingToken, now, candidate.id);

        this.coordDb.logEvent(agentId, 'task_claimed', {
          taskId: candidate.id,
          title: candidate.title,
          fencingToken,
        });

        return {
          claimed: true,
          task: this.getTask(candidate.id),
          fencingToken,
          locks,
        };
      }

      return {
        claimed: false,
        task: null,
        fencingToken: null,
        locks: [],
        reason: 'all_queued_tasks_blocked_by_dependencies_or_locks',
      };
    });
  }

  public completeTask(params: {
    agentId: string;
    taskId?: string;
    fencingToken?: number;
    releaseLocks?: boolean;
  }): TaskRecord[] {
    return this.coordDb.withTransaction(() => {
      this.fencing.assertSession(params.agentId);
      const rows = params.taskId
        ? [this.getTask(params.taskId)].filter((t): t is TaskRecord => t !== null)
        : this.listTasks({ status: 'active' }).filter((t) => t.owner_agent_id === params.agentId);

      const now = Date.now();
      const completed: TaskRecord[] = [];

      for (const task of rows) {
        if (task.status !== 'active' || task.owner_agent_id !== params.agentId) {
          throw new Error(
            `Task '${task.id}' is owned by '${task.owner_agent_id}', not '${params.agentId}'.`
          );
        }
        if (params.fencingToken !== undefined && task.fencing_token !== null) {
          this.fencing.verifyFencingToken(task.id, params.fencingToken, task.fencing_token);
        }

        this.coordDb.db
          .prepare(`UPDATE tasks SET status = 'done', updated_at = ? WHERE id = ?`)
          .run(now, task.id);

        if (params.releaseLocks !== false) {
          this.coordDb.db
            .prepare(`DELETE FROM locks WHERE owner_agent_id = ? AND task_id = ?`)
            .run(params.agentId, task.id);
        }

        this.coordDb.logEvent(params.agentId, 'task_completed', { taskId: task.id });
        completed.push(this.getTask(task.id)!);
      }

      return completed;
    });
  }

  public getTask(taskId: string): TaskRecord | null {
    const row = this.coordDb.db
      .prepare(`SELECT * FROM tasks WHERE id = ?`)
      .get(taskId) as
      | {
          id: string;
          title: string;
          intent_summary: string;
          status: 'queued' | 'active' | 'done' | 'blocked';
          priority: number;
          owner_agent_id: string | null;
          fencing_token: number | null;
          depends_on_json: string;
          scope_globs_json: string;
          created_at: number;
          updated_at: number;
        }
      | undefined;

    if (!row) return null;
    return {
      id: row.id,
      title: row.title,
      intent_summary: row.intent_summary,
      status: row.status,
      priority: row.priority,
      owner_agent_id: row.owner_agent_id,
      fencing_token: row.fencing_token,
      depends_on: JSON.parse(row.depends_on_json) as string[],
      scope_globs: JSON.parse(row.scope_globs_json) as string[],
      created_at: row.created_at,
      updated_at: row.updated_at,
    };
  }

  public listTasks(filter?: { status?: TaskRecord['status'] }): TaskRecord[] {
    this.fencing.reapDeadAgents();
    const rows = filter?.status
      ? (this.coordDb.db
          .prepare(`SELECT * FROM tasks WHERE status = ? ORDER BY priority DESC, created_at ASC`)
          .all(filter.status) as Array<Record<string, unknown>>)
      : (this.coordDb.db
          .prepare(`SELECT * FROM tasks ORDER BY priority DESC, created_at ASC`)
          .all() as Array<Record<string, unknown>>);

    return rows.map((row) => ({
      id: String(row.id),
      title: String(row.title),
      intent_summary: String(row.intent_summary),
      status: row.status as TaskRecord['status'],
      priority: Number(row.priority),
      owner_agent_id: (row.owner_agent_id as string | null) ?? null,
      fencing_token: (row.fencing_token as number | null) ?? null,
      depends_on: JSON.parse(String(row.depends_on_json)) as string[],
      scope_globs: JSON.parse(String(row.scope_globs_json)) as string[],
      created_at: Number(row.created_at),
      updated_at: Number(row.updated_at),
    }));
  }
}
