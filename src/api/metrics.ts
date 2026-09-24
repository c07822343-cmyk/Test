// Observability: every number here is computed from live runtime state
// (Postgres ledger + key pool snapshots). Nothing is sampled, mocked or cached.
import { AGENTS } from '../agents/registry.ts';
import type { Services } from '../services.ts';

export async function collectMetrics(s: Services) {
  const [statusRows, agentRows, latencyRows, durationRows, projectRows, deadRows] = await Promise.all([
    s.db.query(`SELECT status, count(*)::int AS n FROM tasks WHERE kind <> 'root' GROUP BY status`),
    s.db.query(`SELECT agent_type, count(*)::int AS n FROM tasks WHERE status IN ('ASSIGNED', 'RUNNING', 'REVIEW') GROUP BY agent_type`),
    s.db.query(
      `SELECT count(*)::int AS requests,
              count(*) FILTER (WHERE status IN ('rate_limited', 'server_error', 'timeout', 'network_error', 'auth_error'))::int AS errors,
              count(*) FILTER (WHERE status = 'rate_limited')::int AS rate_limited,
              percentile_cont(0.5) WITHIN GROUP (ORDER BY latency_ms) FILTER (WHERE status = 'ok') AS p50,
              percentile_cont(0.95) WITHIN GROUP (ORDER BY latency_ms) FILTER (WHERE status = 'ok') AS p95,
              count(*) FILTER (WHERE granted_at > clock_timestamp() - interval '60 seconds')::int AS last_minute
       FROM key_requests WHERE granted_at > clock_timestamp() - interval '5 minutes'`,
    ),
    s.db.query(
      `SELECT agent_type, count(*)::int AS n, round(avg(extract(epoch FROM completed_at - started_at)))::int AS avg_s,
              round(percentile_cont(0.95) WITHIN GROUP (ORDER BY extract(epoch FROM completed_at - started_at)))::int AS p95_s
       FROM tasks WHERE status = 'COMPLETED' AND started_at IS NOT NULL AND completed_at > now() - interval '24 hours' AND kind <> 'root'
       GROUP BY agent_type ORDER BY agent_type`,
    ),
    s.db.query(
      `SELECT p.id, p.name, p.status, p.paused,
              count(t.*) FILTER (WHERE t.kind <> 'root')::int AS total,
              count(t.*) FILTER (WHERE t.kind <> 'root' AND t.status = 'COMPLETED')::int AS completed,
              count(t.*) FILTER (WHERE t.kind <> 'root' AND t.status IN ('FAILED', 'BLOCKED'))::int AS problems
       FROM projects p LEFT JOIN tasks t ON t.project_id = p.id
       WHERE p.status IN ('PLANNING', 'RUNNING', 'PAUSED', 'NEEDS_ATTENTION', 'ASSEMBLING') OR p.updated_at > now() - interval '1 hour'
       GROUP BY p.id ORDER BY p.created_at DESC LIMIT 20`,
    ),
    s.db.query(`SELECT count(*)::int AS n FROM dead_letters WHERE resolved_at IS NULL`),
  ]);
  const byStatus: Record<string, number> = {};
  for (const r of statusRows.rows) byStatus[r.status] = r.n;
  const activeAgents: Record<string, number> = {};
  for (const r of agentRows.rows) activeAgents[r.agent_type] = r.n;
  const keys = await s.keyPool.snapshots();
  const l = latencyRows.rows[0];
  const ready = (await s.db.query(
    `SELECT count(*)::int AS n FROM tasks WHERE (status = 'QUEUED' OR (status = 'RETRYING' AND (not_before IS NULL OR not_before <= now()))) AND kind <> 'root'`,
  )).rows[0].n;
  return {
    generated_at: new Date().toISOString(),
    uptime_s: Math.round((Date.now() - s.startedAt.getTime()) / 1000),
    driver: s.driver.kind,
    tasks: {
      active: (byStatus.RUNNING ?? 0) + (byStatus.ASSIGNED ?? 0) + (byStatus.REVIEW ?? 0),
      queued: byStatus.QUEUED ?? 0,
      waiting: byStatus.WAITING ?? 0,
      retrying: byStatus.RETRYING ?? 0,
      completed: byStatus.COMPLETED ?? 0,
      failed: byStatus.FAILED ?? 0,
      blocked: byStatus.BLOCKED ?? 0,
      cancelled: byStatus.CANCELLED ?? 0,
      by_status: byStatus,
      queue_depth: ready,
      waiting_for_nvidia_capacity: s.keyPool.waitingCount,
      dead_letters_open: deadRows.rows[0].n,
    },
    agents: {
      registered: AGENTS.length,
      active: Object.keys(activeAgents).length,
      idle: AGENTS.length - Object.keys(activeAgents).length,
      active_by_type: activeAgents,
    },
    nvidia: {
      ceiling_per_key: s.config.nvidia.rpmPerKey,
      window_ms: s.config.nvidia.windowMs,
      strategy: s.keyPool.strategyName,
      requests_last_minute: l.last_minute,
      requests_last_5m: l.requests,
      error_rate_5m: l.requests ? Number((l.errors / l.requests).toFixed(3)) : 0,
      rate_limited_5m: l.rate_limited,
      latency_p50_ms: l.p50 == null ? null : Math.round(Number(l.p50)),
      latency_p95_ms: l.p95 == null ? null : Math.round(Number(l.p95)),
      keys: keys.map((k) => ({
        id: k.id,
        masked: k.masked,
        health: k.health,
        active: k.active,
        disabled_reason: k.disabledReason,
        rpm_used: k.windowCount,
        rpm_ceiling: k.ceiling,
        remaining: k.remaining,
        inflight: k.inflight,
        cooldown_ms: k.cooldownRemainingMs,
        current_model: k.currentModel,
        latency_p50_ms: k.latencyP50Ms,
        latency_p95_ms: k.latencyP95Ms,
        error_rate_5m: Number(k.errorRate.toFixed(3)),
        recent_429: k.recent429,
        recent_5xx: k.recent5xx,
        recent_timeouts: k.recentTimeouts,
        consecutive_failures: k.consecutiveFailures,
        total_requests: k.totalRequests,
        last_used_at: k.lastUsedAt,
      })),
    },
    models: s.router.describe().map((m) => ({ id: m.id, available: m.available, reason: m.unavailable_reason, vision: m.vision, preferred_tasks: m.preferred_tasks })),
    projects: projectRows.rows.map((p) => ({ ...p, progress: p.total ? Math.round((100 * p.completed) / p.total) : 0 })),
    task_duration_24h: durationRows.rows,
  };
}

