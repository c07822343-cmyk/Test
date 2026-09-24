// Generates the 16 ApexWeb n8n workflows (the visual control plane).
//
// Division of labour: the ApexWeb core service owns state, secrets and the
// step implementations; n8n drives the steps so every stage - intake,
// planning, dispatch, each specialist's execution, key leasing, rate-limit
// waits, retries, QA and assembly - is visible as its own node/execution.
// NVIDIA keys never enter n8n: nodes only ever see key ids like "key_2".
//
// Usage: APEXWEB_CORE_URL=http://apexweb-core:8080 node src/n8n/generate.ts [outDir]
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { stableUuid, WorkflowBuilder, type N8nWorkflow } from './builder.ts';

export const WF = {
  intake: { id: 'apxWf01Intake000', name: 'ApexWeb 01 — Main Intake' },
  main: { id: 'apxWf02MainAgent', name: 'ApexWeb 02 — Main Agent Orchestrator' },
  queue: { id: 'apxWf03TaskQueue', name: 'ApexWeb 03 — Task Queue' },
  keys: { id: 'apxWf04KeyManagr', name: 'ApexWeb 04 — NVIDIA Key Manager' },
  limiter: { id: 'apxWf05RateLimit', name: 'ApexWeb 05 — NVIDIA Rate Limiter' },
  router: { id: 'apxWf06ModelRout', name: 'ApexWeb 06 — Model Router' },
  dispatcher: { id: 'apxWf07Dispatchr', name: 'ApexWeb 07 — Agent Dispatcher' },
  website_development: { id: 'apxWf08WebDevPip', name: 'ApexWeb 08 — Website Development Pipeline' },
  research: { id: 'apxWf09Research0', name: 'ApexWeb 09 — Research Pipeline' },
  content: { id: 'apxWf10Content00', name: 'ApexWeb 10 — Content Pipeline' },
  seo: { id: 'apxWf11SeoPipeln', name: 'ApexWeb 11 — SEO Pipeline' },
  design_review: { id: 'apxWf12DesignRev', name: 'ApexWeb 12 — Design Review Pipeline' },
  qa: { id: 'apxWf13QaPipelin', name: 'ApexWeb 13 — QA Pipeline' },
  assembly: { id: 'apxWf14FinalAsmb', name: 'ApexWeb 14 — Final Assembly' },
  retry: { id: 'apxWf15ErrRetry0', name: 'ApexWeb 15 — Error / Retry Manager' },
  metrics: { id: 'apxWf16Metrics00', name: 'ApexWeb 16 — Observability / Metrics' },
} as const;

const PIPELINES = [
  { key: 'website_development', label: 'Website Development', blurb: 'Website Architect, Frontend Developer (+ Component Builder, Interaction Debugger, Performance Checker), UI/UX Designer, 3D/WebGL Specialist, Animation/Motion Specialist, Website Debugger.' },
  { key: 'research', label: 'Research', blurb: 'Client Intake, Requirements Analyst, Project Manager, Research Coordinator (+ Source Summarizer, Fact Checker), Content Research, Competitive Research, Asset Research.' },
  { key: 'content', label: 'Content', blurb: 'Website Copywriter, Brand Voice, Conversion Optimization (review gate), Proposal Agent, Project Documentation, Revision Manager.' },
  { key: 'seo', label: 'SEO', blurb: 'SEO Specialist (+ Metadata, Schema, Internal Link and Local SEO checkers), Local SEO Specialist.' },
  { key: 'design_review', label: 'Design Review', blurb: 'Design Critic (+ Typography, Spacing, Color, Mobile UI checkers) and Image/Visual Analysis. The Design Critic can reject work and send it back for revision.' },
  { key: 'qa', label: 'QA', blurb: 'Responsive Design, Accessibility, Performance Engineer, QA Director (+ Link, Content Consistency checkers) and the Final QA / Release gate (rejection starts a bounded fix cycle).' },
] as const;

const J = (obj: string) => `={{ JSON.stringify(${obj}) }}`;

