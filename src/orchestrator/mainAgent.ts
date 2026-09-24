// The ApexWeb Main Agent: the one agent the user talks to. It interprets the
// request, plans a dependency-aware task graph over the specialist registry,
// hands it to the queue, watches progress, escalates problems, assembles the
// final package and reports back. It never does specialist work itself.
import { execFile } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { z } from 'zod';
import { AGENTS, getAgent, SPECIALISTS } from '../agents/registry.ts';
import { extractJsonObject } from '../agents/output.ts';
import type { AppConfig } from '../config/env.ts';
import type { Db } from '../db/pool.ts';
import type { ArtifactStore } from '../memory/artifacts.ts';
import type { MemoryStore } from '../memory/memory.ts';
import { ProviderError, type NvidiaProvider } from '../provider/provider.ts';
import type { ProjectStore } from '../queue/projects.ts';
import type { TaskQueue } from '../queue/taskQueue.ts';
import type { NewTaskSpec, ProjectRow, TaskRow } from '../queue/types.ts';
import { importExistingSite } from '../tools/siteImport.ts';
import { AppError, newId, sha256 } from '../util/common.ts';
import { errorMessage, logger } from '../util/log.ts';
import { PlanSchema, PlanValidationError, parallelLevels, validatePlan } from './planner.ts';
import { TEMPLATES, templateFor, type Intent, type PlanTask } from './templates.ts';

const log = logger('main-agent');
const execFileAsync = promisify(execFile);

const str = z.preprocess((v) => (v == null ? '' : typeof v === 'string' ? v : JSON.stringify(v)), z.string());
const strArr = z.preprocess((v) => (Array.isArray(v) ? v.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))) : v == null ? [] : [String(v)]), z.array(z.string()));
const nullableStr = z.preprocess((v) => (v === '' || v === 'null' ? null : v), z.string().nullable().default(null));

export const InterpretationSchema = z.object({
  intent: z.enum(['new_website', 'website_improvement', 'new_demo', 'seo_audit', 'research_only', 'content_only', 'proposal']),
  project_name: z.string().min(2).max(120),
  summary: str,
  business: z.object({
    name: nullableStr,
    type: z.string().default('unspecified'),
    location: nullableStr,
    existing_url: nullableStr,
  }).default({}),
  audience: nullableStr,
  goals: strArr.default([]),
  constraints: strArr.default([]),
  deliverables: strArr.default([]),
  urls: strArr.default([]),
  known_facts: strArr.default([]),
  needs_clarification: z.boolean().default(false),
  clarification_questions: strArr.default([]),
});
export type Interpretation = z.infer<typeof InterpretationSchema>;

const RouteSchema = z.object({
  route: z.enum(['new_work', 'status', 'question', 'revision', 'control']),
  control_action: z.enum(['pause', 'resume', 'cancel']).nullable().optional(),
});

export interface ExecutionDriver {
  readonly kind: 'internal' | 'n8n';
  onProjectCreated(projectId: string): Promise<void>;
  onProjectSettled(projectId: string): Promise<void>;
}

export interface MainAgentDeps {
  db: Db;
  config: AppConfig;
  queue: TaskQueue;
  projects: ProjectStore;
  provider: NvidiaProvider;
  memory: MemoryStore;
  artifacts: ArtifactStore;
  fetchImpl?: typeof fetch;
}

export type ReceiveResult =
  | { type: 'project_created'; project: ProjectRow; duplicate: boolean; reply: string }
  | { type: 'answer' | 'status' | 'control' | 'revision'; project?: ProjectRow | null; reply: string };

function parseJson<S extends z.ZodTypeAny>(schema: S, text: string): z.output<S> {
  const json = extractJsonObject(text);
  if (!json) throw new Error('response contained no JSON object');
  return schema.parse(JSON.parse(json));
}

export class MainAgent {
  readonly d: MainAgentDeps;
  driver: ExecutionDriver | null = null;
  #settling = new Set<string>();

  constructor(deps: MainAgentDeps) {
    this.d = deps;
    deps.queue.on('task_terminal', ({ task }: { task: TaskRow }) => {
      this.checkSettled(task.project_id).catch((err) => log.error('settle check failed', { project: task.project_id, error: errorMessage(err) }));
    });
  }

