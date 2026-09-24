// Task Executor: the individual execution steps of one agent task. The n8n
// pipelines call these steps one HTTP node at a time (so every step, wait,
// retry and failure is visible); the internal worker composes the very same
// functions. There is exactly one implementation of the execution semantics.
import { allowedSubAgents, getAgent, hasAgent } from '../agents/registry.ts';
import { OutputValidationError, parseAgentOutput, type Envelope, type Issue } from '../agents/output.ts';
import type { AppConfig } from '../config/env.ts';
import type { Db } from '../db/pool.ts';
import type { ArtifactStore } from '../memory/artifacts.ts';
import type { MemoryStore } from '../memory/memory.ts';
import { decideFailure, type ErrorClass, type FailureDecision } from '../orchestrator/failureManager.ts';
import type { ContextBuilder } from '../orchestrator/contextBuilder.ts';
import type { KeyPool, Lease } from '../provider/keyPool.ts';
import type { NvidiaProvider } from '../provider/provider.ts';
import type { ChatMessage } from '../provider/nvidiaClient.ts';
import type { Capability } from '../provider/modelRegistry.ts';
import type { ProjectStore } from '../queue/projects.ts';
import type { TaskQueue } from '../queue/taskQueue.ts';
import type { NewTaskSpec, TaskRow } from '../queue/types.ts';
import { runAgentTools, type ToolResult } from '../tools/runner.ts';
import { AppError, newId } from '../util/common.ts';
import { errorMessage, logger } from '../util/log.ts';

const log = logger('executor');

export interface ExecutorDeps {
  db: Db;
  config: AppConfig;
  queue: TaskQueue;
  projects: ProjectStore;
  provider: NvidiaProvider;
  keyPool: KeyPool;
  memory: MemoryStore;
  artifacts: ArtifactStore;
  contextBuilder: ContextBuilder;
  fetchImpl?: typeof fetch;
}

export interface StepContext {
  actor: string;
  executionId?: string | null;
  workflow?: string | null;
}

export type LeaseStepResult =
  | { granted: true; lease_id: string; key: string; model: string; window_used: number; ceiling: number }
  | { granted: false; retry_after_ms: number; reason: string; queue_depth: number };

export type InvokeStepResult =
  | { ok: true; model: string; key: string; latency_ms: number; usage: unknown; output_chars: number }
  | { ok: false; error_class: string; message: string; retry_after_ms: number | null };

export interface ReviewStepResult {
  outcome: 'completed' | 'waiting_on_subtasks' | 'revision_requested' | 'fix_cycle_started' | 'retry' | 'failed' | 'escalated';
  task: ReturnType<typeof summarise>;
  detail?: unknown;
  decision?: FailureDecision;
}

function summarise(t: TaskRow) {
  return { task_id: t.id, project_id: t.project_id, agent_type: t.agent_type, title: t.title, status: t.status, attempt: t.attempt, revision: t.revision, kind: t.kind };
}

const WORKER_STATUSES: TaskRow['status'][] = ['ASSIGNED', 'RUNNING', 'REVIEW'];

export class TaskExecutor {
  readonly d: ExecutorDeps;

  constructor(deps: ExecutorDeps) {
    this.d = deps;
  }