// ------------------------------------------------------------------ 01
function intake(core: string): N8nWorkflow {
  const b = new WorkflowBuilder(WF.intake.id, WF.intake.name, core, { active: true, tags: ['apexweb', 'main'] });
  b.sticky('About this workflow', '## 01 · Main Intake\nThe front door. POST `{ "message": "...", "idempotency_key"?: "..." }` to `/webhook/apexweb/request` (header `X-ApexWeb-Webhook-Secret`).\n\nThe request becomes a project (duplicates are detected), then the **Main Agent Orchestrator** takes over. You normally talk to the Main Agent through the dashboard chat; this is the same path for external channels.', [-40, -300], [520, 240], 4);
  b.webhook('MAIN — Receive Request', 'apexweb/request', [0, 0], { respond: 'lastNode' });
  b.ifNode('MAIN — Request Valid?', "typeof $json.body?.message === 'string' && $json.body.message.trim().length > 0 && $json.body.message.length <= 20000", [240, 0]);
  b.core('MAIN — Register Project', "'/v1/main/intake'", [480, -100], { body: J("{ message: $('MAIN — Receive Request').first().json.body.message, idempotency_key: $('MAIN — Receive Request').first().json.body.idempotency_key ?? null }") });
  b.ifNode('MAIN — Duplicate Request?', '$json.duplicate', [720, -100]);
  b.execute('MAIN — Start Main Agent', WF.main.id, WF.main.name, [960, -20], { wait: false });
  b.setJson('OUTPUT — Acknowledge Request', "{ status: $('MAIN — Register Project').first().json.duplicate ? 'duplicate' : 'accepted', project_id: $('MAIN — Register Project').first().json.project_id, message: $('MAIN — Register Project').first().json.duplicate ? 'This request matches an existing project; no duplicate was started.' : 'The Main Agent is interpreting and planning your request.' }", [1200, -100]);
  b.setJson('OUTPUT — Reject Invalid Request', "{ status: 'rejected', error: 'A non-empty \"message\" (max 20,000 chars) is required.' }", [480, 140]);
  b.chain('MAIN — Receive Request', 'MAIN — Request Valid?');
  b.connect('MAIN — Request Valid?', 'MAIN — Register Project', 0);
  b.connect('MAIN — Request Valid?', 'OUTPUT — Reject Invalid Request', 1);
  b.chain('MAIN — Register Project', 'MAIN — Duplicate Request?');
  b.connect('MAIN — Duplicate Request?', 'OUTPUT — Acknowledge Request', 0);
  b.connect('MAIN — Duplicate Request?', 'MAIN — Start Main Agent', 1);
  b.connect('MAIN — Start Main Agent', 'OUTPUT — Acknowledge Request');
  return b.wf;
}

// ------------------------------------------------------------------ 02
function mainAgent(core: string): N8nWorkflow {
  const b = new WorkflowBuilder(WF.main.id, WF.main.name, core, { active: true, tags: ['apexweb', 'main'] });
  b.sticky('About this workflow', '## 02 · Main Agent Orchestrator\nUSER REQUEST → **MAIN AGENT** → TASK PLAN → TASK QUEUE.\n\n1. Interpret the request (NVIDIA via Key Manager)\n2. Ask the user only if genuinely blocked\n3. Task Decomposer adapts the ApexWeb workflow template into a validated dependency graph\n4. Enqueue the graph and wake the dispatcher.\n\nThe Main Agent never does specialist work itself.', [-40, -340], [560, 260], 4);
  b.webhook('MAIN — Orchestrate Webhook', 'apexweb/orchestrate', [0, 0]);
  b.subTrigger('MAIN — Called By Intake', [0, 180]);
  b.setJson('MAIN — Project Context', '{ project_id: $json.body?.project_id ?? $json.project_id }', [240, 80]);
  b.core('MAIN — Interpret Request', "'/v1/main/projects/' + $json.project_id + '/interpret'", [480, 80], { timeoutMs: 600_000, errorOutput: true, notes: 'NVIDIA planning model, routed by the Model Router and leased from the Key Manager' });
  b.ifNode('MAIN — Needs Clarification?', '$json.needs_clarification', [720, 0]);
  b.noop('OUTPUT — Clarification Requested', [960, -120], 'Questions were posted to the user; planning resumes when they answer');
  b.core('MAIN — Build Plan', "'/v1/main/projects/' + $('MAIN — Project Context').first().json.project_id + '/plan'", [960, 60], { timeoutMs: 600_000, errorOutput: true, notes: 'Task Decomposer + plan validation (registry, DAG, required stages, review gates)' });
  b.core('QUEUE — Enqueue Task Graph', "'/v1/main/projects/' + $('MAIN — Project Context').first().json.project_id + '/enqueue'", [1200, 60], { errorOutput: true });
  b.execute('ROUTER — Wake Dispatcher', WF.dispatcher.id, WF.dispatcher.name, [1440, 60], { wait: false });
  b.core('MAIN — Report Planning Failure', "'/v1/main/projects/' + $('MAIN — Project Context').first().json.project_id + '/fail-planning'", [960, 300], { body: J("{ message: String($json.error?.message ?? $json.error ?? 'planning failed').slice(0, 1500) }") });
  b.connect('MAIN — Orchestrate Webhook', 'MAIN — Project Context');
  b.connect('MAIN — Called By Intake', 'MAIN — Project Context');
  b.chain('MAIN — Project Context', 'MAIN — Interpret Request');
  b.connect('MAIN — Interpret Request', 'MAIN — Needs Clarification?', 0);
  b.connect('MAIN — Interpret Request', 'MAIN — Report Planning Failure', 1);
  b.connect('MAIN — Needs Clarification?', 'OUTPUT — Clarification Requested', 0);
  b.connect('MAIN — Needs Clarification?', 'MAIN — Build Plan', 1);
  b.connect('MAIN — Build Plan', 'QUEUE — Enqueue Task Graph', 0);
  b.connect('MAIN — Build Plan', 'MAIN — Report Planning Failure', 1);
  b.connect('QUEUE — Enqueue Task Graph', 'ROUTER — Wake Dispatcher', 0);
  b.connect('QUEUE — Enqueue Task Graph', 'MAIN — Report Planning Failure', 1);
  return b.wf;
}

