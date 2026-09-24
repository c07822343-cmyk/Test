// Human override controls. The operator can always intervene: cancel, retry,
// reassign, override a result, continue from a failed step. Every action is
// validated against the state machine and written to the audit log.
import { getAgent, hasAgent } from '../agents/registry.ts';
import type { Services } from '../services.ts';
import type { TaskRow } from '../queue/types.ts';
import { AppError } from '../util/common.ts';

const IDLE: TaskRow['status'][] = ['QUEUED', 'WAITING', 'RETRYING', 'BLOCKED', 'FAILED', 'CANCELLED'];

async function reopenProject(s: Services, projectId: string): Promise<void> {
  const p = await s.projects.get(projectId);
  if (p.status === 'NEEDS_ATTENTION' && p.plan) await s.projects.transition(projectId, ['NEEDS_ATTENTION'], 'RUNNING');
  if (p.status === 'COMPLETED' || p.status === 'APPROVED') {
    await s.db.query(`UPDATE projects SET status = 'RUNNING', final_report = NULL, completed_at = NULL, updated_at = now() WHERE id = $1`, [projectId]);
    await s.db.query(`UPDATE tasks SET status = 'WAITING', updated_at = now() WHERE project_id = $1 AND kind = 'root' AND status = 'COMPLETED'`, [projectId]);
  }
}

export async function cancelTask(s: Services, taskId: string, actor: string): Promise<TaskRow> {
  const t = await s.queue.get(taskId);
  if (['COMPLETED', 'FAILED', 'CANCELLED'].includes(t.status)) throw new AppError('terminal', `Task is already ${t.status}`, 409);
  if (t.kind === 'root') throw new AppError('root_task', 'Cancel the project instead of its root task', 409);
  const out = await s.queue.transition(taskId, [t.status], 'CANCELLED', { completed_at: new Date(), lease_owner: null, lease_expires_at: null }, { type: 'cancelled', actor });
  s.queue.emit('task_cancelled', { taskId });
  await s.projects.audit(actor, 'task.cancel', 'task', taskId);
  await s.executor.afterTerminal(out);
  return out;
}

/** Retry / continue from a failed step: fresh attempts, dependents unblocked, project resumed. */
export async function retryTask(s: Services, taskId: string, actor: string): Promise<TaskRow> {
  const t = await s.queue.get(taskId);
  if (!['FAILED', 'CANCELLED', 'BLOCKED', 'RETRYING'].includes(t.status)) throw new AppError('not_retryable', `Task is ${t.status}; only FAILED, CANCELLED, BLOCKED or RETRYING tasks can be retried`, 409);
  const inputs = { ...t.inputs };
  delete inputs.rescued;
  delete inputs.previous_attempt_error;
  const out = await s.queue.transition(taskId, [t.status], t.dependencies.length ? 'WAITING' : 'QUEUED', {
    attempt: 0, capacity_waits: 0, error: null, inputs, not_before: null, completed_at: null,
  }, { type: 'human_retry', actor });
  await s.db.query(`UPDATE dead_letters SET resolved_at = now(), resolution = 'retried by ' || $2 WHERE task_id = $1 AND resolved_at IS NULL`, [taskId, actor]);
  await s.projects.audit(actor, 'task.retry', 'task', taskId);
  await reopenProject(s, t.project_id);
  await s.queue.unblockDependents(t.project_id, actor);
  s.queue.emit('tasks_ready', { projectId: t.project_id });
  return s.queue.get(out.id);
}

export async function reassignTask(s: Services, taskId: string, body: { agent_type?: string; model?: string | null }, actor: string): Promise<TaskRow> {
  const t = await s.queue.get(taskId);
  if (!IDLE.includes(t.status)) throw new AppError('busy', `Task is ${t.status}; reassign it when it is not executing`, 409);
  const patch: Record<string, unknown> = {};
  if (body.agent_type) {
    if (!hasAgent(body.agent_type) || body.agent_type === 'main_orchestrator') throw new AppError('unknown_agent', `Unknown agent type ${body.agent_type}`);
    if (getAgent(body.agent_type).reviewer !== getAgent(t.agent_type).reviewer && (t.kind === 'review' || t.kind === 'qa')) {
      throw new AppError('incompatible_agent', 'A review/QA gate must be assigned to a reviewer agent');
    }
    patch.agent_type = body.agent_type;
  }
  if (body.model !== undefined) {
    if (body.model && !s.router.get(body.model)) throw new AppError('unknown_model', `Model ${body.model} is not in the registry`);
    patch.model_override = body.model;
  }
  const next = ['FAILED', 'CANCELLED'].includes(t.status) ? (t.dependencies.length ? 'WAITING' : 'QUEUED') : t.status;
  const out = await s.queue.transition(taskId, [t.status], next, { ...patch, attempt: 0, capacity_waits: 0, error: null }, { type: 'human_reassign', actor, detail: body });
  await s.projects.audit(actor, 'task.reassign', 'task', taskId, body);
  if (next !== t.status) {
    await reopenProject(s, t.project_id);
    await s.queue.unblockDependents(t.project_id, actor);
  }
  s.queue.emit('tasks_ready', { projectId: t.project_id });
  return out;
}

export async function overrideResult(s: Services, taskId: string, body: { summary: string; result?: Record<string, unknown>; verdict?: 'approve' | 'reject' }, actor: string): Promise<TaskRow> {
  const t = await s.queue.get(taskId);
  if (!IDLE.includes(t.status) && t.status !== 'COMPLETED') throw new AppError('busy', `Task is ${t.status}; cancel it first or wait for the step to finish`, 409);
  const outputs = {
    ...(t.outputs ?? {}),
    status: 'completed',
    summary: body.summary,
    result: body.result ?? t.outputs?.result ?? {},
    review: body.verdict ? { verdict: body.verdict, issues: [], strengths: [], overridden: true } : t.outputs?.review ?? null,
    overridden_by: actor,
    overridden_at: new Date().toISOString(),
    confidence: 1,
    assumptions: t.outputs?.assumptions ?? [],
    unresolved_issues: t.outputs?.unresolved_issues ?? [],
  };
  let out: TaskRow;
  if (t.status === 'COMPLETED') {
    await s.db.query(`UPDATE tasks SET outputs = $2, updated_at = now() WHERE id = $1`, [taskId, JSON.stringify(outputs)]);
    await s.queue.recordEvent(s.db, t, 'human_override', 'COMPLETED', 'COMPLETED', actor);
    out = await s.queue.get(taskId);
  } else {
    out = await s.queue.transition(taskId, [t.status], 'COMPLETED', { outputs, error: null, completed_at: new Date() }, { type: 'human_override', actor });
  }
  await s.projects.audit(actor, 'task.override', 'task', taskId, { verdict: body.verdict ?? null });
  await reopenProject(s, t.project_id);
  await s.queue.unblockDependents(t.project_id, actor);
  await s.executor.afterTerminal(out);
  s.queue.emit('tasks_ready', { projectId: t.project_id });
  return out;
}
