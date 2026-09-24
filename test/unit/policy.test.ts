import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { decideFailure } from '../../src/orchestrator/failureManager.ts';
import { validatePlan, applyGates, topoOrder, PlanValidationError } from '../../src/orchestrator/planner.ts';
import { loadTemplates, templates, templateFor, type PlanTask } from '../../src/orchestrator/templates.ts';
import { computeStage, taskStage } from '../../src/orchestrator/lifecycle.ts';
import { HealthWeightedHeadroomStrategy, WeightedLeastLoadedStrategy, type KeySnapshot } from '../../src/provider/scheduling.ts';
import { activeGates } from '../../src/orchestrator/approvals.ts';

const rand = () => 0.5;
const base = { maxAttempts: 3, capacityWaits: 0, optional: false, currentModel: 'm1', alternativeModels: ['m1', 'm2'], rescued: false, rand };

describe('Failure Manager policy', () => {
  it('attempt 1 -> retry, attempt 2 -> backoff on a fallback model, attempt 3 -> rescue once, then escalate', () => {
    assert.equal(decideFailure({ ...base, errorClass: 'server_error', attempt: 1 }).action, 'retry');
    const second = decideFailure({ ...base, errorClass: 'timeout', attempt: 2 });
    assert.equal(second.action, 'switch_model');
    assert.equal(second.nextModel, 'm2');
    assert.ok(second.delayMs >= 5_000);
    assert.equal(decideFailure({ ...base, errorClass: 'timeout', attempt: 2, alternativeModels: ['m1'] }).action, 'retry_backoff');
    const third = decideFailure({ ...base, errorClass: 'malformed_output', attempt: 3 });
    assert.equal(third.action, 'rescue');
    assert.equal(third.resetAttempts, true);
    assert.equal(decideFailure({ ...base, errorClass: 'malformed_output', attempt: 3, rescued: true }).action, 'escalate');
  });
  it('key-level failures re-lease on another key without burning attempts, but are bounded', () => {
    const d = decideFailure({ ...base, errorClass: 'rate_limited', attempt: 1, retryAfterMs: 7000 });
    assert.equal(d.action, 'retry_other_key');
    assert.equal(d.refundAttempt, true);
    assert.ok(d.delayMs >= 7000, 'honours Retry-After');
    assert.equal(decideFailure({ ...base, errorClass: 'rate_limited', attempt: 1, capacityWaits: 12 }).action, 'escalate');
  });
  it('never loops on an unavailable model when no model had been selected', () => {
    assert.equal(decideFailure({ ...base, errorClass: 'model_unavailable', attempt: 1, currentModel: null }).action, 'escalate');
    assert.equal(decideFailure({ ...base, errorClass: 'model_unavailable', attempt: 1 }).action, 'switch_model');
  });
  it('optional tasks fail softly; no keys escalates immediately', () => {
    assert.equal(decideFailure({ ...base, errorClass: 'server_error', attempt: 3, optional: true }).action, 'fail_optional');
    assert.equal(decideFailure({ ...base, errorClass: 'no_keys', attempt: 1 }).action, 'escalate');
  });
});

describe('Planner and workflow templates', () => {
  it('loads every template and each validates as a DAG over registered agents', () => {
    const r = loadTemplates();
    assert.equal(r.errors.length, 0, r.errors.join('; '));
    assert.ok(r.loaded >= 17);
    for (const t of templates()) {
      const v = validatePlan(t.tasks.map((x) => ({ ...x, depends_on: [...x.depends_on] })), t);
      assert.ok(topoOrder(v.tasks), `${t.intent} is acyclic`);
    }
  });
  it('restores required stages the model dropped and rejects unknown agents and cycles', () => {
    const tpl = templateFor('seo_audit');
    const v = validatePlan(tpl.tasks.filter((t) => t.key !== 'report'), tpl);
    assert.ok(v.tasks.some((t) => t.key === 'report'));
    assert.ok(v.warnings.some((w) => w.includes('report')));
    assert.throws(() => validatePlan([...tpl.tasks, { key: 'x', agent_type: 'nope', title: 'xxx', mission: 'xxxxxxxxxxxx', depends_on: [], priority: 1 }], tpl), PlanValidationError);
    const cyclic: PlanTask[] = tpl.tasks.map((t) => (t.key === 'intake' ? { ...t, depends_on: ['report'] } : t));
    assert.throws(() => validatePlan(cyclic, tpl), /cycle/);
  });
  it('rewires consumers of gated work to the review gate', () => {
    const tpl = templateFor('local_business_website');
    const v = validatePlan(tpl.tasks.map((t) => ({ ...t, depends_on: [...t.depends_on] })), tpl);
    const build = v.tasks.find((t) => t.key === 'build')!;
    assert.ok(build.depends_on.includes('copy_review') && !build.depends_on.includes('copy'));
    const ux = v.tasks.find((t) => t.key === 'ux_review')!;
    assert.ok(ux.depends_on.includes('design_review'));
  });
  it('drops approval checkpoints whose gate is inactive and rewires dependents', () => {
    const tpl = templateFor('website_redesign');
    const kept = applyGates(tpl.tasks, ['major_redesign']);
    assert.ok(kept.some((t) => t.key === 'redesign_approval'));
    const dropped = applyGates(tpl.tasks, []);
    assert.ok(!dropped.some((t) => t.key === 'redesign_approval'));
    const build = dropped.find((t) => t.key === 'build')!;
    assert.ok(build.depends_on.includes('ux') && build.depends_on.includes('copy_review'));
  });
  it('mode gates: assist asks for plan approval, autopilot only for irreversible operations', () => {
    assert.ok(activeGates({ mode: 'assist', approval_gates: null, dry_run: false }).includes('plan_approval'));
    assert.deepEqual(activeGates({ mode: 'autopilot', approval_gates: null, dry_run: false }), ['repo_irreversible', 'external_publish']);
    assert.ok(activeGates({ mode: 'autopilot', approval_gates: null, dry_run: true }).includes('plan_approval'));
    assert.deepEqual(activeGates({ mode: 'semi', approval_gates: ['final_handoff'], dry_run: false }), ['final_handoff']);
  });
});

