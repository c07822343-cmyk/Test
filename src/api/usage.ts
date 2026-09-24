// Cost / usage awareness: NVIDIA requests, tokens, failures, retries and
// avoided work (cache hits, duplicate prevention) per project, agent and model.
import type { Db } from '../db/pool.ts';

export async function usageReport(db: Db, projectId?: string | null) {
  const p = projectId ?? null;
  const [totals, byAgent, byModel, byProject, retries, savings] = await Promise.all([
    db.query(
      `SELECT count(*)::int AS requests,
              count(*) FILTER (WHERE status = 'ok')::int AS ok,
              count(*) FILTER (WHERE status NOT IN ('ok', 'granted', 'in_flight'))::int AS failed,
              coalesce(sum((usage->>'prompt_tokens')::int), 0)::int AS prompt_tokens,
              coalesce(sum((usage->>'completion_tokens')::int), 0)::int AS completion_tokens
       FROM key_requests WHERE ($1::text IS NULL OR project_id = $1)`,
      [p],
    ),
    db.query(
      `SELECT coalesce(agent_type, purpose, 'unattributed') AS agent, count(*)::int AS requests,
              count(*) FILTER (WHERE status NOT IN ('ok', 'granted', 'in_flight'))::int AS failed,
              coalesce(sum((usage->>'total_tokens')::int), 0)::int AS tokens, round(avg(latency_ms))::int AS avg_latency_ms
       FROM key_requests WHERE ($1::text IS NULL OR project_id = $1) GROUP BY 1 ORDER BY requests DESC`,
      [p],
    ),
    db.query(
      `SELECT model, count(*)::int AS requests, count(*) FILTER (WHERE status NOT IN ('ok', 'granted', 'in_flight'))::int AS failed,
              coalesce(sum((usage->>'total_tokens')::int), 0)::int AS tokens
       FROM key_requests WHERE ($1::text IS NULL OR project_id = $1) GROUP BY model ORDER BY requests DESC`,
      [p],
    ),
    db.query(
      `SELECT project_id, count(*)::int AS requests, coalesce(sum((usage->>'total_tokens')::int), 0)::int AS tokens
       FROM key_requests WHERE project_id IS NOT NULL AND ($1::text IS NULL OR project_id = $1) GROUP BY project_id ORDER BY requests DESC LIMIT 50`,
      [p],
    ),
    db.query(
      `SELECT count(*) FILTER (WHERE type LIKE 'retry_scheduled%')::int AS retries,
              count(*) FILTER (WHERE type = 'revision_requested')::int AS revisions,
              count(*) FILTER (WHERE type = 'fix_cycle_started')::int AS fix_cycles
       FROM task_events WHERE ($1::text IS NULL OR project_id = $1)`,
      [p],
    ),
    db.query(`SELECT kind, count(*)::int AS n FROM usage_savings WHERE ($1::text IS NULL OR project_id = $1) GROUP BY kind`, [p]),
  ]);
  const saved: Record<string, number> = {};
  for (const r of savings.rows) saved[r.kind] = r.n;
  const t = totals.rows[0];
  return {
    scope: p ?? 'all projects',
    nvidia: { ...t, success_rate: t.requests ? Number((t.ok / t.requests).toFixed(3)) : null },
    by_agent: byAgent.rows,
    by_model: byModel.rows,
    by_project: byProject.rows,
    work: retries.rows[0],
    avoided: {
      model_calls_saved_by_cache: saved['cache_hit:model_response'] ?? 0,
      web_fetches_saved_by_cache: saved['cache_hit:web_page'] ?? 0,
      duplicate_tasks_prevented: saved.duplicate_task_prevented ?? 0,
    },
  };
}
