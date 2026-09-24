// End-to-end orchestration through the real stack (internal driver): Main
// Agent intake -> plan -> queue -> parallel specialists -> key pool -> review
// gate rejection -> revision -> audits (real Chromium) -> QA fix cycle ->
// assembly -> completion report.
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import type { Db } from '../../src/db/pool.ts';
import type { Services } from '../../src/services.ts';
import { freshDb } from '../support/db.ts';
import { startStack, waitFor } from '../support/harness.ts';
import type { NimTestServer } from '../support/nimTestServer.ts';
import { createScript } from '../support/scriptedAgents.ts';

process.env.LOG_SILENT = '1';

describe('HVAC demo end-to-end (internal driver)', () => {
  let db: Db;
  let s: Services;
  let nim: NimTestServer;
  let projectId: string;

  before(async () => {
    db = await freshDb();
    ({ s, nim } = await startStack(db, createScript({ rejectFirstBuild: true, rejectFirstQa: true })));
    (s.driver as any).start(200);
  });
  after(async () => {
    await (s.driver as any).stop({ abort: true, timeoutMs: 5_000 });
    s.keyPool.stop();
    await nim.stop();
    await db.end();
  });

  it('runs the full workflow to a completed, QA-passed package', async () => {
    const r = await s.mainAgent.receive({ message: 'Create a premium ApexWeb demo website for a local HVAC company.', actor: 'user' });
    assert.equal(r.type, 'project_created');
    projectId = (r as any).project.id;
    const project = await waitFor(async () => {
      const p = await s.projects.get(projectId);
      return ['COMPLETED', 'NEEDS_ATTENTION', 'FAILED'].includes(p.status) ? p : null;
    }, 240_000, 'project completion', 500);
    if (project.status !== 'COMPLETED') {
      const { rows } = await db.query(`SELECT plan_key, status, error FROM tasks WHERE project_id = $1 AND status <> 'COMPLETED'`, [projectId]);
      assert.fail(`project ended ${project.status}: ${JSON.stringify(rows)}`);
    }
    const report = project.final_report as any;
    assert.equal(report.qa.passed, true, 'final QA passed');
    assert.equal(report.qa.fix_cycles, 1, 'one QA fix cycle ran');
    assert.ok(report.agents_used.length >= 15, `many specialists contributed (${report.agents_used.length})`);
    assert.ok(report.outputs.site_files.includes('index.html'));
    assert.ok(existsSync(path.join(report.files.package_dir, 'site', 'index.html')), 'package materialised');
    assert.ok(report.files.archive && existsSync(report.files.archive), 'tar.gz archive built');
    assert.ok(readFileSync(path.join(report.files.package_dir, 'REPORT.md'), 'utf8').includes('## Agents Used'));
    assert.ok(report.issues.placeholders.length > 0, 'placeholders are reported, not invented');
  });

  it('the Design Critic rejected the overflowing first build on rendered evidence and the revision was re-reviewed', async () => {
    const { rows } = await db.query(`SELECT * FROM tasks WHERE project_id = $1 AND plan_key IN ('build', 'design_review')`, [projectId]);
    const build = rows.find((r) => r.plan_key === 'build');
    const review = rows.find((r) => r.plan_key === 'design_review');
    assert.equal(build.revision, 1, 'build was revised once');
    assert.equal(build.inputs.revision_feedback[0].from, 'design_critic');
    assert.ok(JSON.stringify(build.inputs.revision_feedback).includes('horizontal_overflow'));
    const ev = await s.queue.events(review.id);
    assert.ok(ev.some((e) => e.type === 'awaiting_revision'));
    assert.equal(review.outputs.review.verdict, 'approve');
    const lessons = await s.memory.get<string[]>('agent', 'frontend_developer', 'lessons');
    assert.ok(lessons && lessons.length > 0, 'agent memory recorded the rejection lesson');
  });

  it('never started a task before its dependencies completed', async () => {
    const { rows } = await db.query(`SELECT id, plan_key, dependencies, started_at, completed_at FROM tasks WHERE project_id = $1 AND kind <> 'root'`, [projectId]);
    const byId = new Map(rows.map((r) => [r.id, r]));
    // First start event per task vs. last completion of each dependency before that start.
    const { rows: events } = await db.query(`SELECT task_id, type, at FROM task_events WHERE project_id = $1 ORDER BY id`, [projectId]);
    for (const t of rows) {
      const starts = events.filter((e) => e.task_id === t.id && e.type === 'started');
      for (const st of starts) {
        for (const dep of t.dependencies) {
          const completedBefore = events.some((e) => e.task_id === dep && (e.type === 'completed' || e.type === 'human_override') && e.at <= st.at);
          assert.ok(completedBefore, `${t.plan_key} started before dependency ${byId.get(dep)?.plan_key} completed`);
        }
      }
    }
  });

  it('ran independent research tasks in parallel', async () => {
    const { rows } = await db.query(
      `SELECT plan_key, started_at, completed_at FROM tasks WHERE project_id = $1 AND plan_key IN ('requirements', 'research', 'competitive', 'assets', 'local_seo')`,
      [projectId],
    );
    assert.equal(rows.length, 5);
    // All five became ready at the same moment (after intake) and at least two overlapped in time.
    let overlaps = 0;
    for (const a of rows) for (const b of rows) if (a !== b && a.started_at < b.completed_at && b.started_at < a.completed_at) overlaps++;
    assert.ok(overlaps > 0, 'parallel branches overlapped');
  });

  it('routed every NVIDIA call through the key pool, spread across keys, under the ceiling', async () => {
    const { rows } = await db.query(`SELECT key_id, status, count(*)::int AS n FROM key_requests GROUP BY key_id, status`);
    const ok = rows.filter((r) => r.status === 'ok').reduce((n, r) => n + r.n, 0);
    assert.equal(ok, nim.calls.length, 'one ledger entry per provider call');
    const byKey = nim.callsByKey();
    assert.equal(Object.keys(byKey).length, 4, 'all four keys used');
    const { rows: peak } = await db.query(
      `SELECT a.key_id, max((SELECT count(*) FROM key_requests b WHERE b.key_id = a.key_id AND b.granted_at > a.granted_at - interval '60 seconds' AND b.granted_at <= a.granted_at))::int AS peak
       FROM key_requests a GROUP BY a.key_id`,
    );
    for (const p of peak) assert.ok(p.peak <= 55, `${p.key_id} peaked at ${p.peak}`);
  });
});
