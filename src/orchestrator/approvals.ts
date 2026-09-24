// Human approval gates + operating modes.
//
//   Assist          - recommends and waits: plan approval (dry run), major
//                     redesign, final handoff and irreversible repository ops.
//   Semi-Autonomous - normal work runs autonomously; asks for major redesigns
//                     and irreversible repository operations.
//   Autopilot       - executes the approved plan end to end; interrupts only for
//                     blockers and irreversible repository operations.
// Every project can override its gate list; modes can be switched any time.
import type { Db } from '../db/pool.ts';
import type { ProjectRow } from '../queue/types.ts';
import { AppError, newId } from '../util/common.ts';

export const GATES = ['plan_approval', 'major_redesign', 'final_handoff', 'repo_irreversible', 'external_publish'] as const;
export type Gate = (typeof GATES)[number];
export const MODES = ['assist', 'semi', 'autopilot'] as const;
export type Mode = (typeof MODES)[number];

export const MODE_GATES: Record<Mode, Gate[]> = {
  assist: ['plan_approval', 'major_redesign', 'final_handoff', 'repo_irreversible', 'external_publish'],
  semi: ['major_redesign', 'repo_irreversible', 'external_publish'],
  autopilot: ['repo_irreversible', 'external_publish'],
};

export function activeGates(project: Pick<ProjectRow, 'mode' | 'approval_gates' | 'dry_run'>): Gate[] {
  const base = (project.approval_gates ?? MODE_GATES[(project.mode as Mode) ?? 'semi']) as Gate[];
  return [...new Set([...base, ...(project.dry_run ? (['plan_approval'] as Gate[]) : [])])];
}

export interface ApprovalRow {
  id: string;
  project_id: string;
  task_id: string | null;
  gate: Gate;
  title: string;
  detail: any;
  status: 'pending' | 'approved' | 'rejected' | 'expired';
  requested_at: Date;
  decided_at: Date | null;
  decided_by: string | null;
  decision_note: string | null;
}

export class Approvals {
  #db: Db;
  constructor(db: Db) {
    this.#db = db;
  }

  async request(input: { projectId: string; taskId?: string | null; gate: Gate; title: string; detail?: unknown }): Promise<ApprovalRow> {
    const existing = await this.#db.query(
      `SELECT * FROM approvals WHERE project_id = $1 AND gate = $2 AND status = 'pending' AND ($3::text IS NULL OR task_id = $3) LIMIT 1`,
      [input.projectId, input.gate, input.taskId ?? null],
    );
    if (existing.rows[0]) return existing.rows[0];
    const { rows } = await this.#db.query(
      `INSERT INTO approvals (id, project_id, task_id, gate, title, detail) VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [newId('apr'), input.projectId, input.taskId ?? null, input.gate, input.title, input.detail === undefined ? null : JSON.stringify(input.detail)],
    );
    return rows[0];
  }

  async decide(id: string, decision: 'approved' | 'rejected', actor: string, note?: string | null): Promise<ApprovalRow> {
    const { rows } = await this.#db.query(
      `UPDATE approvals SET status = $2, decided_at = now(), decided_by = $3, decision_note = $4 WHERE id = $1 AND status = 'pending' RETURNING *`,
      [id, decision, actor, note ?? null],
    );
    if (!rows[0]) throw new AppError('not_pending', `Approval ${id} is not pending`, 409);
    return rows[0];
  }

  async get(id: string): Promise<ApprovalRow> {
    const { rows } = await this.#db.query('SELECT * FROM approvals WHERE id = $1', [id]);
    if (!rows[0]) throw new AppError('not_found', `Approval ${id} not found`, 404);
    return rows[0];
  }

  async list(opts: { projectId?: string | null; status?: string | null } = {}): Promise<ApprovalRow[]> {
    const { rows } = await this.#db.query(
      `SELECT * FROM approvals WHERE ($1::text IS NULL OR project_id = $1) AND ($2::text IS NULL OR status = $2) ORDER BY requested_at DESC LIMIT 200`,
      [opts.projectId ?? null, opts.status ?? null],
    );
    return rows;
  }
}