// ------------------------------------------------------------------ 03
function taskQueue(core: string): N8nWorkflow {
  const b = new WorkflowBuilder(WF.queue.id, WF.queue.name, core, { active: true, tags: ['apexweb', 'queue'] });
  b.sticky('About this workflow', '## 03 · Task Queue\nPersistent queue in Postgres (priorities, dependencies, concurrency cap, retries, dead letters, cancellation, pause, idempotency).\n\n**Claim** returns tasks whose dependencies are all complete, never exceeding the global concurrency cap, plus the tasks still **waiting on dependencies**.\n\nThe reaper returns tasks whose execution lease expired (lost execution) to retry handling.', [-40, -340], [560, 260], 6);
  b.subTrigger('QUEUE — Receive Claim Request', [0, 0]);
  b.core('QUEUE — Claim Ready Tasks', "'/v1/queue/claim'", [240, 0], { body: J("{ limit: 64, owner: 'n8n' }") });
  b.setJson('QUEUE — Check Dependencies', "{ claimed: $json.claimed, claimed_count: $json.claimed_count, waiting_on_dependencies: $json.waiting_on_dependencies, waiting_count: $json.waiting_on_dependencies.length }", [480, 0]);
  b.chain('QUEUE — Receive Claim Request', 'QUEUE — Claim Ready Tasks', 'QUEUE — Check Dependencies');
  b.schedule('QUEUE — Lease Reaper Every Minute', 1, [0, 260]);
  b.core('QUEUE — Reap Expired Leases', "'/v1/queue/reap'", [240, 260]);
  b.chain('QUEUE — Lease Reaper Every Minute', 'QUEUE — Reap Expired Leases');
  return b.wf;
}

// ------------------------------------------------------------------ 04
function keyManager(core: string): N8nWorkflow {
  const b = new WorkflowBuilder(WF.keys.id, WF.keys.name, core, { active: true, tags: ['apexweb', 'nvidia'] });
  b.sticky('About this workflow', '## 04 · NVIDIA Key Manager\nEvery NVIDIA request is leased here first. The core picks the healthiest eligible key (window headroom, error rate, latency, cooldown, in-flight load, model compatibility) inside a locked Postgres transaction.\n\nIf every key is at its 55 RPM ceiling or cooling down, the request **queues** (Rate Limiter wait loop) — work is never dropped.\n\nOnly key ids (key_1…key_4) appear here; secrets never leave the core.', [-40, -380], [600, 300], 3);
  b.subTrigger('KEYPOOL — Receive Lease Request', [0, 0]);
  b.core('KEYPOOL — Select Key', "'/v1/tasks/' + $('KEYPOOL — Receive Lease Request').first().json.task_id + '/lease'", [240, 0], { errorOutput: true });
  b.ifNode('KEYPOOL — Key Granted?', '$json.granted', [480, -40]);
  b.setJson('KEYPOOL — Lease Granted', "{ granted: true, task_id: $('KEYPOOL — Receive Lease Request').first().json.task_id, lease_id: $json.lease_id, key: $json.key, model: $json.model, window_used: $json.window_used, ceiling: $json.ceiling }", [720, -140]);
  b.ifNode('KEYPOOL — Wait Budget Left?', '$runIndex', [720, 60], { type: 'number', operation: 'lt', right: 120 });
  b.execute('LIMITER — Wait For Capacity', WF.limiter.id, WF.limiter.name, [960, 60], { wait: true });
  b.setJson('KEYPOOL — Capacity Timeout', "{ granted: false, error_class: 'capacity_timeout', message: 'All eligible NVIDIA keys stayed at capacity for the whole wait budget' }", [960, 220]);
  b.setJson('KEYPOOL — Lease Error', "{ granted: false, error_class: String($json.error?.message ?? $json.error ?? '').includes('no_keys') || String($json.error?.message ?? '').includes('503') ? 'no_keys' : 'internal_error', message: String($json.error?.message ?? $json.error ?? 'lease request failed').slice(0, 1000) }", [480, 200]);
  b.chain('KEYPOOL — Receive Lease Request', 'KEYPOOL — Select Key');
  b.connect('KEYPOOL — Select Key', 'KEYPOOL — Key Granted?', 0);
  b.connect('KEYPOOL — Select Key', 'KEYPOOL — Lease Error', 1);
  b.connect('KEYPOOL — Key Granted?', 'KEYPOOL — Lease Granted', 0);
  b.connect('KEYPOOL — Key Granted?', 'KEYPOOL — Wait Budget Left?', 1);
  b.connect('KEYPOOL — Wait Budget Left?', 'LIMITER — Wait For Capacity', 0);
  b.connect('KEYPOOL — Wait Budget Left?', 'KEYPOOL — Capacity Timeout', 1);
  b.connect('LIMITER — Wait For Capacity', 'KEYPOOL — Select Key');
  return b.wf;
}

