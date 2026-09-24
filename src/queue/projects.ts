import type { Db, Queryable } from '../db/pool.ts';
import { redact } from '../security/redact.ts';
import { AppError, newId } from '../util/common.ts';
import type { ProjectRow, ProjectStatus } from './types.ts';

export class ProjectStore {
  #db: Db;
  constructor(db: Db) {
    this.#db = db;
  }

  async create(input: { name: string; kind: string; request: string; idempotencyKey?: string | null; status?: ProjectStatus }, q: Queryable = this.#db): Promise<{ project: ProjectRow; duplicate: boolean }> {
    const id = newId('prj');
    const ins = await q.query(
      `INSERT INTO projects (id, name, kind, status, request, idempotency_key) VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (idempotency_key) DO NOTHING RETURNING *`,
      [id, input.name, input.kind, input.status ?? 'PLANNING', input.request, input.idempotencyKey ?? null],
    );
    if (ins.rows[0]) return { project: ins.rows[0], duplicate: false };
    const existing = await q.query('SELECT * FROM projects WHERE idempotency_key = $1', [input.idempotencyKey]);
    return { project: existing.rows[0], duplicate: true };
  }

  async get(id: string, q: Queryable = this.#db): Promise<ProjectRow> {
    const { rows } = await q.query('SELECT * FROM projects WHERE id = $1', [id]);
    if (!rows[0]) throw new AppError('not_found', `Project ${id} not found`, 404);
    return rows[0];
  }

  async list(limit = 50): Promise<ProjectRow[]> {
    const { rows } = await this.#db.query('SELECT * FROM projects ORDER BY created_at DESC LIMIT $1', [limit]);
    return rows;
  }

  async update(id: string, patch: Partial<Pick<ProjectRow, 'status' | 'name' | 'kind' | 'interpretation' | 'plan' | 'final_report' | 'paused' | 'fix_cycles' | 'approved_at' | 'approved_by' | 'completed_at'>>, q: Queryable = this.#db): Promise<ProjectRow> {
    const sets = ['updated_at = now()'];
    const params: unknown[] = [id];
    for (const [k, v] of Object.entries(patch)) {
      params.push(['interpretation', 'plan', 'final_report'].includes(k) && v != null ? JSON.stringify(v) : v);
      sets.push(`${k} = $${params.length}`);
    }
    const { rows } = await q.query(`UPDATE projects SET ${sets.join(', ')} WHERE id = $1 RETURNING *`, params);
    if (!rows[0]) throw new AppError('not_found', `Project ${id} not found`, 404);
    return rows[0];
  }

  /** Atomically moves a project between statuses; returns null if it was not in an expected state. */
  async transition(id: string, from: ProjectStatus[], to: ProjectStatus, q: Queryable = this.#db): Promise<ProjectRow | null> {
    const { rows } = await q.query(
      `UPDATE projects SET status = $3, updated_at = now(), completed_at = CASE WHEN $3 IN ('COMPLETED', 'FAILED', 'CANCELLED') THEN now() ELSE completed_at END
       WHERE id = $1 AND status = ANY($2::text[]) RETURNING *`,
      [id, from, to],
    );
    return rows[0] ?? null;
  }

  async addMessage(projectId: string | null, role: 'user' | 'main_agent' | 'system', content: string, data?: unknown): Promise<void> {
    await this.#db.query('INSERT INTO messages (project_id, role, content, data) VALUES ($1, $2, $3, $4)', [
      projectId,
      role,
      content,
      data === undefined ? null : JSON.stringify(redact(data)),
    ]);
  }

  async messages(projectId: string | null, limit = 100) {
    const { rows } = await this.#db.query(
      `SELECT * FROM (SELECT * FROM messages WHERE ($1::text IS NULL OR project_id = $1) ORDER BY id DESC LIMIT $2) m ORDER BY id`,
      [projectId, limit],
    );
    return rows;
  }

  async audit(actor: string, action: string, targetType: string, targetId: string | null, detail?: unknown): Promise<void> {
    await this.#db.query('INSERT INTO audit_log (actor, action, target_type, target_id, detail) VALUES ($1, $2, $3, $4, $5)', [
      actor,
      action,
      targetType,
      targetId,
      detail === undefined ? null : JSON.stringify(redact(detail)),
    ]);
  }
}
