// Verifies that what n8n shows matches backend state: every pipeline execution
// n8n recorded maps to steps the core recorded for real tasks, and every task
// the core ran under the n8n driver was executed by an n8n execution.
//
// Env: DATABASE_URL (core), N8N_DATABASE_URL (n8n's Postgres), PROJECT_ID (optional)
import pg from 'pg';

const core = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const n8n = new pg.Pool({ connectionString: process.env.N8N_DATABASE_URL });
const projectId = process.env.PROJECT_ID ?? null;

try {
  // With PROJECT_ID, n8n executions are limited to the project's lifetime (n8n
  // does not index executions by project); run it when no other project overlaps.
  let window: { from: Date | null; to: Date | null } = { from: null, to: null };
  if (projectId) {
    const { rows } = await core.query(`SELECT created_at, coalesce(completed_at, now()) AS completed_at FROM projects WHERE id = $1`, [projectId]);
    if (!rows[0]) throw new Error(`project ${projectId} not found`);
    window = { from: rows[0].created_at, to: new Date(new Date(rows[0].completed_at).getTime() + 5_000) };
  }
  const { rows: n8nRows } = await n8n.query(
    `SELECT w.name AS workflow, e.id::text AS execution_id, e.status FROM execution_entity e JOIN workflow_entity w ON w.id = e."workflowId"
     WHERE w.name LIKE 'ApexWeb%' AND ($1::timestamptz IS NULL OR e."startedAt" >= $1) AND ($2::timestamptz IS NULL OR e."startedAt" <= $2)`,
    [window.from, window.to],
  );
  const { rows: coreRuns } = await core.query(
    `SELECT DISTINCT workflow, execution_id FROM workflow_runs WHERE ($1::text IS NULL OR project_id = $1)`,
    [projectId],
  );
  // Pipeline executions in the window may belong to housekeeping steps recorded without a project.
  const { rows: allCoreRuns } = await core.query(`SELECT DISTINCT execution_id FROM workflow_runs`);
  const n8nIds = new Map(n8nRows.map((r) => [r.execution_id, r]));
  const missingInN8n = coreRuns.filter((r) => !n8nIds.has(r.execution_id));
  const pipelines = n8nRows.filter((r) => /Pipeline|Key Manager|Model Router/.test(r.workflow));
  const coreIds = new Set(allCoreRuns.map((r) => r.execution_id));
  const pipelinesWithoutCoreSteps = pipelines.filter((r) => !coreIds.has(r.execution_id));
  const { rows: tasks } = await core.query(
    `SELECT t.id, t.plan_key, t.status, t.workflow_execution_id FROM tasks t WHERE t.kind NOT IN ('root', 'approval') AND t.status = 'COMPLETED' AND ($1::text IS NULL OR t.project_id = $1)`,
    [projectId],
  );
  const cachedOrOverridden = await core.query(`SELECT DISTINCT task_id FROM task_events WHERE type IN ('human_override', 'approved')`);
  const exempt = new Set(cachedOrOverridden.rows.map((r) => r.task_id));
  const tasksWithoutExecution = tasks.filter((t) => !exempt.has(t.id) && (!t.workflow_execution_id || !n8nIds.has(t.workflow_execution_id)));
  const failedExecutions = n8nRows.filter((r) => r.status === 'error' || r.status === 'crashed');
  const byWorkflow: Record<string, number> = {};
  for (const r of n8nRows) byWorkflow[r.workflow] = (byWorkflow[r.workflow] ?? 0) + 1;
  const result = {
    window: projectId ? window : 'all time',
    n8n_executions: n8nRows.length,
    by_workflow: byWorkflow,
    core_recorded_executions: coreRuns.length,
    core_steps_without_n8n_execution: missingInN8n.length,
    n8n_pipeline_executions_without_core_steps: pipelinesWithoutCoreSteps.length,
    completed_tasks: tasks.length,
    completed_tasks_without_n8n_execution: tasksWithoutExecution.map((t) => t.plan_key),
    failed_n8n_executions: failedExecutions.length,
    parity: missingInN8n.length === 0 && pipelinesWithoutCoreSteps.length === 0 && tasksWithoutExecution.length === 0,
  };
  console.log(JSON.stringify(result, null, 2));
  process.exitCode = result.parity ? 0 : 1;
} finally {
  await core.end();
  await n8n.end();
}