// ------------------------------------------------------------------ 05
function rateLimiter(core: string): N8nWorkflow {
  const b = new WorkflowBuilder(WF.limiter.id, WF.limiter.name, core, { active: true, tags: ['apexweb', 'nvidia'] });
  b.sticky('About this workflow', '## 05 · NVIDIA Rate Limiter\nHard ceiling: **55 requests per rolling 60 s per key** (local safety ceiling, enforced atomically in the core — not a counter that resets each minute).\n\nWhen no key has headroom, this workflow waits exactly until capacity is expected back (oldest grant leaving the window, or cooldown/Retry-After ending), with jitter so queued requests do not retry in lock-step.', [-40, -340], [560, 260], 3);
  b.subTrigger('LIMITER — Receive Wait Request', [0, 0]);
  b.code('LIMITER — Check 55 RPM Window', [
    '// The core reports when the earliest capacity returns (rolling window / cooldown / in-flight cap).',
    'const d = $input.first().json;',
    'const hint = Number(d.retry_after_ms ?? 1000);',
    'const jitter = Math.random() * 0.3;',
    'const wait_s = Math.min(10, Math.max(0.25, hint / 1000 + jitter));',
    'return [{ json: { reason: d.reason ?? "capacity", retry_after_ms: hint, queue_depth: d.queue_depth ?? null, wait_s: Math.round(wait_s * 100) / 100 } }];',
  ].join('\n'), [240, 0]);
  b.wait('LIMITER — Wait For Capacity', '$json.wait_s', [480, 0]);
  b.noop('LIMITER — Capacity Window Elapsed', [720, 0]);
  b.chain('LIMITER — Receive Wait Request', 'LIMITER — Check 55 RPM Window', 'LIMITER — Wait For Capacity', 'LIMITER — Capacity Window Elapsed');
  return b.wf;
}

// ------------------------------------------------------------------ 06
function modelRouter(core: string): N8nWorkflow {
  const b = new WorkflowBuilder(WF.router.id, WF.router.name, core, { active: true, tags: ['apexweb', 'nvidia'] });
  b.sticky('About this workflow', '## 06 · Model Router\nAgents request a **capability** (planning, code, copywriting, review, vision, fast classification…). The router picks an available NVIDIA model from the capability registry (`config/models.json`) with fallbacks; unavailable models are skipped automatically.', [-40, -300], [560, 220], 5);
  b.subTrigger('MODEL — Receive Capability Request', [0, 0]);
  b.core('MODEL — Select NVIDIA Model', "'/v1/tasks/' + $('MODEL — Receive Capability Request').first().json.task_id + '/model'", [240, 0], { errorOutput: true });
  b.setJson('MODEL — Model Selected', "{ ok: true, task_id: $('MODEL — Receive Capability Request').first().json.task_id, model: $json.model, capability: $json.capability, fallbacks: $json.fallbacks }", [480, -60]);
  b.setJson('MODEL — No Model Available', "{ ok: false, error_class: 'model_unavailable', message: String($json.error?.message ?? $json.error ?? 'no model').slice(0, 1000) }", [480, 120]);
  b.chain('MODEL — Receive Capability Request', 'MODEL — Select NVIDIA Model');
  b.connect('MODEL — Select NVIDIA Model', 'MODEL — Model Selected', 0);
  b.connect('MODEL — Select NVIDIA Model', 'MODEL — No Model Available', 1);
  return b.wf;
}

// ------------------------------------------------------------------ 07
function dispatcher(core: string): N8nWorkflow {
  const b = new WorkflowBuilder(WF.dispatcher.id, WF.dispatcher.name, core, { active: true, tags: ['apexweb', 'router'] });
  b.sticky('About this workflow', '## 07 · Agent Dispatcher\nTASK QUEUE → **AGENT DISPATCH** → SPECIALIST PIPELINES.\n\nClaims every ready task and starts one pipeline execution per task **without waiting**, so independent tasks run in parallel (each appears as its own execution). Tasks still waiting on dependencies are listed on the lower branch.\n\nWoken by the core when tasks become ready, by pipelines when they finish, and every minute as a safety net.', [-40, -420], [620, 300], 6);
  b.webhook('ROUTER — Dispatch Webhook', 'apexweb/dispatch', [0, -60]);
  b.schedule('ROUTER — Safety Net Every Minute', 1, [0, 100]);
  b.subTrigger('ROUTER — Called By Workflow', [0, 260]);
  b.execute('QUEUE — Claim Ready Tasks', WF.queue.id, WF.queue.name, [260, 100], { wait: true });
  b.splitOut('QUEUE — Split Claimed Tasks', 'claimed', [500, 20]);
  b.splitOut('QUEUE — Split Waiting Tasks', 'waiting_on_dependencies', [500, 300]);
  b.noop('QUEUE — Waiting On Dependencies', [740, 300], 'These tasks start automatically when their dependencies complete');
  b.switchNode('ROUTER — Route By Pipeline', '$json.pipeline', PIPELINES.map((p) => ({ value: p.key, label: p.label })), [740, 20]);
  PIPELINES.forEach((p, i) => {
    const wf = WF[p.key];
    b.execute(`EXECUTOR — ${p.label} Pipeline`, wf.id, wf.name, [1020, -260 + i * 120], { wait: false, each: true });
    b.connect('ROUTER — Route By Pipeline', `EXECUTOR — ${p.label} Pipeline`, i);
  });
  b.noop('ROUTER — Unknown Pipeline', [1020, 480], 'Should never happen: every registered agent maps to a pipeline');
  b.connect('ROUTER — Route By Pipeline', 'ROUTER — Unknown Pipeline', PIPELINES.length);
  for (const t of ['ROUTER — Dispatch Webhook', 'ROUTER — Safety Net Every Minute', 'ROUTER — Called By Workflow']) b.connect(t, 'QUEUE — Claim Ready Tasks');
  b.connect('QUEUE — Claim Ready Tasks', 'QUEUE — Split Claimed Tasks');
  b.connect('QUEUE — Claim Ready Tasks', 'QUEUE — Split Waiting Tasks');
  b.chain('QUEUE — Split Claimed Tasks', 'ROUTER — Route By Pipeline');
  b.chain('QUEUE — Split Waiting Tasks', 'QUEUE — Waiting On Dependencies');
  return b.wf;
}