  async #recordStep(ctx: StepContext, task: TaskRow, step: string, status: string): Promise<void> {
    if (!ctx.executionId) return;
    await this.d.db.query(
      `INSERT INTO workflow_runs (workflow, execution_id, task_id, project_id, step, status) VALUES ($1, $2, $3, $4, $5, $6)`,
      [ctx.workflow ?? 'unknown', ctx.executionId, task.id, task.project_id, step, status],
    );
  }

  pipelineFor(task: TaskRow): string {
    return getAgent(task.agent_type).pipeline;
  }

  // ------------------------------------------------------------ STEP 1
  /** ASSIGNED -> RUNNING. Increments the attempt counter and records which execution owns the task. */
  async start(taskId: string, ctx: StepContext): Promise<TaskRow> {
    const task = await this.d.queue.get(taskId);
    if (task.status !== 'ASSIGNED') throw new AppError('not_assigned', `Task ${taskId} is ${task.status}, expected ASSIGNED`, 409);
    const project = await this.d.projects.get(task.project_id);
    if (project.paused) {
      // Paused between claim and start: hand the task back untouched.
      const released = await this.d.queue.transition(taskId, ['ASSIGNED'], 'QUEUED', { lease_owner: null, lease_expires_at: null }, { type: 'released_paused', actor: ctx.actor });
      throw new AppError('project_paused', `Project ${project.id} is paused; task ${released.id} returned to queue`, 409);
    }
    const running = await this.d.queue.transition(
      taskId,
      ['ASSIGNED'],
      'RUNNING',
      { attempt: task.attempt + 1, started_at: task.started_at ?? new Date(), workflow_execution_id: ctx.executionId ?? task.workflow_execution_id, error: null },
      { type: 'started', actor: ctx.actor, detail: { attempt: task.attempt + 1, phase: task.phase, execution_id: ctx.executionId ?? null, workflow: ctx.workflow ?? null } },
    );
    await this.#recordStep(ctx, running, 'start', 'RUNNING');
    return running;
  }

  // ------------------------------------------------------------ STEP 2
  async runTools(taskId: string, ctx: StepContext): Promise<{ tools: Array<Pick<ToolResult, 'tool' | 'ok' | 'available' | 'error'> & { findings: number; hard_failures: number }> }> {
    const task = await this.#requireRunning(taskId);
    const agent = getAgent(task.agent_type);
    const results = agent.tools?.length
      ? await runAgentTools(agent, task, { config: this.d.config, artifacts: this.d.artifacts, memory: this.d.memory, fetchImpl: this.d.fetchImpl })
      : [];
    await this.d.queue.extendLease(taskId, task.lease_owner ?? ctx.actor);
    await this.#recordStep(ctx, task, 'tools', 'RUNNING');
    return { tools: results.map((r) => ({ tool: r.tool, ok: r.ok, available: r.available, error: r.error, findings: r.findings.length, hard_failures: r.hard_failures.length })) };
  }

  // ------------------------------------------------------------ STEP 3
  /** Model Router: capability -> ordered NVIDIA model candidates. Honors operator/failure-manager overrides. */
  async selectModel(taskId: string, ctx: StepContext): Promise<{ model: string; capability: string; fallbacks: string[]; vision: boolean }> {
    const task = await this.#requireRunning(taskId);
    const agent = getAgent(task.agent_type);
    const capability = (task.capability ?? agent.capability) as Capability;
    const candidates = this.d.provider.router.candidates({ capability, vision: capability === 'vision', prefer: task.model_override });
    if (candidates.length === 0) {
      throw new AppError('model_unavailable', `No available NVIDIA model for capability ${capability}`, 503);
    }
    const model = candidates[0];
    await this.d.db.query('UPDATE tasks SET assigned_model = $2, updated_at = now() WHERE id = $1', [taskId, model.id]);
    await this.d.queue.recordEvent(this.d.db, task, 'model_selected', task.status, task.status, ctx.actor, { model: model.id, capability, fallbacks: candidates.slice(1).map((m) => m.id) });
    await this.#recordStep(ctx, task, 'model', 'RUNNING');
    return { model: model.id, capability, fallbacks: candidates.slice(1).map((m) => m.id), vision: model.vision };
  }

  // ------------------------------------------------------------ STEP 4
  async buildContext(taskId: string, ctx: StepContext): Promise<{ chars: number; budget: number; sections: unknown; images: number }> {
    const task = await this.#requireRunning(taskId);
    const model = this.d.provider.router.get(task.assigned_model ?? '') ?? this.d.provider.router.select({ capability: getAgent(task.agent_type).capability });
    const built = await this.d.contextBuilder.build(task, model);
    await this.d.memory.set('task', taskId, 'prompt', { messages: built.messages, model: model.id }, 'context_builder');
    await this.#recordStep(ctx, task, 'context', 'RUNNING');
    return built.stats;
  }

  // ------------------------------------------------------------ STEP 5
  /** KEYPOOL + LIMITER: non-blocking lease request (n8n renders the wait); `wait` makes it blocking (internal driver). */
  async lease(taskId: string, ctx: StepContext, opts: { wait?: boolean; signal?: AbortSignal } = {}): Promise<LeaseStepResult> {
    const task = await this.#requireRunning(taskId);
    const model = task.assigned_model;
    if (!model) throw new AppError('no_model', 'Select a model before requesting a key lease', 409);
    const request = { model, requesterId: `task:${task.id}`, priority: task.priority, taskId: task.id, purpose: `agent:${task.agent_type}` };
    let lease: Lease;
    if (opts.wait) {
      lease = await this.d.keyPool.acquire({ ...request, maxWaitMs: this.d.config.nvidia.maxLeaseWaitMs, signal: opts.signal });
    } else {
      const d = await this.d.keyPool.tryAcquire(request);
      if (!d.granted) {
        if (d.reason === 'no_compatible_key') throw new AppError('no_keys', `No active NVIDIA key can serve ${model}`, 503);
        await this.#recordStep(ctx, task, 'lease_wait', 'RUNNING');
        // Cap the poll interval so the caller keeps its queue position.
        return { granted: false, retry_after_ms: Math.min(d.retryAfterMs, 10_000), reason: d.reason, queue_depth: this.d.keyPool.waitingCount };
      }
      lease = d.lease;
    }
    await this.d.db.query('UPDATE tasks SET assigned_key = $2, updated_at = now() WHERE id = $1', [taskId, lease.keyId]);
    await this.d.queue.recordEvent(this.d.db, task, 'key_leased', task.status, task.status, ctx.actor, { key: lease.keyId, model: lease.model, window_used: lease.windowCountAfterGrant, ceiling: lease.ceiling });
    await this.#recordStep(ctx, task, 'lease', 'RUNNING');
    return { granted: true, lease_id: lease.leaseId, key: lease.keyId, model: lease.model, window_used: lease.windowCountAfterGrant, ceiling: lease.ceiling };
  }

  // ------------------------------------------------------------ STEP 6
  /** EXECUTOR: one NVIDIA call with the leased key. Success moves the task to REVIEW. */
  async invoke(taskId: string, leaseId: string, ctx: StepContext, signal?: AbortSignal): Promise<InvokeStepResult> {
    const task = await this.#requireRunning(taskId);
    const { rows } = await this.d.db.query(
      `SELECT lease_id, key_id, model, granted_at, status, task_id FROM key_requests WHERE lease_id = $1`,
      [leaseId],
    );
    const row = rows[0];
    if (!row || row.task_id !== taskId || row.status !== 'granted') {
      throw new AppError('lease_invalid', `Lease ${leaseId} is not a live lease for task ${taskId}`, 409);
    }
    const prompt = await this.d.memory.get<{ messages: ChatMessage[]; model: string }>('task', taskId, 'prompt');
    if (!prompt) throw new AppError('no_context', 'Build context before invoking the model', 409);
    const agent = getAgent(task.agent_type);
    const lease: Lease = { leaseId, keyId: row.key_id, model: row.model, grantedAt: row.granted_at, windowCountAfterGrant: 0, ceiling: this.d.config.nvidia.rpmPerKey };
    const result = await this.d.provider.invokeWithLease(lease, {
      messages: prompt.messages,
      maxTokens: agent.maxTokens,
      temperature: agent.temperature,
      metadata: { taskId, projectId: task.project_id, purpose: `agent:${agent.type}` },
      signal,
    });
    if (!result.ok) {
      await this.#recordStep(ctx, task, 'invoke', 'FAILED_ATTEMPT');
      return { ok: false, error_class: result.errorClass, message: result.message, retry_after_ms: result.retryAfterMs };
    }
    await this.d.memory.set('task', taskId, 'raw_output', { content: result.response.content, model: result.response.model, key: result.response.keyId, finish_reason: result.response.finishReason, usage: result.response.usage }, 'provider');
    await this.d.queue.transition(taskId, ['RUNNING'], 'REVIEW', {}, {
      type: 'model_responded',
      actor: ctx.actor,
      detail: { model: result.response.model, key: result.response.keyId, latency_ms: result.response.latencyMs, usage: result.response.usage, finish_reason: result.response.finishReason },
    });
    await this.#recordStep(ctx, task, 'invoke', 'REVIEW');
    return { ok: true, model: result.response.model, key: result.response.keyId, latency_ms: result.response.latencyMs, usage: result.response.usage, output_chars: result.response.content.length };
  }

  // ------------------------------------------------------------ STEP 7
  /** REVIEW: validates the output, applies files, spawns sub-agents, enforces review gates, completes the task. */
  async review(taskId: string, ctx: StepContext): Promise<ReviewStepResult> {
    const task = await this.d.queue.get(taskId);
    if (task.status !== 'REVIEW') throw new AppError('not_in_review', `Task ${taskId} is ${task.status}, expected REVIEW`, 409);
    const agent = getAgent(task.agent_type);
    const raw = await this.d.memory.get<{ content: string; finish_reason: string | null; model: string; key: string }>('task', taskId, 'raw_output');
    if (!raw) return this.fail(taskId, { errorClass: 'malformed_output', message: 'no model output recorded' }, ctx);

    let envelope: Envelope;
    let files: Array<{ path: string; content: string }>;
    try {
      ({ envelope, files } = parseAgentOutput(raw.content, { allowFiles: !!agent.producesFiles, reviewer: !!agent.reviewer }));
    } catch (err) {
      const problems = err instanceof OutputValidationError ? err.problems : [errorMessage(err)];
      const truncated = raw.finish_reason === 'length' ? ' The response hit the output token limit: be more concise (shorter prose, compact CSS) so the complete answer fits.' : '';
      return this.fail(taskId, { errorClass: 'malformed_output', message: `Output rejected: ${problems.join('; ')}.${truncated}` }, ctx);
    }

    // Persist files as versioned artifacts.
    const written: Array<{ path: string; version: number; bytes: number }> = [];
    for (const f of files) {
      const isDoc = f.path.startsWith('docs/');
      const stored = isDoc || f.path.startsWith('site/') ? f.path : `site/${f.path}`;
      try {
        const meta = await this.d.artifacts.save({ projectId: task.project_id, taskId, path: stored, content: f.content, kind: isDoc ? 'doc' : 'site', createdBy: agent.type });
        written.push({ path: meta.path, version: meta.version, bytes: meta.bytes });
      } catch (err) {
        return this.fail(taskId, { errorClass: 'validation_error', message: `File ${f.path} rejected: ${errorMessage(err)}` }, ctx);
      }
    }
    const outputs: Record<string, unknown> = { ...envelope, files: written, model: raw.model, key: raw.key };
    await this.#absorbFacts(task, envelope);

    // Sub-agent delegation (execute phase only).
    if (task.phase === 'execute' && envelope.subtasks.length) {
      const allowed = new Set(allowedSubAgents(agent.type));
      const bad = envelope.subtasks.filter((s) => !allowed.has(s.agent_type) || !hasAgent(s.agent_type));
      if (bad.length) {
        return this.fail(taskId, { errorClass: 'validation_error', message: `Subtasks use agent types not allowed for ${agent.type}: ${bad.map((b) => b.agent_type).join(', ')}` }, ctx);
      }
      return this.#spawnSubtasks(task, envelope, outputs, ctx);
    }

    // Review gates.
    let review = envelope.review;
    if (agent.reviewer && review) {
      const toolResults = (await this.d.memory.get<ToolResult[]>('task', taskId, 'tool_results')) ?? [];
      const hard = toolResults.flatMap((r) => r.hard_failures ?? []);
      if (hard.length && review.verdict === 'approve' && (task.kind === 'qa' || task.kind === 'review')) {
        // Deterministic failures are facts; a model cannot approve them away.
        review = {
          ...review,
          verdict: 'reject',
          issues: [...hard.slice(0, 20).map((h): Issue => ({ severity: 'critical', area: h.rule, description: `${h.page ? `${h.page}: ` : ''}${h.detail}`, fix: 'Resolve the deterministic check failure.' })), ...review.issues],
        };
        outputs.review = review;
        outputs.verdict_overridden = 'deterministic hard failures present';
      }
      outputs.review = review;
      if (task.kind === 'review' && task.review_target && review.verdict === 'reject') {
        const r = await this.#requestRevision(task, review, outputs, ctx);
        if (r) return r;
      }
      if (task.kind === 'qa' && review.verdict === 'reject') {
        const r = await this.#startFixCycle(task, review, outputs, ctx);
        if (r) return r;
      }
    }

    const done = await this.d.queue.transition(taskId, ['REVIEW'], 'COMPLETED', {
      outputs,
      completed_at: new Date(),
      lease_owner: null,
      lease_expires_at: null,
      error: null,
    }, { type: 'completed', actor: ctx.actor, detail: { files: written.length, confidence: envelope.confidence, verdict: review?.verdict ?? null } });
    await this.#recordStep(ctx, done, 'review', 'COMPLETED');
    await this.afterTerminal(done);
    return { outcome: 'completed', task: summarise(done), detail: { files: written, verdict: review?.verdict ?? null, summary: envelope.summary } };
  }

  async #absorbFacts(task: TaskRow, env: Envelope): Promise<void> {
    const r = env.result ?? {};
    const add: string[] = [];
    if (task.agent_type === 'client_intake' && Array.isArray(r.known_facts)) add.push(...r.known_facts.map(String));
    if (task.agent_type === 'research_coordinator' && Array.isArray(r.verified_facts)) add.push(...r.verified_facts.map((f: any) => (typeof f === 'string' ? f : `${f.fact} (source: ${f.source})`)));
    if (task.agent_type === 'content_research' && Array.isArray(r.notes)) {
      add.push(...r.notes.filter((n: any) => n?.basis === 'verified' && n?.source).map((n: any) => `${n.note} (source: ${n.source})`));
    }
    if (!add.length) return;
    const existing = (await this.d.memory.get<string[]>('project', task.project_id, 'facts')) ?? [];
    const merged = [...new Set([...existing, ...add.map((s) => s.slice(0, 500))])].slice(0, 200);
    await this.d.memory.set('project', task.project_id, 'facts', merged, task.agent_type);
  }

  async #spawnSubtasks(task: TaskRow, env: Envelope, outputs: Record<string, unknown>, ctx: StepContext): Promise<ReviewStepResult> {
    const ids = env.subtasks.map(() => newId('tsk'));
    // Each delegation round gets fresh children; earlier rounds' results are never re-used.
    const round = (task.inputs?.spawn_round ?? 0) + 1;
    const specs: NewTaskSpec[] = env.subtasks.map((s, i) => ({
      id: ids[i],
      plan_key: `${task.plan_key}.sub${i + 1}`,
      agent_type: s.agent_type,
      title: s.title,
      mission: s.mission,
      kind: 'subtask',
      parent_task_id: task.id,
      priority: task.priority + 1,
      dependencies: s.depends_on.filter((j) => j < i).map((j) => ids[j]),
      inputs: s.inputs,
      review_target: getAgent(s.agent_type).reviewer && task.review_target ? task.review_target : null,
      idempotency_key: `${task.id}:round${round}:sub${i}`,
    }));
    const children = await this.d.queue.createTasks(task.project_id, specs, ctx.actor);
    const waiting = await this.d.queue.transition(task.id, ['REVIEW'], 'WAITING', {
      outputs,
      inputs: { ...task.inputs, spawn_round: round, children: children.map((c) => c.id) },
      phase: 'synthesize',
      lease_owner: null,
      lease_expires_at: null,
      attempt: 0,
    }, { type: 'subtasks_spawned', actor: ctx.actor, detail: { subtasks: children.map((c) => ({ id: c.id, agent: c.agent_type, title: c.title })) } });
    await this.#recordStep(ctx, waiting, 'review', 'WAITING');
    await this.d.queue.reconcile(task.project_id, ctx.actor);
    return { outcome: 'waiting_on_subtasks', task: summarise(waiting), detail: { subtasks: children.map((c) => ({ task_id: c.id, agent_type: c.agent_type, title: c.title })) } };
  }

  async #requestRevision(task: TaskRow, review: NonNullable<Envelope['review']>, outputs: Record<string, unknown>, ctx: StepContext): Promise<ReviewStepResult | null> {
    const target = await this.d.queue.get(task.review_target!);
    if (target.status !== 'COMPLETED' || target.revision >= target.max_revisions) return null;
    const feedback = {
      from: task.agent_type,
      review_task: task.id,
      round: target.revision + 1,
      issues: review.issues.filter((i) => i.severity !== 'minor').slice(0, 25),
      instructions: review.revision_instructions ?? null,
    };
    const inputs = { ...target.inputs, revision_feedback: [...(target.inputs.revision_feedback ?? []), feedback] };
    await this.d.queue.transition(target.id, ['COMPLETED'], 'QUEUED', { inputs, revision: target.revision + 1, attempt: 0, completed_at: null }, {
      type: 'revision_requested',
      actor: `agent:${task.agent_type}`,
      detail: { reviewer_task: task.id, round: feedback.round, issues: feedback.issues.length },
    });
    // Reviewer waits for the revised work, then reviews again.
    // Back to execute phase: the revised work gets a full fresh review (and fresh sub-agents if needed).
    const waiting = await this.d.queue.transition(task.id, ['REVIEW'], 'WAITING', { outputs, phase: 'execute', lease_owner: null, lease_expires_at: null, attempt: 0 }, {
      type: 'awaiting_revision',
      actor: ctx.actor,
      detail: { target: target.id, round: feedback.round },
    });
    // Agent memory: remember what gets this agent's work rejected.
    for (const issue of feedback.issues.slice(0, 3)) {
      await this.d.memory.append('agent', target.agent_type, 'lessons', `${issue.area}: ${issue.description}`.slice(0, 240), `review:${task.agent_type}`);
    }
    await this.#recordStep(ctx, waiting, 'review', 'WAITING');
    await this.d.queue.reconcile(task.project_id, ctx.actor);
    return { outcome: 'revision_requested', task: summarise(waiting), detail: { target: target.id, round: feedback.round, issues: feedback.issues } };
  }

  async #startFixCycle(task: TaskRow, review: NonNullable<Envelope['review']>, outputs: Record<string, unknown>, ctx: StepContext): Promise<ReviewStepResult | null> {
    const project = await this.d.projects.get(task.project_id);
    if (project.fix_cycles >= this.d.config.maxFixCycles) return null;
    const cycle = project.fix_cycles + 1;
    await this.d.projects.update(project.id, { fix_cycles: cycle });
    const issues = review.issues.filter((i) => i.severity !== 'minor').slice(0, 30);
    const [fix] = await this.d.queue.createTasks(task.project_id, [{
      plan_key: `fix_cycle_${cycle}`,
      agent_type: 'website_debugger',
      title: `Fix QA findings (cycle ${cycle})`,
      mission: `Fix every issue reported by ${getAgent(task.agent_type).name}. Keep all other content and design intact.`,
      kind: 'fix',
      priority: 90,
      inputs: { issues, instructions: review.revision_instructions ?? null, qa_task: task.id },
      idempotency_key: `${task.id}:fix:${cycle}`,
    }], ctx.actor);
    const waiting = await this.d.queue.transition(task.id, ['REVIEW'], 'WAITING', {
      outputs,
      dependencies: [...task.dependencies, fix.id],
      phase: 'execute',
      lease_owner: null,
      lease_expires_at: null,
      attempt: 0,
    }, { type: 'fix_cycle_started', actor: ctx.actor, detail: { cycle, fix_task: fix.id, issues: issues.length } });
    await this.#recordStep(ctx, waiting, 'review', 'WAITING');
    await this.d.queue.reconcile(task.project_id, ctx.actor);
    return { outcome: 'fix_cycle_started', task: summarise(waiting), detail: { cycle, fix_task: fix.id, issues } };
  }

  // -------------------------------------------------------- FAILURE PATH
  /** RETRY: applies the Failure Manager's decision to a failed attempt. */
  async fail(taskId: string, err: { errorClass: ErrorClass | string; message: string; retryAfterMs?: number | null }, ctx: StepContext): Promise<ReviewStepResult> {
    const task = await this.d.queue.get(taskId);
    if (!WORKER_STATUSES.includes(task.status)) {
      return { outcome: 'failed', task: summarise(task), detail: { ignored: `task is ${task.status}` } };
    }
    const agent = getAgent(task.agent_type);
    const alternatives = this.d.provider.router
      .candidates({ capability: (task.capability ?? agent.capability) as Capability, vision: agent.capability === 'vision' })
      .map((m) => m.id);
    const errorClass = err.errorClass as ErrorClass;
    const decision = decideFailure({
      errorClass,
      attempt: task.attempt,
      maxAttempts: task.max_attempts,
      capacityWaits: task.capacity_waits,
      optional: task.optional,
      currentModel: task.assigned_model,
      alternativeModels: alternatives,
      rescued: !!task.inputs?.rescued,
      retryAfterMs: err.retryAfterMs ?? null,
    });
    const error = { class: errorClass, message: err.message.slice(0, 1500), attempt: task.attempt, model: task.assigned_model, key: task.assigned_key, decision: decision.action, at: new Date().toISOString() };
    const eventDetail = { error, decision };
    const inputs = { ...task.inputs };
    if (errorClass === 'malformed_output' || errorClass === 'validation_error') inputs.previous_attempt_error = err.message.slice(0, 1500);
    let updated: TaskRow;
    switch (decision.action) {
      case 'retry':
      case 'retry_backoff':
      case 'retry_other_key':
      case 'switch_model':
      case 'rescue': {
        if (decision.action === 'rescue') inputs.rescued = true;
        updated = await this.d.queue.transition(taskId, WORKER_STATUSES, 'RETRYING', {
          error,
          inputs,
          not_before: new Date(Date.now() + decision.delayMs),
          attempt: decision.resetAttempts ? 0 : decision.refundAttempt ? Math.max(0, task.attempt - 1) : task.attempt,
          capacity_waits: decision.action === 'retry_other_key' ? task.capacity_waits + 1 : task.capacity_waits,
          model_override: decision.nextModel ?? task.model_override,
          lease_owner: null,
          lease_expires_at: null,
        }, { type: `retry_scheduled:${decision.action}`, actor: 'failure_manager', detail: eventDetail });
        await this.#recordStep(ctx, updated, 'failure', 'RETRYING');
        log.warn('task attempt failed; retry scheduled', { task: taskId, agent: task.agent_type, error_class: errorClass, action: decision.action, delay_ms: decision.delayMs });
        return { outcome: 'retry', task: summarise(updated), decision, detail: { error } };
      }
      case 'fail_optional':
      case 'escalate': {
        updated = await this.d.queue.transition(taskId, WORKER_STATUSES, 'FAILED', { error, inputs, completed_at: new Date(), lease_owner: null, lease_expires_at: null }, {
          type: decision.action === 'escalate' ? 'failed_escalated' : 'failed_optional',
          actor: 'failure_manager',
          detail: eventDetail,
        });
        await this.d.queue.deadLetter(updated, decision.reason, error);
        await this.#recordStep(ctx, updated, 'failure', 'FAILED');
        log.error('task failed', { task: taskId, agent: task.agent_type, error_class: errorClass, action: decision.action, reason: decision.reason });
        await this.afterTerminal(updated);
        return { outcome: decision.action === 'escalate' ? 'escalated' : 'failed', task: summarise(updated), decision, detail: { error } };
      }
      default:
        return { outcome: 'failed', task: summarise(task), decision };
    }
  }

  /** After any terminal transition: re-evaluate the graph and notify listeners. */
  async afterTerminal(task: TaskRow): Promise<void> {
    await this.d.queue.reconcile(task.project_id, 'executor');
    this.d.queue.emit('task_terminal', { task });
  }

  async #requireRunning(taskId: string): Promise<TaskRow> {
    const task = await this.d.queue.get(taskId);
    if (task.status !== 'RUNNING') throw new AppError('not_running', `Task ${taskId} is ${task.status}, expected RUNNING`, 409);
    return task;
  }

  /** Full execution of one claimed task (internal driver). Mirrors the n8n pipeline node-for-node. */
  async runClaimed(task: TaskRow, ctx: StepContext, signal?: AbortSignal): Promise<ReviewStepResult> {
    try {
      await this.start(task.id, ctx);
    } catch (err) {
      if (err instanceof AppError && err.code === 'project_paused') return { outcome: 'retry', task: summarise(task) };
      throw err;
    }
    try {
      await this.runTools(task.id, ctx);
      await this.selectModel(task.id, ctx);
      await this.buildContext(task.id, ctx);
      const lease = await this.lease(task.id, ctx, { wait: true, signal });
      if (!lease.granted) throw new Error('unreachable: blocking lease returned without grant');
      const inv = await this.invoke(task.id, lease.lease_id, ctx, signal);
      if (!inv.ok) return await this.fail(task.id, { errorClass: inv.error_class, message: inv.message, retryAfterMs: inv.retry_after_ms }, ctx);
      return await this.review(task.id, ctx);
    } catch (err) {
      const code = (err as any)?.code as string | undefined;
      const current = await this.d.queue.find(task.id);
      if (!current || !WORKER_STATUSES.includes(current.status)) {
        return { outcome: 'failed', task: summarise(current ?? task), detail: { note: 'task left worker states during execution', error: errorMessage(err) } };
      }
      const errorClass: ErrorClass =
        code === 'capacity_timeout' ? 'capacity_timeout' :
        code === 'no_compatible_key' || code === 'no_keys' ? 'no_keys' :
        code === 'model_unavailable' ? 'model_unavailable' :
        signal?.aborted ? 'cancelled' : 'internal_error';
      if (errorClass === 'cancelled') return { outcome: 'failed', task: summarise(current) };
      return this.fail(task.id, { errorClass, message: errorMessage(err) }, ctx);
    }
  }

  /** Reaper: tasks whose execution lease expired are treated as timed-out attempts. */
  async reapExpired(actor: string): Promise<number> {
    const expired = await this.d.queue.expiredLeases();
    for (const t of expired) {
      try {
        await this.fail(t.id, { errorClass: 'lease_expired', message: `execution lease expired while ${t.status}` }, { actor });
      } catch (err) {
        log.warn('reap failed', { task: t.id, error: errorMessage(err) });
      }
    }
    return expired.length;
  }
}
