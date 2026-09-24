// Centralised, persistent task queue. All state lives in Postgres so a restart
// loses nothing: claims use FOR UPDATE SKIP LOCKED under a short advisory lock
// (exact global concurrency cap), dependency satisfaction is re-checked at
// claim time, and every transition is validated and written to task_events.
import { EventEmitter } from 'node:events';
import type { Db, DbClient, Queryable } from '../db/pool.ts';
import { withTransaction } from '../db/pool.ts';
import { redact } from '../security/redact.ts';
import { AppError, newId } from '../util/common.ts';
import { logger } from '../util/log.ts';
import { TRANSITIONS, type NewTaskSpec, type TaskRow, type TaskStatus } from './types.ts';

const log = logger('queue');

const PATCHABLE = new Set([
  'outputs', 'error', 'attempt', 'assigned_key', 'assigned_model', 'lease_owner', 'lease_expires_at', 'not_before',
  'started_at', 'completed_at', 'inputs', 'phase', 'dependencies', 'revision', 'capacity_waits', 'workflow_execution_id',
  'model_override', 'agent_type', 'max_attempts', 'priority', 'capability',
]);
const JSON_COLUMNS = new Set(['outputs', 'error', 'inputs']);

/** SQL predicate: dependency `dt` no longer holds up its dependents. */
const DEP_SATISFIED = `(dt.status = 'COMPLETED' OR (dt.optional AND dt.status IN ('FAILED', 'CANCELLED', 'BLOCKED')))`;
const UNSATISFIED_DEPS = (alias: string) => `EXISTS (
  SELECT 1 FROM unnest(${alias}.dependencies) AS d(dep_id) LEFT JOIN tasks dt ON dt.id = d.dep_id
  WHERE dt.id IS NULL OR NOT ${DEP_SATISFIED})`;

export interface TaskEvent {
  type: string;
  actor: string;
  detail?: Record<string, unknown>;
}

export class InvalidTransitionError extends AppError {
  constructor(taskId: string, from: string, to: string) {
    super('invalid_transition', `Task ${taskId} cannot move ${from} -> ${to}`, 409);
  }
}

export class TaskQueue extends EventEmitter {
  #db: Db;
  readonly maxConcurrent: number;
  readonly leaseMs: number;

  constructor(db: Db, opts: { maxConcurrent: number; leaseMs: number }) {
    super();
    this.#db = db;
    this.maxConcurrent = opts.maxConcurrent;
    this.leaseMs = opts.leaseMs;
  }

  get db(): Db {
    return this.#db;
  }

  async get(taskId: string, q: Queryable = this.#db): Promise<TaskRow> {
    const { rows } = await q.query('SELECT * FROM tasks WHERE id = $1', [taskId]);
    if (!rows[0]) throw new AppError('not_found', `Task ${taskId} not found`, 404);
    return rows[0];
  }

  async find(taskId: string): Promise<TaskRow | null> {
    const { rows } = await this.#db.query('SELECT * FROM tasks WHERE id = $1', [taskId]);
    return rows[0] ?? null;
  }

  async listByProject(projectId: string): Promise<TaskRow[]> {
    const { rows } = await this.#db.query('SELECT * FROM tasks WHERE project_id = $1 ORDER BY created_at, id', [projectId]);
    return rows;
  }