// ------------------------------------------------------------------ 08-13
function pipeline(core: string, p: (typeof PIPELINES)[number]): N8nWorkflow {
  const wf = WF[p.key];
  const b = new WorkflowBuilder(wf.id, wf.name, core, { active: true, tags: ['apexweb', 'pipeline'] });
  const task = "$('PIPELINE — Receive Task').first().json.task_id";
  const T = (suffix: string) => `'/v1/tasks/' + ${task} + '/${suffix}'`;
  b.sticky('About this workflow', `## ${wf.name.replace('ApexWeb ', '')}\nSPECIALIST AGENT execution, one execution per task.\n\n**Agents:** ${p.blurb}\n\nStart → pre-execution tools (real audits) → Model Router → Context Builder (only what this task needs) → Key Manager / 55 RPM limiter → NVIDIA call → structured-output review (schema, files, sub-agents, review gates) → next stage. Failures go to the Error / Retry Manager.`, [-40, -440], [640, 300], 5);
  b.subTrigger('PIPELINE — Receive Task', [0, 0]);
  b.core('EXECUTOR — Start Task', T('start'), [220, 0], { errorOutput: true });
  b.core('TOOLS — Run Pre-Execution Tools', T('tools'), [440, 0], { errorOutput: true, timeoutMs: 300_000, notes: 'Deterministic evidence: static/SEO/anti-slop audits, Chromium responsive/axe/performance checks, fetched sources' });
  b.setJson('MODEL — Capability Request', `{ task_id: ${task} }`, [560, 120]);
  b.execute('MODEL — Select NVIDIA Model', WF.router.id, WF.router.name, [660, 0], { wait: true });
  b.ifNode('MODEL — Model Available?', '$json.ok', [880, 0]);
  b.core('CONTEXT — Build Context', T('context'), [1100, -60], { errorOutput: true });
  b.setJson('KEYPOOL — Lease Request', `{ task_id: ${task} }`, [1210, 60]);
  b.execute('KEYPOOL — Acquire Key Lease', WF.keys.id, WF.keys.name, [1320, -60], { wait: true });
  b.ifNode('KEYPOOL — Lease Granted?', '$json.granted', [1540, -60]);
  b.core('EXECUTOR — Run Agent', T('invoke'), [1760, -120], { body: J("{ lease_id: $json.lease_id }"), errorOutput: true, timeoutMs: 600_000, notes: 'One NVIDIA call with the leased key (secret stays in the core)' });
  b.ifNode('EXECUTOR — Call Succeeded?', '$json.ok', [1980, -120]);
  b.core('REVIEW — Validate Result', T('review'), [2200, -200], { errorOutput: true, notes: 'Schema + files + sub-agents + review gates' });
  b.switchNode('REVIEW — Route Outcome', '$json.outcome', [
    { value: 'completed', label: 'Completed' },
    { value: 'waiting_on_subtasks', label: 'Sub-agents spawned' },
    { value: 'revision_requested', label: 'Revision requested' },
    { value: 'fix_cycle_started', label: 'QA fix cycle' },
    { value: 'retry', label: 'Retry scheduled' },
  ], [2420, -200]);
  b.noop('QUEUE — Task Completed', [2680, -440]);
  b.noop('SUBAGENTS — Sub-Agents Spawned', [2680, -320], 'Parent waits; sub-agent results come back for synthesis');
  b.noop('REVIEW — Sent Back For Revision', [2680, -200], 'Reviewer rejected the target work; it re-runs with feedback');
  b.noop('QA — Fix Cycle Started', [2680, -80], 'Website Debugger fixes QA findings, then QA re-runs');
  b.execute('ROUTER — Wake Dispatcher', WF.dispatcher.id, WF.dispatcher.name, [2940, -260], { wait: false });
  b.setJson('RETRY — Decided By Review', `{ task_id: ${task}, already_decided: true, decision: $json.decision ?? null, outcome: $json.outcome, error_class: $json.detail?.error?.class ?? null, message: $json.detail?.error?.message ?? null }`, [2680, 60]);
  b.setJson('RETRY — Model Call Failed', `{ task_id: ${task}, already_decided: false, error_class: $json.error_class, message: $json.message, retry_after_ms: $json.retry_after_ms ?? null }`, [2200, 40]);
  b.setJson('RETRY — Step Failed', `{ task_id: ${task}, already_decided: false, error_class: $json.error_class ?? (String($json.error?.message ?? $json.error ?? '').includes('503') ? 'model_unavailable' : 'internal_error'), message: String($json.message ?? $json.error?.message ?? $json.error ?? 'step failed').slice(0, 1500) }`, [1540, 220]);
  b.execute('RETRY — Hand To Error Manager', WF.retry.id, WF.retry.name, [2940, 140], { wait: false });

  b.chain('PIPELINE — Receive Task', 'EXECUTOR — Start Task');
  b.connect('EXECUTOR — Start Task', 'TOOLS — Run Pre-Execution Tools', 0);
  b.connect('TOOLS — Run Pre-Execution Tools', 'MODEL — Capability Request', 0);
  b.connect('MODEL — Capability Request', 'MODEL — Select NVIDIA Model');
  b.connect('MODEL — Select NVIDIA Model', 'MODEL — Model Available?');
  b.connect('MODEL — Model Available?', 'CONTEXT — Build Context', 0);
  b.connect('CONTEXT — Build Context', 'KEYPOOL — Lease Request', 0);
  b.connect('KEYPOOL — Lease Request', 'KEYPOOL — Acquire Key Lease');
  b.connect('KEYPOOL — Acquire Key Lease', 'KEYPOOL — Lease Granted?');
  b.connect('KEYPOOL — Lease Granted?', 'EXECUTOR — Run Agent', 0);
  b.connect('EXECUTOR — Run Agent', 'EXECUTOR — Call Succeeded?', 0);
  b.connect('EXECUTOR — Call Succeeded?', 'REVIEW — Validate Result', 0);
  b.connect('EXECUTOR — Call Succeeded?', 'RETRY — Model Call Failed', 1);
  b.connect('REVIEW — Validate Result', 'REVIEW — Route Outcome', 0);
  const outcomes = ['QUEUE — Task Completed', 'SUBAGENTS — Sub-Agents Spawned', 'REVIEW — Sent Back For Revision', 'QA — Fix Cycle Started'];
  outcomes.forEach((n, i) => {
    b.connect('REVIEW — Route Outcome', n, i);
    b.connect(n, 'ROUTER — Wake Dispatcher');
  });
  b.connect('REVIEW — Route Outcome', 'RETRY — Decided By Review', 4);
  b.connect('REVIEW — Route Outcome', 'RETRY — Decided By Review', 5);
  // Every step's error output funnels into failure handling.
  for (const n of ['EXECUTOR — Start Task', 'TOOLS — Run Pre-Execution Tools', 'CONTEXT — Build Context', 'EXECUTOR — Run Agent', 'REVIEW — Validate Result']) b.connect(n, 'RETRY — Step Failed', 1);
  b.connect('MODEL — Model Available?', 'RETRY — Step Failed', 1);
  b.connect('KEYPOOL — Lease Granted?', 'RETRY — Step Failed', 1);
  for (const n of ['RETRY — Decided By Review', 'RETRY — Model Call Failed', 'RETRY — Step Failed']) b.connect(n, 'RETRY — Hand To Error Manager');
  return b.wf;
}