  // ------------------------------------------------------------ CHAT
  async receive(input: { message: string; projectId?: string | null; idempotencyKey?: string | null; actor: string }): Promise<ReceiveResult> {
    const message = input.message.trim();
    if (!message) throw new AppError('empty_message', 'Message is empty');
    if (message.length > 20_000) throw new AppError('message_too_long', 'Message exceeds 20,000 characters');
    const project = input.projectId ? await this.d.projects.get(input.projectId) : null;
    await this.d.projects.addMessage(project?.id ?? null, 'user', message);

    const route = await this.#route(message, project);
    if (route.route === 'new_work' && !project) {
      const { project: created, duplicate } = await this.createProject(message, input.idempotencyKey ?? null, input.actor);
      const reply = duplicate
        ? `This request matches project ${created.id} ("${created.name}"), which already exists; I have not started a duplicate.`
        : `Understood. I've opened project ${created.id} and I'm now interpreting the request and planning the work with the specialist team. You can follow every task live.`;
      await this.d.projects.addMessage(created.id, 'main_agent', reply);
      if (!duplicate) await this.driver?.onProjectCreated(created.id);
      return { type: 'project_created', project: created, duplicate, reply };
    }
    if (route.route === 'revision' && project) {
      const reply = await this.startRevision(project.id, message, input.actor);
      return { type: 'revision', project, reply };
    }
    if (route.route === 'control' && project && route.control_action) {
      await this.control(project.id, route.control_action, input.actor);
      const reply = `Project ${project.id} ${route.control_action === 'pause' ? 'paused' : route.control_action === 'resume' ? 'resumed' : 'cancelled'}.`;
      await this.d.projects.addMessage(project.id, 'main_agent', reply);
      return { type: 'control', project, reply };
    }
    if (route.route === 'status' || (route.route === 'new_work' && project)) {
      const reply = await this.statusReport(project?.id ?? null);
      await this.d.projects.addMessage(project?.id ?? null, 'main_agent', reply);
      return { type: 'status', project, reply };
    }
    const answer = await this.d.provider.requestModel({
      capability: 'reasoning',
      maxTokens: 1200,
      temperature: 0.3,
      metadata: { purpose: 'main_agent:answer', projectId: project?.id ?? null, priority: 90 },
      messages: [
        { role: 'system', content: 'You are the ApexWeb Main Agent, coordinator of a team of specialist web agents. Answer the user briefly and concretely. If the question is about a project, rely only on the project facts provided; never invent status.' },
        { role: 'user', content: `${project ? `PROJECT FACTS:\n${await this.statusReport(project.id)}\n\n` : ''}USER: ${message}` },
      ],
    });
    await this.d.projects.addMessage(project?.id ?? null, 'main_agent', answer.content);
    return { type: 'answer', project, reply: answer.content };
  }

