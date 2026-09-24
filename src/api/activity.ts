// Live agent activity feed. Every line is rendered from a real backend event
// (task_events, stage history, approvals, security events, Main Agent
// messages) - nothing is synthesised for display.
import { getAgent, hasAgent } from '../agents/registry.ts';
import type { Db } from '../db/pool.ts';

export interface ActivityItem {
  id: string;
  at: Date;
  project_id: string | null;
  task_id: string | null;
  actor: string;
  agent: string;
  headline: string;
  kind: string;
  severity: 'info' | 'progress' | 'success' | 'warning' | 'error';
}

function agentName(type: string | null): string {
  return type && hasAgent(type) ? getAgent(type).name : 'System';
}

function short(s: unknown, n = 110): string {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
}

export function describeTaskEvent(e: { type: string; detail: any; agent_type: string; title: string; actor: string; to_status: string | null }): { headline: string; severity: ActivityItem['severity']; agent: string } | null {
  const d = e.detail ?? {};
  const agent = agentName(e.agent_type);
  const t = `"${short(e.title, 70)}"`;
  switch (e.type) {
    case 'created':
      return { agent: 'Main Agent', headline: `Delegated ${t} to ${agent}${d.skills?.length ? ` with ${d.skills.length} skill(s)` : ''}`, severity: 'info' };
    case 'dependencies_satisfied':
      return { agent, headline: `${t} is ready: all inputs are complete`, severity: 'info' };
    case 'started':
      return { agent, headline: `${d.phase === 'synthesize' ? 'Synthesising sub-agent results for' : 'Working on'} ${t}${d.attempt > 1 ? ` (attempt ${d.attempt})` : ''}`, severity: 'progress' };
    case 'tool_started':
      return { agent, headline: `Running ${String(d.tool).replace(/_/g, ' ')}…`, severity: 'progress' };
    case 'tool_finished':
      return d.available === false ? { agent, headline: `${String(d.tool).replace(/_/g, ' ')} unavailable in this environment`, severity: 'warning' } : { agent, headline: `${String(d.tool).replace(/_/g, ' ')}: ${d.findings} finding(s)${d.hard_failures ? `, ${d.hard_failures} blocking` : ''}`, severity: d.hard_failures ? 'warning' : 'info' };
    case 'model_selected':
      return { agent: 'Model Router', headline: `${agent} → ${d.model} (${d.capability})`, severity: 'info' };
    case 'key_leased':
      return { agent: 'Key Manager', headline: `${agent} leased ${d.key} (${d.window_used}/${d.ceiling} RPM)`, severity: 'info' };
    case 'cache_hit':
      return { agent, headline: `Reused an identical earlier answer for ${t} (no NVIDIA call)`, severity: 'success' };
    case 'model_responded':
      return { agent, headline: `Received ${d.model} response in ${Math.round((d.latency_ms ?? 0) / 100) / 10}s; validating`, severity: 'progress' };
    case 'completed':
      return { agent, headline: `Completed ${t}${d.verdict ? ` — verdict: ${d.verdict}` : ''}${d.files ? ` (${d.files} file(s))` : ''}`, severity: 'success' };
    case 'subtasks_spawned':
      return { agent, headline: `Spawned ${d.subtasks?.length ?? 0} sub-agent(s): ${(d.subtasks ?? []).map((x: any) => agentName(x.agent)).join(', ')}`, severity: 'info' };
    case 'revision_requested':
      return { agent: agentName(String(e.actor).replace('agent:', '')), headline: `Sent ${t} back to ${agent} with ${d.issues} issue(s) (round ${d.round})`, severity: 'warning' };
    case 'awaiting_revision':
      return { agent, headline: `Waiting for the revised work before reviewing again`, severity: 'info' };
    case 'fix_cycle_started':
      return { agent, headline: `Found ${d.issues} issue(s)${d.first_issue ? `: ${short(d.first_issue, 70)}` : ''} — fix cycle ${d.cycle}${d.previous_score != null ? ` (score ${d.previous_score} → ${d.score})` : ''}`, severity: 'warning' };
    case 'triage_decided':
      return { agent: 'Main Agent', headline: `Triage: accepted ${d.accepted} finding(s), rejected ${d.rejected}; fixes go through change review`, severity: 'info' };
    case 'skill_validation_failed':
      return { agent, headline: `Output failed skill validation: ${short((d.failures ?? []).map((f: any) => f.rule).join(', '), 80)}`, severity: 'warning' };
    case 'claims_downgraded':
      return { agent: 'Provenance', headline: `${d.downgraded} of ${d.total} research claim(s) downgraded (not supported by fetched sources)`, severity: 'warning' };
    case 'duplicate_prevented':
      return { agent: 'Main Agent', headline: `Skipped duplicate request "${short(d.requested_title, 60)}" (identical work already active)`, severity: 'success' };
    case 'dependencies_extended':
      return { agent: 'Main Agent', headline: `${t} now also waits for new fix/review work`, severity: 'info' };
    case 'blocked':
      return { agent, headline: `${t} blocked: an upstream task failed`, severity: 'error' };
    case 'failed_escalated':
      return { agent: 'Main Agent', headline: `${t} failed after retries and a rescue attempt — escalated to you`, severity: 'error' };
    case 'failed_optional':
      return { agent: 'Main Agent', headline: `Optional task ${t} failed; continuing without it`, severity: 'warning' };
    case 'cancelled':
      return { agent, headline: `${t} cancelled`, severity: 'warning' };
    case 'human_retry':
    case 'human_reassign':
    case 'human_override':
      return { agent: 'You', headline: `${e.type.replace('human_', '')} on ${t}`, severity: 'info' };
    case 'watchdog_stuck':
    case 'watchdog_orphaned':
    case 'watchdog_released_claim':
      return { agent: 'Watchdog', headline: `Recovered ${t}: ${short(d.reason, 80)}`, severity: 'warning' };
    case 'assembled':
      return { agent: 'Main Agent', headline: 'Final package assembled and completion report written', severity: 'success' };
    case 'interpreted':
      return { agent: 'Main Agent', headline: `Interpreted the request as ${String(d.intent).replace(/_/g, ' ')}: ${short(d.name, 60)}`, severity: 'info' };
    case 'blueprint_created':
      return { agent: 'Main Agent', headline: `Project blueprint created (${d.pages} page(s), ${d.requirements} requirement(s))`, severity: 'info' };
    case 'skills_selected':
      return { agent: 'Main Agent', headline: `Selected skill chain: ${short((d.skills ?? []).join(', '), 100)}`, severity: 'info' };
    case 'planned':
      return { agent: 'Main Agent', headline: `Planned ${d.tasks} tasks over ${d.levels} dependency levels`, severity: 'info' };
    case 'graph_enqueued':
      return { agent: 'Main Agent', headline: `Task graph enqueued (${d.tasks} tasks)`, severity: 'info' };
    default:
      if (e.type.startsWith('retry_scheduled')) {
        const action = e.type.split(':')[1];
        return { agent: 'Error / Retry Manager', headline: `${t}: ${short(d.error?.class, 30)} → ${String(action).replace(/_/g, ' ')}${d.decision?.nextModel ? ` (${d.decision.nextModel})` : ''}`, severity: 'warning' };
      }
      return null;
  }
}