// ------------------------------------------------------------------ 14
function assembly(core: string): N8nWorkflow {
  const b = new WorkflowBuilder(WF.assembly.id, WF.assembly.name, core, { active: true, tags: ['apexweb', 'qa'] });
  b.sticky('About this workflow', '## 14 · Final Assembly\nREVIEW → QA → **FINAL RESULT**.\n\nTriggered by the core when a project\'s task graph has settled with every required task complete. Packages the site, docs and reports (tar.gz), and the Main Agent writes the completion report: Completed · Agents Used · Outputs · Issues · QA · Files · Recommended Next Step.', [-40, -340], [580, 260], 4);
  b.webhook('ASSEMBLY — Project Settled', 'apexweb/final-assembly', [0, 0]);
  b.core('ASSEMBLY — Assemble Package', "'/v1/main/projects/' + $json.body.project_id + '/assemble'", [240, 0], { timeoutMs: 600_000, errorOutput: true });
  b.ifNode('QA — Final QA Passed?', '$json.report?.qa?.passed === true', [480, -60]);
  b.setJson('OUTPUT — Completion Report', "{ project_id: $json.project_id, qa: 'passed', completed: $json.report.completed, agents_used: $json.report.agents_used.map(a => a.name), files: $json.report.files, next_step: $json.report.recommended_next_step }", [720, -140]);
  b.setJson('OUTPUT — Completion Report (QA Issues)', "{ project_id: $json.project_id, qa: $json.report?.qa?.verdict ?? 'not run', remaining_issues: $json.report?.qa?.remaining_issues ?? [], completed: $json.report?.completed, files: $json.report?.files }", [720, 20]);
  b.noop('ASSEMBLY — Assembly Failed', [480, 160], 'Project stays ASSEMBLING; re-send this webhook or call /v1/main/projects/:id/assemble to retry');
  b.chain('ASSEMBLY — Project Settled', 'ASSEMBLY — Assemble Package');
  b.connect('ASSEMBLY — Assemble Package', 'QA — Final QA Passed?', 0);
  b.connect('ASSEMBLY — Assemble Package', 'ASSEMBLY — Assembly Failed', 1);
  b.connect('QA — Final QA Passed?', 'OUTPUT — Completion Report', 0);
  b.connect('QA — Final QA Passed?', 'OUTPUT — Completion Report (QA Issues)', 1);
  return b.wf;
}

