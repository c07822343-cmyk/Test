// Project retrospective: what worked, what failed, recurring issues, successful
// patterns, common revisions, performance lessons and QA findings - computed
// from the recorded task history. Reusable lessons become *candidate*
// knowledge entries that require explicit promotion; anything carrying
// client-specific details is refused.
import { z } from 'zod';
import { extractJsonObject } from '../agents/output.ts';
import { getAgent } from '../agents/registry.ts';
import type { Db } from '../db/pool.ts';
import { containsProjectSpecifics, KnowledgeSchema, type KnowledgeBase } from '../knowledge/kb.ts';
import type { NvidiaProvider } from '../provider/provider.ts';
import { errorMessage, logger } from '../util/log.ts';

const log = logger('retrospective');

export async function retrospectiveFacts(db: Db, projectId: string) {
  const { rows: tasks } = await db.query(`SELECT agent_type, plan_key, kind, status, attempt, revision, outputs, error FROM tasks WHERE project_id = $1 AND kind <> 'root'`, [projectId]);
  const { rows: events } = await db.query(`SELECT type, detail FROM task_events WHERE project_id = $1 AND type IN ('revision_requested', 'fix_cycle_started', 'skill_validation_failed', 'claims_downgraded', 'triage_decided', 'cache_hit', 'duplicate_prevented') OR (project_id = $1 AND type LIKE 'retry_scheduled%')`, [projectId]);
  const issueRules = new Map<string, number>();
  for (const t of tasks) {
    for (const i of t.outputs?.review?.issues ?? []) issueRules.set(i.area, (issueRules.get(i.area) ?? 0) + 1);
  }
  const firstTimeRight = tasks.filter((t) => t.status === 'COMPLETED' && t.revision === 0 && t.attempt <= 1).map((t) => t.plan_key);
  return {
    tasks: tasks.length,
    first_time_right: firstTimeRight.length,
    revised: tasks.filter((t) => t.revision > 0).map((t) => ({ task: t.plan_key, agent: getAgent(t.agent_type).name, revisions: t.revision })),
    retried: tasks.filter((t) => t.attempt > 1).map((t) => ({ task: t.plan_key, attempts: t.attempt })),
    failed: tasks.filter((t) => ['FAILED', 'BLOCKED', 'CANCELLED'].includes(t.status)).map((t) => ({ task: t.plan_key, status: t.status, error: t.error?.class ?? null })),
    recurring_issue_areas: [...issueRules.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10).map(([area, n]) => ({ area, occurrences: n })),
    events: events.reduce((m: Record<string, number>, e) => ((m[e.type.split(':')[0]] = (m[e.type.split(':')[0]] ?? 0) + 1), m), {}),
  };
}

const RetroSchema = z.object({
  what_worked: z.array(z.string()).default([]),
  what_failed: z.array(z.string()).default([]),
  recurring_issues: z.array(z.string()).default([]),
  successful_patterns: z.array(z.string()).default([]),
  common_revisions: z.array(z.string()).default([]),
  performance_lessons: z.array(z.string()).default([]),
  qa_findings: z.array(z.string()).default([]),
  candidate_knowledge: z.array(KnowledgeSchema).max(8).default([]),
});

export async function runRetrospective(opts: { db: Db; provider: NvidiaProvider; kb: KnowledgeBase; projectId: string; scorecard: unknown; specifics: string[] }): Promise<Record<string, unknown>> {
  const facts = await retrospectiveFacts(opts.db, opts.projectId);
  let narrative: z.infer<typeof RetroSchema> | null = null;
  try {
    const res = await opts.provider.requestModel({
      capability: 'summarization',
      maxTokens: 2000,
      temperature: 0.2,
      metadata: { purpose: 'main_agent:retrospective', projectId: opts.projectId, priority: 20 },
      messages: [
        {
          role: 'system',
          content: 'You are the ApexWeb Main Agent writing a project retrospective from recorded facts only. Reply with JSON: {"what_worked":[],"what_failed":[],"recurring_issues":[],"successful_patterns":[],"common_revisions":[],"performance_lessons":[],"qa_findings":[],"candidate_knowledge":[{"category": one of design_principles|coding_patterns|successful_patterns|common_bugs|client_requirements|seo_rules|accessibility_rules|apexweb_preferences|performance|qa_findings|process, "title": string, "content": string, "tags": [agent types or skill names]}]}. Candidate knowledge must be GENERAL and reusable: no client names, locations, URLs, contact details or placeholders.',
        },
        { role: 'user', content: JSON.stringify({ facts, scorecard: opts.scorecard }).slice(0, 40_000) },
      ],
    });
    narrative = RetroSchema.parse(JSON.parse(extractJsonObject(res.content) ?? '{}'));
  } catch (err) {
    log.warn('retrospective narrative failed; storing recorded facts only', { project: opts.projectId, error: errorMessage(err) });
  }
  const accepted: string[] = [];
  const refused: Array<{ title: string; reason: string }> = [];
  for (const cand of narrative?.candidate_knowledge ?? []) {
    const leak = containsProjectSpecifics(`${cand.title} ${cand.content}`, opts.specifics);
    if (leak) {
      refused.push({ title: cand.title, reason: `contains project-specific detail (${leak})` });
      continue;
    }
    const entry = await opts.kb.add(cand, 'candidate', 'retrospective', opts.projectId);
    accepted.push(entry.id);
  }
  const report = { facts, ...(narrative ?? { note: 'Narrative unavailable; facts recorded from task history.' }), candidate_knowledge_ids: accepted, refused_candidates: refused };
  await opts.db.query(`INSERT INTO retrospectives (project_id, report) VALUES ($1, $2) ON CONFLICT (project_id) DO UPDATE SET report = EXCLUDED.report, created_at = now()`, [opts.projectId, JSON.stringify(report)]);
  return report;
}