describe('Lifecycle stage machine', () => {
  const t = (over: any) => ({ stage: null, agent_type: 'content_research', kind: 'work', revision: 0, status: 'COMPLETED', ...over });
  it('tracks the frontier of active work and treats revisions/fixes as REVISION', () => {
    const tasks: any[] = [t({ agent_type: 'client_intake' }), t({ agent_type: 'frontend_developer', status: 'RUNNING' }), t({ agent_type: 'website_copywriter', status: 'RUNNING' })];
    // Frontier = the latest lifecycle stage with active work (CONTENT follows DEVELOPMENT in the ApexWeb lifecycle).
    assert.equal(computeStage({ status: 'RUNNING', plan: {} } as any, tasks), 'CONTENT');
    assert.equal(computeStage({ status: 'RUNNING', plan: {} } as any, tasks.slice(0, 2)), 'DEVELOPMENT');
    assert.equal(taskStage(t({ agent_type: 'frontend_developer', revision: 1 }) as any), 'REVISION');
    assert.equal(taskStage(t({ kind: 'triage', agent_type: 'main_orchestrator' }) as any), 'FINAL_REVIEW');
    assert.equal(computeStage({ status: 'COMPLETED', plan: {} } as any, []), 'READY_FOR_HANDOFF');
    assert.equal(computeStage({ status: 'APPROVED', plan: {} } as any, []), 'COMPLETED');
    assert.equal(computeStage({ status: 'PLANNING', plan: null } as any, []), 'INTAKE');
  });
});

describe('Key scheduling strategies', () => {
  const snap = (id: string, windowCount: number, extra: Partial<KeySnapshot> = {}): KeySnapshot => ({
    id, slot: Number(id.slice(-1)), masked: '', active: true, disabledReason: null, cooldownUntil: null, cooldownRemainingMs: 0, ceiling: 55, windowCount,
    remaining: 55 - windowCount, oldestInWindow: null, inflight: 0, maxInflight: 8, lastUsedAt: null, consecutiveFailures: 0, recentRequests: 10, recentErrors: 0,
    recent429: 0, recent5xx: 0, recentTimeouts: 0, errorRate: 0, latencyAvgMs: 1000, latencyP50Ms: 1000, latencyP95Ms: 2000, totalRequests: 0, totalFailures: 0,
    currentModel: null, allowedModels: null, health: 'healthy', ...extra,
  });
  it('prefers headroom and penalises unreliable keys; the alternative strategy is least-loaded', () => {
    const h = new HealthWeightedHeadroomStrategy();
    assert.equal(h.rank([snap('key_1', 53), snap('key_2', 12), snap('key_4', 27)], { model: 'm' })[0].id, 'key_2');
    assert.equal(h.rank([snap('key_1', 10, { errorRate: 0.6, consecutiveFailures: 3, health: 'degraded' }), snap('key_2', 30)], { model: 'm' })[0].id, 'key_2');
    const w = new WeightedLeastLoadedStrategy();
    assert.equal(w.rank([snap('key_1', 20, { inflight: 6 }), snap('key_2', 25)], { model: 'm' })[0].id, 'key_2');
  });
});