// ------------------------------------------------------------------ 15
function retryManager(core: string): N8nWorkflow {
  const b = new WorkflowBuilder(WF.retry.id, WF.retry.name, core, { active: true, tags: ['apexweb', 'retry'] });
  b.sticky('About this workflow', '## 15 · Error / Retry Manager\nFailed attempts land here. The Failure Manager decides:\n- attempt 1 → **retry**\n- attempt 2 → **retry with backoff** (switching model if a fallback exists)\n- attempt 3 → failed → one **rescue** on another model, else **escalate to the Main Agent**\n- 429 / capacity / revoked key → re-lease on another **eligible key** (does not burn an attempt, bounded)\n\nNo endless retries: everything is capped and dead-lettered.', [-40, -420], [600, 320], 2);
  b.subTrigger('RETRY — Receive Failure', [0, 0]);
  b.ifNode('RETRY — Already Decided?', '$json.already_decided', [240, 0]);
  b.core('RETRY — Record Failure & Decide', "'/v1/tasks/' + $json.task_id + '/fail'", [480, 100], { body: J("{ error_class: $json.error_class ?? 'internal_error', message: String($json.message ?? '').slice(0, 3900), retry_after_ms: $json.retry_after_ms ?? null }"), errorOutput: true });
  b.code('RETRY — Classify Decision', [
    'const d = $input.first().json;',
    'const decision = d.decision ?? null;',
    'const action = decision?.action ?? "none";',
    'const retryActions = ["retry", "retry_backoff", "retry_other_key", "switch_model", "rescue"];',
    'const category = retryActions.includes(action) ? "retry" : action === "escalate" ? "escalate" : action === "fail_optional" ? "skip_optional" : "none";',
    'const delay_s = Math.min(60, Math.max(1, Math.round((decision?.delayMs ?? 1000) / 100) / 10));',
    'return [{ json: { task_id: d.task?.task_id ?? d.task_id ?? null, action, category, delay_s, reason: decision?.reason ?? null, next_model: decision?.nextModel ?? null } }];',
  ].join('\n'), [720, 0]);
  b.switchNode('RETRY — Route Decision', '$json.category', [
    { value: 'retry', label: 'Retry' },
    { value: 'escalate', label: 'Escalate' },
    { value: 'skip_optional', label: 'Optional task skipped' },
  ], [960, 0]);
  b.wait('RETRY — Backoff Before Re-dispatch', '$json.delay_s', [1200, -140]);
  b.noop('MAIN — Escalated To Main Agent', [1200, 0], 'Task failed after retries, model switch and rescue; the Main Agent flags the project for the user');
  b.noop('RETRY — Optional Task Skipped', [1200, 140], 'Optional task failed; dependents proceed without it');
  b.execute('ROUTER — Re-dispatch', WF.dispatcher.id, WF.dispatcher.name, [1440, 0], { wait: false });
  b.noop('RETRY — No Action Needed', [1200, 280]);
  b.noop('RETRY — Could Not Record Failure', [720, 260], 'Core unreachable; the lease reaper will retry the task when its lease expires');
  b.connect('RETRY — Receive Failure', 'RETRY — Already Decided?');
  b.connect('RETRY — Already Decided?', 'RETRY — Classify Decision', 0);
  b.connect('RETRY — Already Decided?', 'RETRY — Record Failure & Decide', 1);
  b.connect('RETRY — Record Failure & Decide', 'RETRY — Classify Decision', 0);
  b.connect('RETRY — Record Failure & Decide', 'RETRY — Could Not Record Failure', 1);
  b.connect('RETRY — Classify Decision', 'RETRY — Route Decision');
  b.connect('RETRY — Route Decision', 'RETRY — Backoff Before Re-dispatch', 0);
  b.connect('RETRY — Route Decision', 'MAIN — Escalated To Main Agent', 1);
  b.connect('RETRY — Route Decision', 'RETRY — Optional Task Skipped', 2);
  b.connect('RETRY — Route Decision', 'RETRY — No Action Needed', 3);
  for (const n of ['RETRY — Backoff Before Re-dispatch', 'MAIN — Escalated To Main Agent', 'RETRY — Optional Task Skipped']) b.connect(n, 'ROUTER — Re-dispatch');
  return b.wf;
}