export function renderBar(used: number, ceiling: number, width = 23): string {
  const filled = ceiling > 0 ? Math.round((Math.min(used, ceiling) / ceiling) * width) : 0;
  return `${'█'.repeat(filled)}${'░'.repeat(width - filled)}`;
}

export function renderMetricsText(m: Awaited<ReturnType<typeof collectMetrics>>): string {
  const lines: string[] = [];
  lines.push(`APEXWEB OS — ${m.generated_at} — driver: ${m.driver}`);
  lines.push('');
  for (const k of m.nvidia.keys) {
    lines.push(`${k.id.replace('key_', 'KEY ')} [${k.health}${k.cooldown_ms ? ` ${Math.ceil(k.cooldown_ms / 1000)}s` : ''}] ${k.current_model ?? ''}`);
    lines.push(`${renderBar(k.rpm_used, k.rpm_ceiling)} ${k.rpm_used}/${k.rpm_ceiling} RPM   inflight ${k.inflight}   p50 ${k.latency_p50_ms ?? '-'}ms   err ${(k.error_rate_5m * 100).toFixed(1)}%`);
  }
  lines.push('');
  lines.push(`Tasks: ${m.tasks.active} active · ${m.tasks.queued} queued · ${m.tasks.waiting} waiting · ${m.tasks.retrying} retrying · ${m.tasks.completed} completed · ${m.tasks.failed} failed · ${m.tasks.blocked} blocked`);
  lines.push(`Queue depth ${m.tasks.queue_depth} · waiting for NVIDIA capacity ${m.tasks.waiting_for_nvidia_capacity} · dead letters ${m.tasks.dead_letters_open}`);
  lines.push(`Agents: ${m.agents.active} active / ${m.agents.idle} idle (${m.agents.registered} registered)`);
  lines.push(`NVIDIA: ${m.nvidia.requests_last_minute} req/min · p50 ${m.nvidia.latency_p50_ms ?? '-'}ms · p95 ${m.nvidia.latency_p95_ms ?? '-'}ms · error rate ${(m.nvidia.error_rate_5m * 100).toFixed(1)}%`);
  for (const p of m.projects) lines.push(`Project ${p.name.slice(0, 40)} [${p.status}] ${renderBar(p.completed, p.total || 1, 20)} ${p.completed}/${p.total}`);
  return lines.join('\n');
}