  async recordEvent(q: Queryable, task: Pick<TaskRow, 'id' | 'project_id'>, type: string, from: string | null, to: string | null, actor: string, detail?: unknown) {
    await q.query(
      `INSERT INTO task_events (task_id, project_id, type, from_status, to_status, actor, detail) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [task.id, task.project_id, type, from, to, actor, detail === undefined ? null : JSON.stringify(redact(detail))],
    );
  }

  /**
   * Creates tasks idempotently. A spec whose idempotency_key already exists
   * returns the existing task instead of creating a duplicate.
   */
  async createTasks(projectId: string, specs: NewTaskSpec[], actor: string, client?: DbClient): Promise<TaskRow[]> {
    const run = async (c: DbClient) => {
      const created: TaskRow[] = [];
      for (const spec of specs) {
        const id = spec.id ?? newId('tsk');
        const status: TaskStatus = spec.initial_status ?? ((spec.dependencies?.length ?? 0) > 0 ? 'WAITING' : 'QUEUED');
        const ins = await c.query(
          `INSERT INTO tasks (id, project_id, parent_task_id, plan_key, agent_type, title, mission, kind, status, optional, priority,
             dependencies, inputs, review_target, capability, max_attempts, max_revisions, timeout_ms, idempotency_key)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)
           ON CONFLICT (idempotency_key) DO NOTHING RETURNING *`,
          [
            id, projectId, spec.parent_task_id ?? null, spec.plan_key, spec.agent_type, spec.title, spec.mission,
            spec.kind ?? 'work', status, spec.optional ?? false, spec.priority ?? 50, spec.dependencies ?? [],
            JSON.stringify(spec.inputs ?? {}), spec.review_target ?? null, spec.capability ?? null,
            spec.max_attempts ?? 3, spec.max_revisions ?? 2, spec.timeout_ms ?? 600_000, spec.idempotency_key ?? null,
          ],
        );
        if (ins.rows[0]) {
          created.push(ins.rows[0]);
          await this.recordEvent(c, ins.rows[0], 'created', null, status, actor, { agent_type: spec.agent_type, dependencies: spec.dependencies ?? [] });
        } else {
          const existing = await c.query('SELECT * FROM tasks WHERE idempotency_key = $1', [spec.idempotency_key]);
          if (existing.rows[0]) {
            if (existing.rows[0].project_id !== projectId) {
              throw new AppError('duplicate_task', `Idempotency key ${spec.idempotency_key} belongs to another project`, 409);
            }
            created.push(existing.rows[0]);
          }
        }
      }
      return created;
    };
    const tasks = client ? await run(client) : await withTransaction(this.#db, run);
    if (!client) this.emit('tasks_ready', { projectId });
    return tasks;
  }

  /** Validated, optimistic status transition. `from` guards against lost updates. */
  async transition(
    taskId: string,
    from: TaskStatus[],
    to: TaskStatus,
    patch: Partial<Record<string, unknown>>,
    event: TaskEvent,
    client?: Queryable,
  ): Promise<TaskRow> {
    for (const f of from) {
      if (!TRANSITIONS[f].includes(to) && f !== to) throw new AppError('invalid_transition_spec', `${f} -> ${to} is not an allowed transition`, 500);
    }
    const q = client ?? this.#db;
    const sets = ['status = $3', 'updated_at = now()'];
    const params: unknown[] = [taskId, from, to];
    for (const [k, v] of Object.entries(patch)) {
      if (!PATCHABLE.has(k)) throw new Error(`Column ${k} is not patchable`);
      params.push(JSON_COLUMNS.has(k) && v !== null && v !== undefined ? JSON.stringify(k === 'error' ? redact(v) : v) : v);
      sets.push(`${k} = $${params.length}`);
    }
    const { rows } = await q.query(
      `WITH prev AS (SELECT status FROM tasks WHERE id = $1)
       UPDATE tasks SET ${sets.join(', ')} WHERE id = $1 AND status = ANY($2::text[])
       RETURNING tasks.*, (SELECT status FROM prev) AS prev_status`,
      params,
    );
    if (!rows[0]) {
      const current = await this.find(taskId);
      if (!current) throw new AppError('not_found', `Task ${taskId} not found`, 404);
      throw new InvalidTransitionError(taskId, current.status, to);
    }
    const row = rows[0] as TaskRow & { prev_status: string };
    const prev = row.prev_status;
    delete (row as any).prev_status;
    await this.recordEvent(q, row, event.type, prev, to, event.actor, event.detail);
    this.emit('task_changed', { task: row, from: prev, to });
    return row;
  }

  /** Claims up to `limit` ready tasks, never exceeding the global concurrency cap. */
  async claimReady(owner: string, limit: number): Promise<TaskRow[]> {
    const claimed = await withTransaction(this.#db, async (c) => {
      await c.query('SELECT pg_advisory_xact_lock(771001)');
      const { rows } = await c.query(
        `WITH running AS (SELECT count(*)::int AS n FROM tasks WHERE status IN ('ASSIGNED', 'RUNNING')),
         candidates AS (
           SELECT t.id, t.status AS prev_status FROM tasks t JOIN projects p ON p.id = t.project_id
           WHERE (t.status = 'QUEUED' OR t.status = 'RETRYING')
             AND (t.not_before IS NULL OR t.not_before <= now())
             AND t.kind <> 'root'
             AND p.paused = false AND p.status = 'RUNNING'
             AND NOT ${UNSATISFIED_DEPS('t')}
           ORDER BY t.priority DESC, t.created_at, t.id
           LIMIT GREATEST(0, LEAST($2::int, $3::int - (SELECT n FROM running)))
           FOR UPDATE OF t SKIP LOCKED
         )
         UPDATE tasks SET status = 'ASSIGNED', lease_owner = $1,
           lease_expires_at = now() + (tasks.timeout_ms * interval '1 millisecond') + interval '60 seconds', updated_at = now()
         FROM candidates WHERE tasks.id = candidates.id
         RETURNING tasks.*, candidates.prev_status`,
        [owner, limit, this.maxConcurrent],
      );
      for (const r of rows) {
        await this.recordEvent(c, r, 'claimed', r.prev_status, 'ASSIGNED', owner, { attempt_next: r.attempt + 1 });
        delete r.prev_status;
      }
      return rows as TaskRow[];
    });
    for (const t of claimed) this.emit('task_changed', { task: t, from: 'QUEUED', to: 'ASSIGNED' });
    return claimed;
  }

  /** Tasks currently held back by dependencies (for dispatcher visibility). */
  async waitingSummary(projectId?: string): Promise<Array<{ task_id: string; project_id: string; agent_type: string; title: string; waiting_on: string[] }>> {
    const { rows } = await this.#db.query(
      `SELECT t.id AS task_id, t.project_id, t.agent_type, t.title,
         ARRAY(SELECT dt.plan_key FROM unnest(t.dependencies) d(dep_id) JOIN tasks dt ON dt.id = d.dep_id
               WHERE NOT ${DEP_SATISFIED}) AS waiting_on
       FROM tasks t WHERE t.status = 'WAITING' AND t.kind <> 'root' AND ($1::text IS NULL OR t.project_id = $1)
       ORDER BY t.created_at`,
      [projectId ?? null],
    );
    return rows;
  }

  /**
   * Re-evaluates a project's graph: blocks tasks behind failed dependencies,
   * promotes WAITING tasks whose dependencies (and sub-agents) are done.
   * Returns the number of tasks that became ready.
   */
  async reconcile(projectId: string, actor = 'queue'): Promise<number> {
    const promoted = await withTransaction(this.#db, async (c) => {
      await c.query('SELECT pg_advisory_xact_lock(hashtext($1))', [projectId]);
      // Cascade blocks until fixpoint.
      for (let i = 0; i < 100; i++) {
        const blocked = await c.query(
          `UPDATE tasks t SET status = 'BLOCKED', updated_at = now(),
             error = jsonb_build_object('reason', 'dependency_failed', 'message', 'A required upstream task failed or was cancelled')
           WHERE t.project_id = $1 AND t.status IN ('WAITING', 'QUEUED') AND t.kind <> 'root'
             AND EXISTS (SELECT 1 FROM unnest(t.dependencies) d(dep_id) JOIN tasks dt ON dt.id = d.dep_id
                         WHERE dt.status IN ('FAILED', 'CANCELLED', 'BLOCKED') AND NOT dt.optional)
           RETURNING t.id, t.project_id`,
          [projectId],
        );
        for (const r of blocked.rows) await this.recordEvent(c, r, 'blocked', 'WAITING', 'BLOCKED', actor, { reason: 'dependency_failed' });
        if (blocked.rowCount === 0) break;
      }
      const ready = await c.query(
        `UPDATE tasks t SET status = 'QUEUED', updated_at = now()
         WHERE t.project_id = $1 AND t.status = 'WAITING' AND t.kind <> 'root'
           AND NOT ${UNSATISFIED_DEPS('t')}
           AND NOT EXISTS (SELECT 1 FROM tasks ch WHERE ch.parent_task_id = t.id AND ch.status NOT IN ('COMPLETED', 'FAILED', 'CANCELLED', 'BLOCKED'))
         RETURNING t.id, t.project_id`,
        [projectId],
      );
      for (const r of ready.rows) await this.recordEvent(c, r, 'dependencies_satisfied', 'WAITING', 'QUEUED', actor);
      return ready.rowCount ?? 0;
    });
    if (promoted > 0) this.emit('tasks_ready', { projectId });
    return promoted;
  }

  /** Unblocks tasks that were blocked by dependency failure so they can be re-evaluated (after a human retry). */
  async unblockDependents(projectId: string, actor: string): Promise<void> {
    const r = await this.#db.query(
      `UPDATE tasks SET status = 'WAITING', error = NULL, updated_at = now()
       WHERE project_id = $1 AND status = 'BLOCKED' AND error->>'reason' = 'dependency_failed' RETURNING id, project_id`,
      [projectId],
    );
    for (const row of r.rows) await this.recordEvent(this.#db, row, 'unblocked', 'BLOCKED', 'WAITING', actor);
    await this.reconcile(projectId, actor);
  }

  async projectProgress(projectId: string) {
    const { rows } = await this.#db.query(
      `SELECT
         count(*) FILTER (WHERE kind <> 'root')::int AS total,
         count(*) FILTER (WHERE kind <> 'root' AND status = 'COMPLETED')::int AS completed,
         count(*) FILTER (WHERE kind <> 'root' AND status IN ('QUEUED', 'ASSIGNED', 'RUNNING', 'REVIEW', 'RETRYING', 'WAITING', 'PLANNING'))::int AS active,
         count(*) FILTER (WHERE kind <> 'root' AND status IN ('FAILED', 'BLOCKED', 'CANCELLED') AND NOT optional)::int AS problems,
         count(*) FILTER (WHERE kind <> 'root' AND status IN ('FAILED', 'BLOCKED', 'CANCELLED') AND optional)::int AS optional_problems
       FROM tasks WHERE project_id = $1`,
      [projectId],
    );
    return rows[0] as { total: number; completed: number; active: number; problems: number; optional_problems: number };
  }

  /** Tasks whose execution lease expired (crashed worker / lost n8n execution). */
  async expiredLeases(): Promise<TaskRow[]> {
    const { rows } = await this.#db.query(
      `SELECT * FROM tasks WHERE status IN ('ASSIGNED', 'RUNNING', 'REVIEW') AND lease_expires_at IS NOT NULL AND lease_expires_at < now()`,
    );
    return rows;
  }

  async extendLease(taskId: string, owner: string): Promise<void> {
    await this.#db.query(
      `UPDATE tasks SET lease_expires_at = now() + (timeout_ms * interval '1 millisecond') + interval '60 seconds'
       WHERE id = $1 AND lease_owner = $2 AND status IN ('ASSIGNED', 'RUNNING', 'REVIEW')`,
      [taskId, owner],
    );
  }

  async events(taskId: string) {
    const { rows } = await this.#db.query('SELECT * FROM task_events WHERE task_id = $1 ORDER BY id', [taskId]);
    return rows;
  }

  async projectEvents(projectId: string, sinceId = 0, limit = 500) {
    const { rows } = await this.#db.query(
      'SELECT * FROM task_events WHERE project_id = $1 AND id > $2 ORDER BY id LIMIT $3',
      [projectId, sinceId, limit],
    );
    return rows;
  }

  async deadLetter(task: TaskRow, reason: string, error: unknown): Promise<void> {
    await this.#db.query(
      'INSERT INTO dead_letters (task_id, project_id, reason, error) VALUES ($1, $2, $3, $4)',
      [task.id, task.project_id, reason, JSON.stringify(redact(error ?? null))],
    );
    log.warn('task dead-lettered', { task: task.id, reason });
  }
}