// ------------------------------------------------------------------ 16
function metrics(core: string): N8nWorkflow {
  const b = new WorkflowBuilder(WF.metrics.id, WF.metrics.name, core, { active: true, tags: ['apexweb', 'observability'] });
  b.sticky('About this workflow', '## 16 · Observability / Metrics\nEvery minute: live runtime state from the core (not mocked) — active/queued/completed/failed/retrying tasks, active vs idle agents, per-key RPM against the 55 ceiling, current model, latency, error rate, queue depth, project progress, task durations. Snapshots are stored so trends survive restarts.\n\nGET `/webhook/apexweb/metrics` renders the same view on demand. Connect Slack/email to **METRICS — Raise Alert**.', [-40, -400], [620, 300], 5);
  b.schedule('METRICS — Every Minute', 1, [0, 0]);
  b.webhook('METRICS — On-Demand View', 'apexweb/metrics', [0, 200], { method: 'GET', respond: 'lastNode' });
  b.core('METRICS — Snapshot Runtime State', "'/v1/observability/snapshot'", [240, 100]);
  b.code('METRICS — Render Key Usage Bars', [
    'const { metrics, text } = $input.first().json;',
    'const bar = (used, cap, w = 23) => { const f = cap > 0 ? Math.round(Math.min(used, cap) / cap * w) : 0; return "█".repeat(f) + "░".repeat(w - f); };',
    'const keys = metrics.nvidia.keys.map(k => ({ key: k.id.replace("key_", "KEY "), usage: `${bar(k.rpm_used, k.rpm_ceiling)} ${k.rpm_used}/${k.rpm_ceiling} RPM`, health: k.health, model: k.current_model, inflight: k.inflight, latency_p50_ms: k.latency_p50_ms, error_rate_5m: k.error_rate_5m }));',
    'const t = metrics.tasks;',
    'return [{ json: { generated_at: metrics.generated_at, keys, tasks: `${t.active} active · ${t.queued} queued · ${t.waiting} waiting · ${t.retrying} retrying · ${t.completed} completed · ${t.failed} failed`, agents: `${metrics.agents.active} active / ${metrics.agents.idle} idle`, nvidia: `${metrics.nvidia.requests_last_minute} req/min · p95 ${metrics.nvidia.latency_p95_ms ?? "-"}ms · error rate ${(metrics.nvidia.error_rate_5m * 100).toFixed(1)}%`, queue_depth: t.queue_depth, projects: metrics.projects.map(p => `${p.name}: ${p.completed}/${p.total} (${p.status})`), dashboard: text } }];',
  ].join('\n'), [480, 20]);
  b.ifNode('METRICS — Alerts Raised?', '($json.alerts ?? []).length', [480, 220], { type: 'number', operation: 'gt', right: 0 });
  b.noop('METRICS — Raise Alert', [720, 160], 'Attach Slack / email / PagerDuty here');
  b.noop('METRICS — All Systems Nominal', [720, 300]);
  b.connect('METRICS — Every Minute', 'METRICS — Snapshot Runtime State');
  b.connect('METRICS — On-Demand View', 'METRICS — Snapshot Runtime State');
  b.connect('METRICS — Snapshot Runtime State', 'METRICS — Render Key Usage Bars');
  b.connect('METRICS — Snapshot Runtime State', 'METRICS — Alerts Raised?');
  b.connect('METRICS — Alerts Raised?', 'METRICS — Raise Alert', 0);
  b.connect('METRICS — Alerts Raised?', 'METRICS — All Systems Nominal', 1);
  return b.wf;
}

export function generateWorkflows(coreUrl: string): N8nWorkflow[] {
  const all = [
    intake(coreUrl),
    mainAgent(coreUrl),
    taskQueue(coreUrl),
    keyManager(coreUrl),
    rateLimiter(coreUrl),
    modelRouter(coreUrl),
    dispatcher(coreUrl),
    ...PIPELINES.map((p) => pipeline(coreUrl, p)),
    assembly(coreUrl),
    retryManager(coreUrl),
    metrics(coreUrl),
  ];
  // n8n 2.x keys workflow history by versionId: derive it from content so every
  // change is a new version (re-publishing an unchanged id would keep the old graph).
  for (const wf of all) wf.versionId = stableUuid(JSON.stringify({ nodes: wf.nodes, connections: wf.connections, settings: wf.settings }));
  return all;
}

export function writeWorkflows(outDir: string, coreUrl: string): string[] {
  mkdirSync(outDir, { recursive: true });
  const written: string[] = [];
  for (const wf of generateWorkflows(coreUrl)) {
    const file = path.join(outDir, `${wf.name.replace(/^ApexWeb /, '').replace(/[^A-Za-z0-9]+/g, '-').replace(/-+$/, '').toLowerCase()}.json`);
    writeFileSync(file, JSON.stringify(wf, null, 2) + '\n');
    written.push(file);
  }
  return written;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const out = process.argv[2] ?? 'n8n/workflows';
  const core = process.env.APEXWEB_CORE_URL ?? 'http://apexweb-core:8080';
  const files = writeWorkflows(out, core);
  console.log(`wrote ${files.length} workflows to ${out} (core: ${core})`);
}