export async function activityFeed(db: Db, opts: { projectId?: string | null; sinceId?: number; limit?: number } = {}): Promise<{ items: ActivityItem[]; cursor: number }> {
  const limit = Math.min(opts.limit ?? 200, 500);
  const { rows } = await db.query(
    `SELECT e.id, e.at, e.project_id, e.task_id, e.type, e.detail, e.actor, e.to_status, t.agent_type, t.title
     FROM task_events e LEFT JOIN tasks t ON t.id = e.task_id
     WHERE ($1::text IS NULL OR e.project_id = $1) AND e.id > $2 AND e.type NOT IN ('claimed', 'model_selected', 'key_leased')
     ORDER BY e.id DESC LIMIT $3`,
    [opts.projectId ?? null, opts.sinceId ?? 0, limit],
  );
  const items: ActivityItem[] = [];
  for (const r of rows.reverse()) {
    const d = describeTaskEvent(r);
    if (d) items.push({ id: `ev${r.id}`, at: r.at, project_id: r.project_id, task_id: r.task_id, actor: r.actor, agent: d.agent, headline: d.headline, kind: r.type, severity: d.severity });
  }
  const cursor = rows.length ? Math.max(...rows.map((r) => Number(r.id))) : opts.sinceId ?? 0;
  if (!opts.sinceId) {
    // Stage changes, approvals and security events enrich the initial page.
    const [stages, approvals, security] = await Promise.all([
      db.query(`SELECT id, project_id, to_stage, from_stage, reason, at FROM project_stage_history WHERE ($1::text IS NULL OR project_id = $1) ORDER BY id DESC LIMIT 50`, [opts.projectId ?? null]),
      db.query(`SELECT id, project_id, gate, title, status, requested_at, decided_at FROM approvals WHERE ($1::text IS NULL OR project_id = $1) ORDER BY requested_at DESC LIMIT 20`, [opts.projectId ?? null]),
      db.query(`SELECT id, project_id, task_id, source, kind, flags, action, at FROM security_events WHERE ($1::text IS NULL OR project_id = $1) ORDER BY id DESC LIMIT 20`, [opts.projectId ?? null]),
    ]);
    for (const s of stages.rows) items.push({ id: `st${s.id}`, at: s.at, project_id: s.project_id, task_id: null, actor: 'main_agent', agent: 'Main Agent', headline: `Project stage: ${s.from_stage ?? '—'} → ${s.to_stage}`, kind: 'stage', severity: 'info' });
    for (const a of approvals.rows) items.push({ id: `ap${a.id}`, at: a.decided_at ?? a.requested_at, project_id: a.project_id, task_id: null, actor: 'main_agent', agent: 'Main Agent', headline: a.status === 'pending' ? `Waiting for your approval: ${a.title}` : `Approval "${a.title}" ${a.status}`, kind: 'approval', severity: a.status === 'pending' ? 'warning' : 'info' });
    for (const x of security.rows) items.push({ id: `se${x.id}`, at: x.at, project_id: x.project_id, task_id: x.task_id, actor: 'security', agent: 'Security Screening', headline: `${x.kind === 'permission_denied' ? 'Blocked tool use' : 'Neutralised external content'}: ${x.flags.join(', ')} (${short(x.source, 60)})`, kind: 'security', severity: 'warning' });
    items.sort((a, b) => +new Date(a.at) - +new Date(b.at));
  }
  return { items, cursor };
}
