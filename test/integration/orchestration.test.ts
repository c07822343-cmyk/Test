// End-to-end agency workflow through the real stack (internal driver):
// Main Agent intake -> blueprint -> skill chain -> plan -> parallel specialists
// -> key pool -> design-critic rejection (rendered evidence) -> revision ->
// second set of eyes -> Main Agent triage -> fix + change review -> Visual QA
// refinement loop (measured progress) -> final QA fix cycle -> assembly with
// scorecard, retrospective, snapshots and completion report.
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import type { Db } from '../../src/db/pool.ts';
import type { Services } from '../../src/services.ts';
import { activityFeed } from '../../src/api/activity.ts';
import { usageReport } from '../../src/api/usage.ts';
import { freshDb } from '../support/db.ts';
import { startStack, waitFor } from '../support/harness.ts';
import type { NimTestServer } from '../support/nimTestServer.ts';
import { createScript } from '../support/scriptedAgents.ts';

process.env.LOG_SILENT = '1';

describe('HVAC website end-to-end (internal driver)', () => {
  let db: Db;
  let s: Services;
  let nim: NimTestServer;
  let projectId: string;
  let byKey: Map<string, any>;

  before(async () => {
    db = await freshDb();
    ({ s, nim } = await startStack(db, createScript({ rejectFirstBuild: true, rejectFirstQa: true, visualDefectAfterTriage: true })));
    (s.driver as any).start(200);
  });
  after(async () => {
    await (s.driver as any).stop({ abort: true, timeoutMs: 5_000 });
    s.keyPool.stop();
    await nim.stop();
    await db.end();
  });

  it('runs "Create a premium website for a local HVAC company." to a completed, QA-passed package', async () => {
    const r = await s.mainAgent.receive({ message: 'Create a premium website for a local HVAC company.', actor: 'user' });
    assert.equal(r.type, 'project_created');
    projectId = (r as any).project.id;
    const project = await waitFor(async () => {
      const p = await s.projects.get(projectId);
      return ['COMPLETED', 'APPROVED', 'NEEDS_ATTENTION', 'FAILED'].includes(p.status) ? p : null;
    }, 280_000, 'project completion', 500);
    const { rows } = await db.query(`SELECT * FROM tasks WHERE project_id = $1`, [projectId]);
    byKey = new Map(rows.map((t) => [t.plan_key, t]));
    if (project.status !== 'COMPLETED') {
      assert.fail(`project ended ${project.status}: ${JSON.stringify(rows.filter((t) => t.status !== 'COMPLETED').map((t) => [t.plan_key, t.status, t.error]))}`);
    }
    const report = project.final_report as any;
    assert.equal(report.qa.passed, true, 'final QA passed');
    assert.equal(report.qa.fix_cycles, 1, 'one final-QA fix cycle ran');
    assert.ok(report.agents_used.length >= 18, `many specialists contributed (${report.agents_used.length})`);
    assert.ok(report.skills_used.includes('premium-design@1.1'), 'latest premium-design version was used');
    assert.ok(report.scorecard.totals.passed > 10, `scorecard evaluated (${JSON.stringify(report.scorecard.totals)})`);
    assert.ok(existsSync(path.join(report.files.package_dir, 'site', 'index.html')), 'package materialised');
    assert.ok(existsSync(path.join(report.files.package_dir, 'reports', 'scorecard.json')));
    assert.ok(report.files.archive && existsSync(report.files.archive), 'tar.gz archive built');
    assert.ok(readFileSync(path.join(report.files.package_dir, 'REPORT.md'), 'utf8').includes('## Agents Used'));
    assert.ok(report.issues.placeholders.length > 0, 'placeholders are reported, not invented');
    assert.equal(project.stage, 'READY_FOR_HANDOFF');
  });

  it('wrote a blueprint and refused a contact detail the user never gave', async () => {
    const p = await s.projects.get(projectId);
    const bp = p.blueprint as any;
    assert.equal(bp.business.contact.phone, null, 'invented phone removed');
    assert.ok(bp.open_questions.some((q: string) => q.includes('phone')));
    assert.equal(bp.requirements.length, 4);
    const card = p.scorecard as any;
    const req = card.criteria.filter((c: any) => c.category === 'project_requirements');
    assert.deepEqual(req.map((c: any) => c.passed), [true, true, true, true], 'blueprint requirements verified');
  });

  it('selected a skill chain and loaded skills into compatible agents only', async () => {
    const p = await s.projects.get(projectId);
    const chain = (p.skill_chain as any[]).map((c) => c.skill);
    assert.ok(chain.includes('local-business-website@1.0') && chain.includes('security-screening@1.0'));
    assert.ok(byKey.get('build').skills.includes('premium-design@1.1'));
    assert.ok(!byKey.get('research').skills.includes('premium-design@1.1'), 'research agent did not get a design skill');
    assert.ok(byKey.get('research').skills.includes('local-business-research@1.0'));
    const { rows } = await db.query(`SELECT count(*)::int AS n FROM research_claims WHERE project_id = $1`, [projectId]);
    assert.ok(rows[0].n > 0, 'research claims recorded with classifications');
  });

  it('the Design Critic rejected the overflowing first build on rendered evidence and the revision was re-reviewed', async () => {
    const build = byKey.get('build');
    const review = byKey.get('design_review');
    assert.equal(build.revision, 1, 'build was revised once');
    assert.ok(JSON.stringify(build.inputs.revision_feedback).includes('horizontal_overflow'));
    const ev = await s.queue.events(review.id);
    assert.ok(ev.some((e) => e.type === 'awaiting_revision'));
    const lessons = await s.memory.get<string[]>('agent', 'frontend_developer', 'lessons');
    assert.ok(lessons && lessons.length > 0, 'agent memory recorded the rejection lesson');
  });

  it('second set of eyes: Main Agent triage created a fix guarded by a change review', async () => {
    const triage = byKey.get('triage');
    assert.equal(triage.outputs.triage.accepted >= 1, true);
    const fix = byKey.get('triage_fixes');
    const cr = byKey.get('triage_change_review');
    assert.ok(fix && cr, 'fix + change review created');
    assert.equal(cr.review_target, fix.id);
    assert.ok(byKey.get('visual_qa').dependencies.includes(cr.id), 'visual QA waited for the change review');
  });

  it('Visual QA loop: rendered defect -> fix -> re-render with measurably better score -> approve', async () => {
    const vqa = byKey.get('visual_qa');
    assert.equal(vqa.inputs.cycle_scores.length, 1, 'one refinement cycle');
    const history = await s.memory.get<any[]>('project', projectId, 'visual_qa:history:visual_qa');
    assert.equal(history!.length, 2, 'two rendered passes');
    assert.ok(history![1].score < history![0].score, `score improved ${history![0].score} -> ${history![1].score}`);
    assert.ok(history![1].comparison.resolved.length > 0, 'resolved issues identified by comparison');
    assert.ok(byKey.get('visual_fix_1'), 'visual fix task created');
    assert.equal(vqa.outputs.review.verdict, 'approve');
  });

  it('never started a task before its dependencies (as of that start) completed', async () => {
    const { rows: events } = await db.query(`SELECT task_id, type, at FROM task_events WHERE project_id = $1 ORDER BY id`, [projectId]);
    for (const t of byKey.values()) {
      if (t.kind === 'root') continue;
      for (const st of events.filter((e) => e.task_id === t.id && e.type === 'started')) {
        for (const dep of t.dependencies) {
          const created = events.find((e) => e.task_id === dep && e.type === 'created');
          if (created && created.at > st.at) continue;
          const done = events.some((e) => e.task_id === dep && ['completed', 'human_override', 'approved'].includes(e.type) && e.at <= st.at);
          assert.ok(done, `${t.plan_key} started before dependency completed`);
        }
      }
    }
  });

  it('ran independent research tasks in parallel and tracked the lifecycle stages', async () => {
    const rows = ['requirements', 'research', 'competitive', 'assets', 'local_seo'].map((k) => byKey.get(k));
    let overlaps = 0;
    for (const a of rows) for (const b of rows) if (a !== b && a.started_at < b.completed_at && b.started_at < a.completed_at) overlaps++;
    assert.ok(overlaps > 0, 'parallel branches overlapped');
    const stages = (await s.lifecycle.history(projectId)).map((h) => h.to_stage);
    for (const st of ['RESEARCH', 'DESIGN', 'DEVELOPMENT', 'TESTING', 'QA', 'REVISION', 'READY_FOR_HANDOFF']) assert.ok(stages.includes(st), `stage ${st} recorded`);
  });

  it('routed every NVIDIA call through the key pool under the 55 RPM ceiling, with usage attributed', async () => {
    const { rows } = await db.query(`SELECT count(*) FILTER (WHERE status = 'ok')::int AS ok FROM key_requests`);
    assert.equal(rows[0].ok, nim.calls.length, 'one ledger entry per provider call');
    assert.equal(Object.keys(nim.callsByKey()).length, 4, 'all four keys used');
    const { rows: peak } = await db.query(
      `SELECT a.key_id, max((SELECT count(*) FROM key_requests b WHERE b.key_id = a.key_id AND b.granted_at > a.granted_at - interval '60 seconds' AND b.granted_at <= a.granted_at))::int AS peak FROM key_requests a GROUP BY a.key_id`,
    );
    for (const p of peak) assert.ok(p.peak <= 55, `${p.key_id} peaked at ${p.peak}`);
    const usage = await usageReport(db, projectId);
    const { rows: unattributed } = await db.query(`SELECT purpose FROM key_requests WHERE project_id IS NULL`);
    assert.deepEqual(unattributed.map((u) => u.purpose), ['main_agent:route'], 'only the pre-project routing call is unattributed');
    assert.equal(usage.nvidia.requests, nim.calls.length - 1, 'every other call attributed to the project');
    assert.ok(usage.by_agent.length > 10);
  });

  it('kept version-control snapshots, a retrospective and only generalisable knowledge candidates', async () => {
    const snaps = await s.repos.list(projectId);
    assert.ok(snaps.length >= 4, `snapshots recorded (${snaps.length})`);
    if (await s.repos.gitAvailable()) assert.ok(snaps.every((x) => x.commit_sha), 'each snapshot is a git commit');
    const retro = (await db.query('SELECT report FROM retrospectives WHERE project_id = $1', [projectId])).rows[0]?.report;
    assert.ok(retro, 'retrospective stored');
    assert.equal(retro.candidate_knowledge_ids.length, 1, 'generic lesson became a candidate');
    assert.equal(retro.refused_candidates.length, 1, 'client-specific lesson refused');
    const cands = await s.knowledge.list('candidate');
    assert.equal(cands.length, 1);
    assert.equal(cands[0].status, 'candidate', 'not auto-promoted');
  });

  it('produced a live activity feed from real events', async () => {
    const { items } = await activityFeed(db, { projectId, limit: 500 });
    const text = items.map((i) => `${i.agent}: ${i.headline}`).join('\n');
    assert.match(text, /Main Agent: Project blueprint created/);
    assert.match(text, /Design Critic.*Sent "Build the website" back/s);
    assert.match(text, /Visual QA Specialist: Found 1 issue/);
    assert.match(text, /Main Agent: Triage: accepted/);
    assert.match(text, /Project stage: .* → READY_FOR_HANDOFF/);
  });
});