  async #route(message: string, project: ProjectRow | null): Promise<z.infer<typeof RouteSchema>> {
    const res = await this.d.provider.requestModel({
      capability: 'classification',
      maxTokens: 120,
      temperature: 0,
      metadata: { purpose: 'main_agent:route', projectId: project?.id ?? null, priority: 95 },
      messages: [
        {
          role: 'system',
          content:
            'Classify the user message for the ApexWeb Main Agent. Reply with JSON only: {"route": "new_work"|"status"|"question"|"revision"|"control", "control_action": "pause"|"resume"|"cancel"|null}. ' +
            'new_work = a request to produce something (website, demo, audit, research, copy, proposal). revision = a change request for the current project. ' +
            'status = asking about progress. control = pause/resume/cancel. question = anything else.',
        },
        { role: 'user', content: `${project ? `Current project: ${project.name} (status ${project.status})\n` : 'No current project.\n'}Message: ${message.slice(0, 4000)}` },
      ],
    });
    try {
      return parseJson(RouteSchema, res.content);
    } catch {
      // A malformed classification is not fatal: treat it as a question so nothing is started by accident.
      return { route: 'question', control_action: null };
    }
  }

  // ------------------------------------------------------- PROJECT LIFECYCLE
  async createProject(request: string, idempotencyKey: string | null, actor: string): Promise<{ project: ProjectRow; duplicate: boolean }> {
    // Duplicate detection: explicit key, else same text within a 10-minute bucket.
    const key = idempotencyKey ?? `auto:${sha256(`${request.trim().toLowerCase()}|${Math.floor(Date.now() / 600_000)}`)}`;
    const { project, duplicate } = await this.d.projects.create({ name: request.slice(0, 80), kind: 'pending', request, idempotencyKey: key, status: 'PLANNING' });
    if (duplicate) return { project, duplicate };
    await this.d.queue.createTasks(project.id, [{
      plan_key: 'root',
      agent_type: 'main_orchestrator',
      title: 'Main Agent: interpret, plan, coordinate, assemble',
      mission: request,
      kind: 'root',
      priority: 100,
      initial_status: 'PLANNING',
      idempotency_key: `${project.id}:root`,
    }], actor);
    await this.d.projects.audit(actor, 'project.create', 'project', project.id, { request: request.slice(0, 500) });
    return { project, duplicate };
  }

  async #root(projectId: string): Promise<TaskRow> {
    const { rows } = await this.d.db.query(`SELECT * FROM tasks WHERE project_id = $1 AND kind = 'root'`, [projectId]);
    if (!rows[0]) throw new AppError('no_root', `Project ${projectId} has no root task`, 500);
    return rows[0];
  }

  /** MAIN — Interpret Request */
  async interpret(projectId: string): Promise<Interpretation> {
    const project = await this.d.projects.get(projectId);
    if (project.interpretation) return project.interpretation as Interpretation;
    const messages = [
      {
        role: 'system' as const,
        content: [
          'You are the ApexWeb Main Agent. Interpret the user request for ApexWeb, a web design agency. Reply with ONE JSON object only:',
          '{"intent": "new_website"|"website_improvement"|"new_demo"|"seo_audit"|"research_only"|"content_only"|"proposal",',
          ' "project_name": short descriptive name, "summary": one paragraph,',
          ' "business": {"name": string|null, "type": string, "location": string|null, "existing_url": string|null},',
          ' "audience": string|null, "goals": [string], "constraints": [string], "deliverables": [string], "urls": [string],',
          ' "known_facts": [facts stated explicitly in the request, verbatim-ish],',
          ' "needs_clarification": boolean, "clarification_questions": [string]}',
          'Rules: new_demo = a speculative/showcase site for a business type or prospect; new_website = a real client build; website_improvement = an existing site must be improved (needs its URL or files).',
          'Only put facts the user actually stated in known_facts. Set needs_clarification=true ONLY if the work cannot responsibly start (e.g. improvement requested but no site URL/files). A demo for an unnamed business can proceed with clearly marked placeholders.',
        ].join('\n'),
      },
      { role: 'user' as const, content: project.request },
    ];
    let interp: Interpretation | null = null;
    let lastErr = '';
    for (let i = 0; i < 2 && !interp; i++) {
      const res = await this.d.provider.requestModel({ capability: 'planning', maxTokens: 1500, temperature: 0.1, metadata: { purpose: 'main_agent:interpret', projectId, priority: 95 }, messages: i === 0 ? messages : [...messages, { role: 'user', content: `Your previous reply was invalid (${lastErr}). Reply with the JSON object only.` }] });
      try {
        interp = parseJson(InterpretationSchema, res.content);
      } catch (err) {
        lastErr = errorMessage(err).slice(0, 300);
      }
    }
    if (!interp) throw new AppError('interpretation_failed', `Main Agent could not interpret the request: ${lastErr}`, 502);
    const urls = [...new Set([...(interp.urls ?? []), interp.business.existing_url].filter((u): u is string => !!u && /^https?:\/\//i.test(u)))];
    await this.d.projects.update(projectId, { interpretation: interp, name: interp.project_name, kind: interp.intent });
    await this.d.memory.set('project', projectId, 'brief', {
      request: project.request,
      intent: interp.intent,
      summary: interp.summary,
      business: interp.business,
      audience: interp.audience,
      goals: interp.goals,
      constraints: interp.constraints,
      deliverables: interp.deliverables,
      urls,
      existing_url: interp.business.existing_url,
    }, 'main_agent');
    if (interp.known_facts.length) await this.d.memory.set('project', projectId, 'facts', interp.known_facts, 'main_agent:request');
    const root = await this.#root(projectId);
    await this.d.queue.recordEvent(this.d.db, root, 'interpreted', root.status, root.status, 'main_agent', { intent: interp.intent, name: interp.project_name });
    if (interp.needs_clarification && interp.clarification_questions.length) {
      await this.d.projects.transition(projectId, ['PLANNING'], 'NEEDS_ATTENTION');
      await this.d.projects.addMessage(projectId, 'main_agent', `Before I start, I need a little more information:\n${interp.clarification_questions.map((q) => `- ${q}`).join('\n')}`, { clarification: interp.clarification_questions });
    }
    return interp;
  }

  /** MAIN — Build Plan (Task Decomposer over the workflow template, validated). */
  async plan(projectId: string): Promise<{ source: string; tasks: PlanTask[]; warnings: string[]; levels: string[][]; rationale: string | null }> {
    const project = await this.d.projects.get(projectId);
    if (project.plan) return project.plan as any;
    const interp = project.interpretation as Interpretation | null;
    if (!interp) throw new AppError('not_interpreted', 'Interpret the request before planning', 409);
    if (project.status === 'NEEDS_ATTENTION') throw new AppError('needs_clarification', 'Project is waiting for clarification from the user', 409);
    const template = templateFor(interp.intent);

    if (interp.intent === 'website_improvement' && interp.business.existing_url) {
      try {
        const imported = await importExistingSite(interp.business.existing_url, {
          projectId, artifacts: this.d.artifacts, timeoutMs: this.d.config.research.fetchTimeoutMs, maxBytes: this.d.config.research.maxFetchBytes, fetchImpl: this.d.fetchImpl,
        });
        await this.d.memory.set('project', projectId, 'baseline', imported, 'main_agent:import');
      } catch (err) {
        await this.d.memory.set('project', projectId, 'baseline', { error: errorMessage(err) }, 'main_agent:import');
      }
    }

    const registry = SPECIALISTS.filter((a) => !['main_orchestrator', 'task_decomposer'].includes(a.type))
      .map((a) => `- ${a.type}${a.reviewer ? ' [reviewer]' : ''}: ${a.mission}`).join('\n');
    const decomposer = getAgent('task_decomposer');
    const baseMessages = [
      {
        role: 'system' as const,
        content: [
          `You are the ${decomposer.name} working for the ApexWeb Main Agent. ${decomposer.mission}`,
          ...decomposer.instructions.map((i) => `- ${i}`),
          'Start from the TEMPLATE task graph. Adapt it to this specific request: tailor every mission to the business and goals, remove optional tasks that add no value, add tasks only when the request needs them (e.g. webgl_specialist only if 3D is genuinely justified).',
          `Required keys that must remain: ${template.required.join(', ')}.`,
          'Use "review_of": "<key>" for reviewer tasks that gate another task (they may reject it), and "qa_gate": true for the final QA task.',
          `REGISTERED SPECIALISTS:\n${registry}`,
          `Reply with JSON only: ${decomposer.resultShape.replace('"optional":boolean}', '"optional":boolean,"review_of":string|null,"qa_gate":boolean}')}`,
        ].join('\n'),
      },
      { role: 'user' as const, content: `INTERPRETED REQUEST:\n${JSON.stringify(interp, null, 1)}\n\nTEMPLATE (${template.label}):\n${JSON.stringify(template.tasks, null, 1)}` },
    ];
    let validated: ReturnType<typeof validatePlan> | null = null;
    let source = 'task_decomposer';
    let rationale: string | null = null;
    let feedback = '';
    for (let i = 0; i < 2 && !validated; i++) {
      try {
        const res = await this.d.provider.requestModel({
          capability: 'planning',
          maxTokens: 6000,
          temperature: 0.2,
          metadata: { purpose: 'main_agent:plan', projectId, priority: 95 },
          messages: feedback ? [...baseMessages, { role: 'user', content: `Your plan was invalid: ${feedback}. Return a corrected JSON plan.` }] : baseMessages,
        });
        const proposed = parseJson(PlanSchema, res.content);
        rationale = proposed.rationale ?? null;
        validated = validatePlan(proposed.tasks as PlanTask[], template);
      } catch (err) {
        // Provider failures abort planning (surfaced to the user); only invalid plans are retried.
        if (err instanceof ProviderError || err instanceof AppError) throw err;
        feedback = err instanceof PlanValidationError ? err.errors.join('; ') : errorMessage(err).slice(0, 400);
      }
    }
    if (!validated) {
      // The decomposer's output failed validation twice: fall back to the documented template graph (recorded as such).
      validated = validatePlan(template.tasks.map((t) => ({ ...t, depends_on: [...t.depends_on] })), template);
      source = 'template_fallback';
      validated.warnings.push(`Task Decomposer output rejected twice (${feedback}); using the ${template.label} template graph.`);
    }
    const plan = { source, tasks: validated.tasks, warnings: validated.warnings, levels: parallelLevels(validated.tasks), rationale };
    await this.d.projects.update(projectId, { plan });
    const root = await this.#root(projectId);
    await this.d.queue.recordEvent(this.d.db, root, 'planned', root.status, root.status, 'main_agent', { source, tasks: plan.tasks.length, levels: plan.levels.length, warnings: plan.warnings });
    return plan;
  }

  /** QUEUE — Enqueue Task Graph */
  async enqueue(projectId: string, actor = 'main_agent'): Promise<TaskRow[]> {
    const project = await this.d.projects.get(projectId);
    const plan = project.plan as { tasks: PlanTask[] } | null;
    if (!plan) throw new AppError('not_planned', 'Build the plan before enqueueing', 409);
    const ids = new Map(plan.tasks.map((t) => [t.key, newId('tsk')]));
    const specs: NewTaskSpec[] = plan.tasks.map((t) => ({
      id: ids.get(t.key),
      plan_key: t.key,
      agent_type: t.agent_type,
      title: t.title,
      mission: t.mission,
      kind: t.review_of ? 'review' : t.qa_gate ? 'qa' : 'work',
      priority: t.priority,
      optional: !!t.optional,
      dependencies: t.depends_on.map((d) => ids.get(d)!),
      review_target: t.review_of ? ids.get(t.review_of)! : null,
      idempotency_key: `${projectId}:plan:${t.key}`,
    }));
    const root = await this.#root(projectId);
    const tasks = await this.d.queue.createTasks(projectId, specs, actor);
    if (root.status === 'PLANNING') await this.d.queue.transition(root.id, ['PLANNING'], 'WAITING', {}, { type: 'graph_enqueued', actor, detail: { tasks: tasks.length } });
    await this.d.projects.transition(projectId, ['PLANNING'], 'RUNNING');
    const levels = (project.plan as any).levels as string[][];
    const specialists = [...new Set(plan.tasks.map((t) => getAgent(t.agent_type).name))];
    await this.d.projects.addMessage(projectId, 'main_agent',
      `Plan ready: ${tasks.length} tasks across ${levels.length} dependency levels (up to ${Math.max(...levels.map((l) => l.length))} running in parallel), delegated to ${specialists.length} specialists: ${specialists.join(', ')}. Work has started.`,
      { plan_source: (project.plan as any).source, warnings: (project.plan as any).warnings });
    await this.d.queue.reconcile(projectId, actor);
    this.d.queue.emit('tasks_ready', { projectId });
    return tasks;
  }

  /** Internal driver: interpret -> plan -> enqueue (n8n drives the same three steps node by node). */
  async planProject(projectId: string): Promise<void> {
    try {
      const interp = await this.interpret(projectId);
      const project = await this.d.projects.get(projectId);
      if (project.status === 'NEEDS_ATTENTION' || interp.needs_clarification) return;
      await this.plan(projectId);
      await this.enqueue(projectId);
    } catch (err) {
      log.error('planning failed', { project: projectId, error: errorMessage(err) });
      await this.d.projects.transition(projectId, ['PLANNING'], 'NEEDS_ATTENTION');
      await this.d.projects.addMessage(projectId, 'main_agent', `I could not plan this project: ${errorMessage(err)}. You can retry planning once the issue is resolved.`, { error: errorMessage(err) });
    }
  }

  /** User answered clarification questions: fold the answer into the request and re-plan. */
  async clarify(projectId: string, answer: string, actor: string): Promise<void> {
    const project = await this.d.projects.get(projectId);
    if (project.status !== 'NEEDS_ATTENTION' || project.plan) throw new AppError('not_awaiting_clarification', 'Project is not waiting for clarification', 409);
    await this.d.db.query(`UPDATE projects SET request = request || $2, interpretation = NULL, status = 'PLANNING', updated_at = now() WHERE id = $1`, [projectId, `\n\nClarification from user: ${answer}`]);
    await this.d.projects.addMessage(projectId, 'user', answer);
    await this.d.projects.audit(actor, 'project.clarify', 'project', projectId);
    await this.driver?.onProjectCreated(projectId);
  }

  // ------------------------------------------------------------ SETTLEMENT
  async checkSettled(projectId: string): Promise<void> {
    if (this.#settling.has(projectId)) return;
    const project = await this.d.projects.get(projectId);
    if (project.status !== 'RUNNING') return;
    const progress = await this.d.queue.projectProgress(projectId);
    if (progress.active > 0) return;
    this.#settling.add(projectId);
    try {
      if (progress.problems > 0) {
        const { rows } = await this.d.db.query(
          `SELECT id, agent_type, title, status, error FROM tasks WHERE project_id = $1 AND kind <> 'root' AND status IN ('FAILED', 'BLOCKED', 'CANCELLED') AND NOT optional ORDER BY created_at`,
          [projectId],
        );
        const moved = await this.d.projects.transition(projectId, ['RUNNING'], 'NEEDS_ATTENTION');
        if (moved) {
          const lines = rows.map((r) => `- ${getAgent(r.agent_type).name} — ${r.title}: ${r.status}${r.error?.message ? ` (${String(r.error.message).slice(0, 160)})` : ''} [${r.id}]`);
          await this.d.projects.addMessage(projectId, 'main_agent',
            `I need your input. ${rows.length} required task(s) could not complete after automatic retries, model switching and a rescue attempt:\n${lines.join('\n')}\n\nOptions: retry a task, reassign it to another agent or model, override its result, or cancel the project.`,
            { escalation: rows.map((r) => r.id) });
        }
        return;
      }
      await this.driver?.onProjectSettled(projectId);
    } finally {
      this.#settling.delete(projectId);
    }
  }

  // --------------------------------------------------------------- ASSEMBLY
  /** Final Assembly: package site + docs + reports and write the completion report. */
  async assemble(projectId: string, actor = 'main_agent'): Promise<Record<string, unknown>> {
    let project = await this.d.projects.get(projectId);
    if (project.status === 'COMPLETED' || project.status === 'APPROVED') return project.final_report ?? {};
    const moved = await this.d.projects.transition(projectId, ['RUNNING'], 'ASSEMBLING');
    if (!moved && project.status !== 'ASSEMBLING') throw new AppError('not_ready', `Project is ${project.status}; cannot assemble`, 409);
    project = await this.d.projects.get(projectId);
    const tasks = await this.d.queue.listByProject(projectId);
    const work = tasks.filter((t) => t.kind !== 'root');
    const pkgDir = path.join(this.d.config.dataDir, 'projects', projectId, 'package');
    const siteFiles = await this.d.artifacts.materialise(projectId, 'site/', path.join(pkgDir, 'site'));
    const docFiles = await this.d.artifacts.materialise(projectId, 'docs/', path.join(pkgDir, 'docs'));

    const qaTasks = work.filter((t) => t.kind === 'qa').sort((a, b) => +new Date(b.updated_at) - +new Date(a.updated_at));
    const qa = qaTasks[0];
    const qaReview = qa?.outputs?.review ?? null;
    const agentsUsed = new Map<string, { agent_type: string; name: string; tasks: number }>();
    for (const t of work.filter((t) => t.status === 'COMPLETED')) {
      const a = getAgent(t.agent_type);
      const e = agentsUsed.get(a.type) ?? { agent_type: a.type, name: a.name, tasks: 0 };
      e.tasks++;
      agentsUsed.set(a.type, e);
    }
    const unresolved = [...new Set(work.flatMap((t) => (t.outputs?.unresolved_issues ?? []) as string[]))].slice(0, 40);
    const failed = work.filter((t) => ['FAILED', 'BLOCKED', 'CANCELLED'].includes(t.status)).map((t) => ({ task: t.id, title: t.title, status: t.status, optional: t.optional, error: t.error?.message ?? null }));
    const placeholders = siteFiles.length ? (await this.d.artifacts.latestText(projectId, 'site/')) : {};
    const placeholderList = [...new Set(Object.values(placeholders).flatMap((c) => c.match(/\[\[PLACEHOLDER:[^\]]*\]\]/g) ?? []))];
    const { rows: usage } = await this.d.db.query(
      `SELECT key_id, count(*)::int AS requests, count(*) FILTER (WHERE r.status = 'ok')::int AS ok, round(avg(latency_ms) FILTER (WHERE r.status = 'ok'))::int AS avg_latency_ms
       FROM key_requests r WHERE r.task_id IN (SELECT id FROM tasks WHERE project_id = $1) GROUP BY key_id ORDER BY key_id`,
      [projectId],
    );
    const revisions = work.reduce((n, t) => n + t.revision, 0);

    const facts = {
      project: { id: project.id, name: project.name, intent: project.kind, request: project.request },
      tasks: { total: work.length, completed: work.filter((t) => t.status === 'COMPLETED').length, failed },
      agents_used: [...agentsUsed.values()],
      outputs: { site_files: siteFiles, docs: docFiles },
      qa: { task: qa?.id ?? null, verdict: qaReview?.verdict ?? null, score: qaReview?.score ?? null, passed: qaReview?.verdict === 'approve', remaining_issues: qaReview?.issues ?? [], fix_cycles: project.fix_cycles },
      revisions,
      unresolved_issues: unresolved,
      placeholders: placeholderList,
      nvidia_usage: usage,
    };
    let narrative: { completed: string; issues_summary: string; recommended_next_step: string | null } | null = null;
    try {
      const res = await this.d.provider.requestModel({
        capability: 'summarization',
        maxTokens: 1200,
        temperature: 0.2,
        metadata: { purpose: 'main_agent:report', projectId, priority: 95 },
        messages: [
          { role: 'system', content: 'You are the ApexWeb Main Agent writing the completion report for the user. Use ONLY the facts provided. Be concise and specific. Reply with JSON: {"completed": "what was accomplished (3-6 sentences)", "issues_summary": "what remains unresolved, or \'None\'", "recommended_next_step": string|null}. No hidden reasoning.' },
          { role: 'user', content: JSON.stringify({ ...facts, task_summaries: work.filter((t) => t.outputs?.summary).map((t) => ({ agent: t.agent_type, title: t.title, summary: String(t.outputs!.summary).slice(0, 400) })) }).slice(0, 60_000) },
        ],
      });
      narrative = parseJson(z.object({ completed: z.string(), issues_summary: z.string(), recommended_next_step: z.string().nullable().default(null) }), res.content);
    } catch (err) {
      log.warn('report narrative failed; using structured report only', { project: projectId, error: errorMessage(err) });
    }
    const report = {
      completed: narrative?.completed ?? `Completed ${facts.tasks.completed} of ${facts.tasks.total} tasks. (Narrative summary unavailable: the summarisation call failed; all figures below come directly from task records.)`,
      agents_used: facts.agents_used,
      outputs: facts.outputs,
      issues: { summary: narrative?.issues_summary ?? (unresolved.length || failed.length ? 'See the lists below.' : 'None'), unresolved: unresolved, failed_tasks: failed, placeholders: placeholderList },
      qa: facts.qa,
      files: { package_dir: pkgDir, archive: null as string | null, site: siteFiles.map((f) => `site/${f}`), docs: docFiles.map((f) => `docs/${f}`) },
      recommended_next_step: narrative?.recommended_next_step ?? null,
      nvidia_usage: usage,
      revisions,
      generated_at: new Date().toISOString(),
    };
    mkdirSync(path.join(pkgDir, 'reports'), { recursive: true });
    writeFileSync(path.join(pkgDir, 'reports', 'completion-report.json'), JSON.stringify(report, null, 2));
    writeFileSync(path.join(pkgDir, 'reports', 'task-log.json'), JSON.stringify(work.map((t) => ({ id: t.id, key: t.plan_key, agent: t.agent_type, title: t.title, status: t.status, attempts: t.attempt, revision: t.revision, model: t.assigned_model, nvidia_key: t.assigned_key, summary: t.outputs?.summary ?? null, review: t.outputs?.review ?? null, error: t.error })), null, 2));
    writeFileSync(path.join(pkgDir, 'REPORT.md'), renderReportMarkdown(project, report));
    try {
      const archive = path.join(this.d.config.dataDir, 'projects', projectId, `${projectId}-package.tar.gz`);
      await execFileAsync('tar', ['-czf', archive, '-C', pkgDir, '.']);
      report.files.archive = archive;
    } catch (err) {
      log.warn('tar unavailable; package left as directory', { error: errorMessage(err) });
    }
    await this.d.projects.update(projectId, { final_report: report, status: 'COMPLETED', completed_at: new Date() });
    const root = await this.#root(projectId);
    if (root.status === 'WAITING') await this.d.queue.transition(root.id, ['WAITING'], 'COMPLETED', { outputs: report, completed_at: new Date() }, { type: 'assembled', actor });
    await this.d.projects.addMessage(projectId, 'main_agent', renderReportMarkdown(project, report), { report: true });
    await this.d.projects.audit(actor, 'project.assembled', 'project', projectId, { qa_passed: facts.qa.passed });
    return report;
  }

  // ------------------------------------------------------------ CONTROLS
  async control(projectId: string, action: 'pause' | 'resume' | 'cancel', actor: string): Promise<ProjectRow> {
    await this.d.projects.audit(actor, `project.${action}`, 'project', projectId);
    if (action === 'pause') {
      const p = await this.d.projects.update(projectId, { paused: true });
      await this.d.projects.addMessage(projectId, 'system', 'Project paused: running steps finish their current call; nothing new is dispatched.');
      return p;
    }
    if (action === 'resume') {
      const p = await this.d.projects.update(projectId, { paused: false });
      await this.d.queue.reconcile(projectId, actor);
      this.d.queue.emit('tasks_ready', { projectId });
      await this.checkSettled(projectId);
      return p;
    }
    const { rows } = await this.d.db.query(
      `SELECT id, status FROM tasks WHERE project_id = $1 AND status NOT IN ('COMPLETED', 'FAILED', 'CANCELLED')`,
      [projectId],
    );
    for (const r of rows) {
      await this.d.queue.transition(r.id, [r.status], 'CANCELLED', { completed_at: new Date(), lease_owner: null, lease_expires_at: null }, { type: 'cancelled', actor }).catch(() => undefined);
      this.d.queue.emit('task_cancelled', { taskId: r.id });
    }
    await this.d.db.query(`UPDATE projects SET status = 'CANCELLED', paused = false, completed_at = now(), updated_at = now() WHERE id = $1`, [projectId]);
    return this.d.projects.get(projectId);
  }

  async approve(projectId: string, actor: string): Promise<ProjectRow> {
    const p = await this.d.projects.get(projectId);
    if (p.status !== 'COMPLETED') throw new AppError('not_completed', `Only a COMPLETED project can be approved (status ${p.status})`, 409);
    await this.d.projects.audit(actor, 'project.approve', 'project', projectId);
    await this.d.projects.update(projectId, { approved_at: new Date(), approved_by: actor });
    return (await this.d.projects.transition(projectId, ['COMPLETED'], 'APPROVED'))!;
  }

  /** Revision Manager: converts a change request into tasks on the existing project. */
  async startRevision(projectId: string, message: string, actor: string): Promise<string> {
    const project = await this.d.projects.get(projectId);
    if (!['COMPLETED', 'APPROVED', 'NEEDS_ATTENTION', 'RUNNING'].includes(project.status)) {
      throw new AppError('not_revisable', `Project is ${project.status}; revisions can be requested once it has run`, 409);
    }
    const n = (await this.d.db.query(`SELECT count(*)::int AS n FROM tasks WHERE project_id = $1 AND agent_type = 'revision_manager'`, [projectId])).rows[0].n + 1;
    await this.d.queue.createTasks(projectId, [{
      plan_key: `revision_${n}`,
      agent_type: 'revision_manager',
      title: `Change request #${n}`,
      mission: `Convert this client change request into precise subtasks for the right specialists (include a final_qa_release verification subtask that depends on the changes): "${message.slice(0, 3000)}"`,
      priority: 90,
      idempotency_key: `${projectId}:revision:${sha256(message).slice(0, 16)}`,
    }], actor);
    await this.d.db.query(`UPDATE projects SET status = 'RUNNING', final_report = NULL, completed_at = NULL, approved_at = NULL, updated_at = now() WHERE id = $1`, [projectId]);
    const root = await this.#root(projectId);
    if (root.status === 'COMPLETED') await this.d.queue.transition(root.id, ['COMPLETED'], 'WAITING', {}, { type: 'revision_started', actor });
    this.d.queue.emit('tasks_ready', { projectId });
    const reply = `Change request #${n} recorded. The Revision Manager is turning it into tasks; everything you did not ask to change is preserved.`;
    await this.d.projects.addMessage(projectId, 'main_agent', reply);
    return reply;
  }

  async statusReport(projectId: string | null): Promise<string> {
    if (!projectId) {
      const projects = await this.d.projects.list(10);
      if (!projects.length) return 'No projects yet.';
      const lines = [];
      for (const p of projects) {
        const pr = await this.d.queue.projectProgress(p.id);
        lines.push(`- ${p.name} [${p.id}]: ${p.status}${p.paused ? ' (paused)' : ''}, ${pr.completed}/${pr.total} tasks complete`);
      }
      return `Projects:\n${lines.join('\n')}`;
    }
    const p = await this.d.projects.get(projectId);
    const pr = await this.d.queue.projectProgress(projectId);
    const { rows } = await this.d.db.query(
      `SELECT agent_type, title, status FROM tasks WHERE project_id = $1 AND kind <> 'root' AND status IN ('RUNNING', 'ASSIGNED', 'REVIEW', 'RETRYING', 'FAILED', 'BLOCKED') ORDER BY updated_at DESC LIMIT 12`,
      [projectId],
    );
    return [
      `${p.name} [${p.id}] is ${p.status}${p.paused ? ' (paused)' : ''}: ${pr.completed}/${pr.total} tasks complete, ${pr.active} active, ${pr.problems} need attention.`,
      ...rows.map((r) => `- ${getAgent(r.agent_type).name}: ${r.title} — ${r.status}`),
    ].join('\n');
  }
}

export function renderReportMarkdown(project: ProjectRow, r: any): string {
  const list = (xs: string[]) => (xs.length ? xs.map((x) => `- ${x}`).join('\n') : '- None');
  return [
    `# ${project.name}: completion report`,
    '',
    '## Completed',
    r.completed,
    '',
    '## Agents Used',
    list(r.agents_used.map((a: any) => `${a.name} (${a.tasks} task${a.tasks === 1 ? '' : 's'})`)),
    '',
    '## Outputs',
    list([...r.outputs.site_files.map((f: string) => `site/${f}`), ...r.outputs.docs.map((f: string) => `docs/${f}`)]),
    '',
    '## Issues',
    r.issues.summary,
    ...(r.issues.failed_tasks.length ? ['', 'Tasks that did not complete:', list(r.issues.failed_tasks.map((f: any) => `${f.title}: ${f.status}${f.optional ? ' (optional)' : ''}`))] : []),
    ...(r.issues.placeholders.length ? ['', 'Placeholders the client must supply:', list(r.issues.placeholders)] : []),
    ...(r.issues.unresolved.length ? ['', 'Unresolved notes from specialists:', list(r.issues.unresolved.slice(0, 15))] : []),
    '',
    '## QA',
    r.qa.verdict ? `Final QA ${r.qa.passed ? 'PASSED' : 'DID NOT PASS'} (verdict: ${r.qa.verdict}${r.qa.score != null ? `, score ${r.qa.score}/10` : ''}; fix cycles used: ${r.qa.fix_cycles}).` : 'No final QA gate ran for this workflow.',
    ...(r.qa.remaining_issues?.length ? ['Remaining QA issues:', list(r.qa.remaining_issues.map((i: any) => `[${i.severity}] ${i.description}`))] : []),
    '',
    '## Files',
    `Package directory: ${r.files.package_dir}`,
    ...(r.files.archive ? [`Archive: ${r.files.archive}`] : []),
    ...(r.recommended_next_step ? ['', '## Recommended Next Step', r.recommended_next_step] : []),
    '',
  ].join('\n');
}

export { TEMPLATES, AGENTS };
export type { Intent };
