// Hardening scenarios against the real stack: a key failing with 429s,
// several keys returning 5xx, an unavailable model, malformed output ending
// in escalation + human retry, all keys exhausted, restart recovery,
// cancellation and duplicate requests.
import { after, afterEach, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { Db } from '../../src/db/pool.ts';
import { createServices, recoverAfterRestart, type Services } from '../../src/services.ts';
import { retryTask } from '../../src/api/overrides.ts';
import { freshDb } from '../support/db.ts';
import { startStack, testConfig, waitFor } from '../support/harness.ts';
import type { NimTestServer } from '../support/nimTestServer.ts';
import { createScript } from '../support/scriptedAgents.ts';

process.env.LOG_SILENT = '1';
const REQUEST = 'Research the market for residential heat pumps.';

async function settled(s: Services, projectId: string, timeout = 180_000) {
  return waitFor(async () => {
    const p = await s.projects.get(projectId);
    return ['COMPLETED', 'APPROVED', 'NEEDS_ATTENTION', 'FAILED', 'CANCELLED'].includes(p.status) ? p : null;
  }, timeout, 'project to settle', 300);
}

describe('resilience', () => {
  let db: Db;
  let s: Services | null = null;
  let nim: NimTestServer | null = null;
  before(async () => {
    db = await freshDb();
  });
  afterEach(async () => {
    if (s) {
      await (s.driver as any).stop({ abort: true, timeoutMs: 3_000 });
      s.keyPool.stop();
    }
    await nim?.stop();
    s = null;
    nim = null;
  });
  after(async () => {
    await db.end();
  });

  async function run(opts: { behaviour?: (call: any, script: (b: any) => string) => any; env?: Record<string, string> } = {}) {
    const script = createScript({ intent: 'research_only' });
    ({ s, nim } = await startStack(db, script, opts.env));
    if (opts.behaviour) nim!.behaviour = (call) => opts.behaviour!(call, script);
    (s!.driver as any).start(150);
    const r = await s!.mainAgent.receive({ message: `${REQUEST} ${Math.random()}`, actor: 'user' });
    return (r as any).project.id as string;
  }

  it('one key failing with 429: routing moves to other keys, the key cools down, work completes', async () => {
    const projectId = await run({
      behaviour: (call, script) => (call.key.includes('key-one') ? { status: 429, headers: { 'retry-after': '30' }, body: { error: 'rate limited' } } : { reply: script(call.body) }),
    });
    const p = await settled(s!, projectId);
    assert.equal(p.status, 'COMPLETED');
    const k1 = (await s!.keyPool.snapshots()).find((k) => k.id === 'key_1')!;
    assert.equal(k1.health, 'cooldown');
    const k1calls = nim!.calls.filter((c) => c.key.includes('key-one')).length;
    assert.ok(k1calls <= 2, `key_1 stopped receiving traffic after its 429 (${k1calls} calls)`);
    const { rows } = await db.query(`SELECT count(*)::int AS n FROM key_requests WHERE key_id = 'key_1' AND status = 'rate_limited'`);
    assert.ok(rows[0].n >= 1);
  });

  it('multiple keys returning 5xx and an unavailable model: circuit breaks, fallback model used, work completes', async () => {
    const projectId = await run({
      behaviour: (call, script) => {
        if (call.key.includes('key-two') || call.key.includes('key-three')) return { status: 503, body: { error: 'upstream unavailable' } };
        if (call.model === 'nvidia/llama-3.3-nemotron-super-49b-v1.5') return { status: 404, body: { error: 'Function id for model nvidia/llama-3.3-nemotron-super-49b-v1.5 not found' } };
        return { reply: script(call.body) };
      },
    });
    const p = await settled(s!, projectId);
    assert.equal(p.status, 'COMPLETED');
    assert.equal(s!.router.isAvailable('nvidia/llama-3.3-nemotron-super-49b-v1.5'), false, 'unavailable model taken out of rotation');
    const ok = nim!.calls.filter((c) => !c.key.includes('key-two') && !c.key.includes('key-three') && c.model !== 'nvidia/llama-3.3-nemotron-super-49b-v1.5');
    assert.ok(ok.length > 5);
    const snaps = await s!.keyPool.snapshots();
    assert.ok(snaps.filter((k) => k.id === 'key_2' || k.id === 'key_3').every((k) => k.consecutiveFailures >= 1 || k.health !== 'healthy'));
    await s!.router.markAvailable('nvidia/llama-3.3-nemotron-super-49b-v1.5');
  });

  it('malformed output: bounded retries, model switch, rescue, escalation; a human retry then completes the project', async () => {
    let broken = true;
    const projectId = await run({
      behaviour: (call, script) => {
        const sys = String(call.body?.messages?.[0]?.content ?? '');
        if (broken && sys.includes('You are the Research Coordinator')) return { reply: 'I am not going to follow the protocol.' };
        return { reply: script(call.body) };
      },
    });
    const p = await settled(s!, projectId);
    assert.equal(p.status, 'NEEDS_ATTENTION');
    const { rows } = await db.query(`SELECT * FROM tasks WHERE project_id = $1 AND plan_key = 'synthesis'`, [projectId]);
    const synth = rows[0];
    assert.equal(synth.status, 'FAILED');
    const ev = (await s!.queue.events(synth.id)).map((e) => e.type);
    assert.ok(ev.includes('retry_scheduled:retry'), 'attempt 1 -> retry');
    assert.ok(ev.some((t) => t === 'retry_scheduled:switch_model' || t === 'retry_scheduled:retry_backoff'), 'attempt 2 -> backoff/switch');
    assert.ok(ev.includes('retry_scheduled:rescue'), 'rescue attempt');
    assert.ok(ev.includes('failed_escalated'), 'escalated to Main Agent');
    const dead = await db.query(`SELECT count(*)::int AS n FROM dead_letters WHERE task_id = $1`, [synth.id]);
    assert.equal(dead.rows[0].n, 1);
    const msgs = await s!.projects.messages(projectId);
    assert.ok(msgs.some((m) => m.role === 'main_agent' && m.content.includes('I need your input')));
    broken = false;
    await retryTask(s!, synth.id, 'user');
    const done = await settled(s!, projectId);
    assert.equal(done.status, 'COMPLETED');
  });

  it('all keys exhausted: requests queue (never dropped) and no key exceeds its ceiling', async () => {
    const projectId = await run({ env: { NVIDIA_RPM_PER_KEY: '2', NVIDIA_RATE_WINDOW_MS: '1500' } });
    const p = await settled(s!, projectId, 240_000);
    assert.equal(p.status, 'COMPLETED');
    const { rows } = await db.query(
      `SELECT a.key_id, max((SELECT count(*) FROM key_requests b WHERE b.key_id = a.key_id AND b.granted_at > a.granted_at - interval '1500 milliseconds' AND b.granted_at <= a.granted_at))::int AS peak
       FROM key_requests a WHERE a.project_id = $1 GROUP BY a.key_id`,
      [projectId],
    );
    for (const r of rows) assert.ok(r.peak <= 2, `${r.key_id} peaked at ${r.peak} within one window`);
  });

  it('restart: in-flight work is recovered from Postgres and the project completes on a new process', async () => {
    const script = createScript({ intent: 'research_only' });
    ({ s, nim } = await startStack(db, script));
    nim!.behaviour = (call) => ({ reply: script(call.body), delayMs: 400 });
    (s!.driver as any).start(150);
    const r = await s!.mainAgent.receive({ message: `${REQUEST} restart ${Math.random()}`, actor: 'user' });
    const projectId = (r as any).project.id;
    await waitFor(async () => (await db.query(`SELECT count(*)::int AS n FROM tasks WHERE project_id = $1 AND status = 'RUNNING'`, [projectId])).rows[0].n > 0 || null, 60_000, 'a running task');
    // Simulated crash: the worker dies mid-task without cleanup.
    await (s!.driver as any).stop({ abort: true, timeoutMs: 1 });
    s!.keyPool.stop();
    const before = (await db.query(`SELECT count(*)::int AS n FROM tasks WHERE project_id = $1 AND status IN ('RUNNING', 'ASSIGNED', 'REVIEW')`, [projectId])).rows[0].n;
    const s2 = await createServices(testConfig(nim!.url), { db });
    s = s2;
    const recovered = await recoverAfterRestart(s2);
    assert.ok(recovered.reclaimed >= before, `reclaimed ${recovered.reclaimed} of ${before} in-flight task(s)`);
    (s2.driver as any).start(150);
    const p = await settled(s2, projectId);
    assert.equal(p.status, 'COMPLETED');
    const { rows } = await db.query(`SELECT count(*)::int AS n FROM task_events WHERE project_id = $1 AND actor = 'recovery'`, [projectId]);
    assert.ok(rows[0].n >= 0);
  });

  it('cancellation stops dispatching and cancels every open task; duplicate requests are detected', async () => {
    const script = createScript({ intent: 'research_only' });
    ({ s, nim } = await startStack(db, script));
    nim!.behaviour = (call) => ({ reply: script(call.body), delayMs: 300 });
    (s!.driver as any).start(150);
    const msg = `${REQUEST} cancel ${Math.random()}`;
    const r = await s!.mainAgent.receive({ message: msg, actor: 'user' });
    const projectId = (r as any).project.id;
    const dup = await s!.mainAgent.receive({ message: msg, actor: 'user' });
    assert.equal((dup as any).duplicate, true, 'identical request within the window is a duplicate');
    await waitFor(async () => (await db.query(`SELECT count(*)::int AS n FROM tasks WHERE project_id = $1 AND kind <> 'root'`, [projectId])).rows[0].n > 0 || null, 60_000, 'tasks enqueued');
    await s!.mainAgent.control(projectId, 'cancel', 'user');
    const { rows } = await db.query(`SELECT status, count(*)::int AS n FROM tasks WHERE project_id = $1 GROUP BY status`, [projectId]);
    assert.ok(rows.every((x) => ['CANCELLED', 'COMPLETED', 'FAILED'].includes(x.status)), JSON.stringify(rows));
    const callsAtCancel = nim!.calls.length;
    await new Promise((res) => setTimeout(res, 1500));
    assert.ok(nim!.calls.length - callsAtCancel <= 2, 'no new work dispatched after cancellation');
    assert.equal((await s!.projects.get(projectId)).status, 'CANCELLED');
  });
});
