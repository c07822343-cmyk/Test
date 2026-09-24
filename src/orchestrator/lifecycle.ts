// Project lifecycle state machine. The Main Agent always knows where a project
// is: INTAKE → RESEARCH → PLANNING → DESIGN → DEVELOPMENT → CONTENT →
// INTEGRATION → TESTING → QA → REVISION → FINAL_REVIEW → READY_FOR_HANDOFF →
// COMPLETED. The stage is derived from real task state (the frontier of active
// work) and every change is recorded in project_stage_history.
import type { Db } from '../db/pool.ts';
import type { ProjectRow, TaskRow } from '../queue/types.ts';
import { getAgent } from '../agents/registry.ts';

export const STAGES = [
  'INTAKE', 'RESEARCH', 'PLANNING', 'DESIGN', 'DEVELOPMENT', 'CONTENT', 'INTEGRATION',
  'TESTING', 'QA', 'REVISION', 'FINAL_REVIEW', 'READY_FOR_HANDOFF', 'COMPLETED',
] as const;
export type Stage = (typeof STAGES)[number];

const ORDER = new Map<string, number>(STAGES.map((s, i) => [s, i]));

/** Stage a task belongs to right now (revisions and fixes count as REVISION). */
export function taskStage(t: Pick<TaskRow, 'stage' | 'agent_type' | 'kind' | 'revision'>): Stage {
  if (t.kind === 'fix' || t.revision > 0) return 'REVISION';
  if (t.kind === 'triage') return 'FINAL_REVIEW';
  if (t.kind === 'visual_qa' || t.kind === 'qa') return 'QA';
  const s = (t.stage ?? getAgent(t.agent_type).stage ?? 'DEVELOPMENT') as Stage;
  return ORDER.has(s) ? s : 'DEVELOPMENT';
}

const ACTIVE = new Set(['ASSIGNED', 'RUNNING', 'REVIEW', 'RETRYING']);
const PENDING = new Set(['QUEUED', 'WAITING']);

export function computeStage(project: Pick<ProjectRow, 'status' | 'plan'>, tasks: TaskRow[]): Stage {
  // Assembled and awaiting the client's approval = ready for handoff; approved = completed.
  if (project.status === 'APPROVED') return 'COMPLETED';
  if (project.status === 'COMPLETED' || project.status === 'ASSEMBLING') return 'READY_FOR_HANDOFF';
  const work = tasks.filter((t) => t.kind !== 'root');
  if (project.status === 'PLANNING' || project.status === 'AWAITING_APPROVAL') return project.plan ? 'PLANNING' : 'INTAKE';
  const active = work.filter((t) => ACTIVE.has(t.status));
  if (active.length) return active.map(taskStage).sort((a, b) => ORDER.get(b)! - ORDER.get(a)!)[0];
  const pending = work.filter((t) => PENDING.has(t.status));
  if (pending.length) return pending.map(taskStage).sort((a, b) => ORDER.get(a)! - ORDER.get(b)!)[0];
  return work.length ? 'READY_FOR_HANDOFF' : 'INTAKE';
}

export class LifecycleTracker {
  #db: Db;
  constructor(db: Db) {
    this.#db = db;
  }

  /** Recomputes and records the project's stage. Returns the new stage if it changed. */
  async refresh(projectId: string, reason = 'task progress'): Promise<Stage | null> {
    const [{ rows: p }, { rows: tasks }] = await Promise.all([
      this.#db.query('SELECT id, status, plan, stage FROM projects WHERE id = $1', [projectId]),
      this.#db.query('SELECT stage, agent_type, kind, revision, status FROM tasks WHERE project_id = $1', [projectId]),
    ]);
    if (!p[0]) return null;
    const next = computeStage(p[0], tasks);
    if (next === p[0].stage) return null;
    const upd = await this.#db.query(`UPDATE projects SET stage = $2, updated_at = now() WHERE id = $1 AND stage = $3 RETURNING id`, [projectId, next, p[0].stage]);
    if (!upd.rowCount) return null;
    await this.#db.query('INSERT INTO project_stage_history (project_id, from_stage, to_stage, reason) VALUES ($1, $2, $3, $4)', [projectId, p[0].stage, next, reason]);
    return next;
  }

  async history(projectId: string) {
    const { rows } = await this.#db.query('SELECT from_stage, to_stage, reason, at FROM project_stage_history WHERE project_id = $1 ORDER BY id', [projectId]);
    return rows;
  }
}
