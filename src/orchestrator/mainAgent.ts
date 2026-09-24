// The ApexWeb Main Agent: the central intelligence of the agency OS and the
// one agent the user talks to. It interprets requests, writes the project
// blueprint, selects the skill chain, plans a dependency-aware task graph over
// the specialist registry (adapting a workflow template), applies the
// project's mode and approval gates, supervises execution, triages reviews,
// assembles the package with a scorecard and retrospective, and reports back.
// It never does specialist work itself.
import { execFile } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { z } from 'zod';
import { AGENTS, getAgent, specialists } from '../agents/registry.ts';
import { extractJsonObject } from '../agents/output.ts';
import type { AppConfig } from '../config/env.ts';
import type { Db } from '../db/pool.ts';
import type { ProjectRepos } from '../devops/git.ts';
import type { KnowledgeBase } from '../knowledge/kb.ts';
import type { ArtifactStore } from '../memory/artifacts.ts';
import type { MemoryStore } from '../memory/memory.ts';
import { ProviderError, type NvidiaProvider } from '../provider/provider.ts';
import { computeScorecard } from '../quality/scorecard.ts';
import type { ProjectStore } from '../queue/projects.ts';
import type { TaskQueue } from '../queue/taskQueue.ts';
import type { NewTaskSpec, ProjectRow, TaskRow } from '../queue/types.ts';
import type { SearchProvider } from '../research/search.ts';
import type { SkillEngine, ChainEntry } from '../skills/engine.ts';
import { importExistingSite } from '../tools/siteImport.ts';
import { AppError, newId, sha256 } from '../util/common.ts';
import { errorMessage, logger } from '../util/log.ts';
import { activeGates, Approvals, MODES, type Gate, type Mode } from './approvals.ts';
import { BLUEPRINT_PROMPT, BlueprintSchema, type Blueprint } from './blueprint.ts';
import type { LifecycleTracker } from './lifecycle.ts';
import { applyGates, PlanSchema, PlanValidationError, parallelLevels, validatePlan } from './planner.ts';
import { runRetrospective } from './retrospective.ts';
import { INTENTS, templateFor, templates, type PlanTask } from './templates.ts';

const log = logger('main-agent');
const execFileAsync = promisify(execFile);

const str = z.preprocess((v) => (v == null ? '' : typeof v === 'string' ? v : JSON.stringify(v)), z.string());
const strArr = z.preprocess((v) => (Array.isArray(v) ? v.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))) : v == null ? [] : [String(v)]), z.array(z.string()));
const nullableStr = z.preprocess((v) => (v === '' || v === 'null' ? null : v), z.string().nullable().default(null));

export const InterpretationSchema = z.object({
  intent: z.enum(INTENTS),
  project_name: z.string().min(2).max(120),
  summary: str,
  complexity: z.enum(['simple', 'moderate', 'complex']).catch('moderate').default('moderate'),
  business: z.object({ name: nullableStr, type: z.string().default('unspecified'), location: nullableStr, existing_url: nullableStr }).default({}),
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
  skills: SkillEngine;
  approvals: Approvals;
  lifecycle: LifecycleTracker;
  knowledge: KnowledgeBase;
  repos: ProjectRepos;
  search: SearchProvider;
  defaultMode: Mode;
  fetchImpl?: typeof fetch;
}

export type ReceiveResult =
  | { type: 'project_created'; project: ProjectRow; duplicate: boolean; reply: string }
  | { type: 'answer' | 'status' | 'control' | 'revision' | 'command'; project?: ProjectRow | null; reply: string; data?: unknown };

export function parseJson<S extends z.ZodTypeAny>(schema: S, text: string): z.output<S> {
  const json = extractJsonObject(text);
  if (!json) throw new Error('response contained no JSON object');
  return schema.parse(JSON.parse(json));
}

export class MainAgent {
  readonly d: MainAgentDeps;
  driver: ExecutionDriver | null = null;
  /** Slash-command handler, attached by the commands module. */
  commandHandler: ((input: { message: string; project: ProjectRow | null; actor: string }) => Promise<ReceiveResult | null>) | null = null;
  #settling = new Set<string>();

  constructor(deps: MainAgentDeps) {
    this.d = deps;
    deps.queue.on('task_terminal', ({ task }: { task: TaskRow }) => {
      this.checkSettled(task.project_id).catch((err) => log.error('settle check failed', { project: task.project_id, error: errorMessage(err) }));
    });
    deps.queue.on('approval_needed', ({ projectId, taskId }: { projectId: string; taskId: string }) => {
      this.#openTaskApproval(projectId, taskId).catch((err) => log.error('approval request failed', { task: taskId, error: errorMessage(err) }));
    });
  }

  // ------------------------------------------------------------ CHAT
  async receive(input: { message: string; projectId?: string | null; idempotencyKey?: string | null; actor: string }): Promise<ReceiveResult> {
    const message = input.message.trim();
    if (!message) throw new AppError('empty_message', 'Message is empty');
    if (message.length > 20_000) throw new AppError('message_too_long', 'Message exceeds 20,000 characters');
    const project = input.projectId ? await this.d.projects.get(input.projectId) : null;
    await this.d.projects.addMessage(project?.id ?? null, 'user', message);

    if (message.startsWith('/') && this.commandHandler) {
      const r = await this.commandHandler({ message, project, actor: input.actor });
      if (r) {
        await this.d.projects.addMessage(r.project?.id ?? project?.id ?? null, 'main_agent', r.reply, r.type === 'command' ? { command: message.split(/\s/)[0] } : undefined);
        return r;
      }
    }
    // Answering a clarification request continues planning.
    if (project && project.status === 'NEEDS_ATTENTION' && !project.plan && project.interpretation) {
      await this.clarify(project.id, message, input.actor);
      return { type: 'status', project, reply: 'Thanks - I have added that to the brief and resumed planning.' };
    }
    const route = await this.#route(message, project);
    if (route.route === 'new_work' && !project) {
      return this.startProject(message, input.idempotencyKey ?? null, input.actor);
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
        { role: 'system', content: 'You are the ApexWeb Main Agent, coordinator of a team of specialist web agents. Answer the user briefly and concretely. If the question is about a project, rely only on the project facts provided; never invent status. Commands like /status, /tasks, /review, /qa, /mode are available (/help lists them).' },
        { role: 'user', content: `${project ? `PROJECT FACTS:\n${await this.statusReport(project.id)}\n\n` : ''}USER: ${message}` },
      ],
    });
    await this.d.projects.addMessage(project?.id ?? null, 'main_agent', answer.content);
    return { type: 'answer', project, reply: answer.content };
  }

  async startProject(request: string, idempotencyKey: string | null, actor: string, opts: { intentHint?: string; mode?: Mode; dryRun?: boolean } = {}): Promise<ReceiveResult> {
    const { project, duplicate } = await this.createProject(request, idempotencyKey, actor, opts);
    const reply = duplicate
      ? `This request matches project ${project.id} ("${project.name}"), which already exists; I have not started a duplicate.`
      : `Understood. I've opened project ${project.id} (${project.mode} mode${project.dry_run ? ', dry run' : ''}). I'm interpreting the request, writing the blueprint and choosing the skills and specialists now. You can follow every step live.`;
    await this.d.projects.addMessage(project.id, 'main_agent', reply);
    if (!duplicate) await this.driver?.onProjectCreated(project.id);
    return { type: 'project_created', project, duplicate, reply };
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
            'new_work = a request to produce something (website, demo, audit, research, copy, proposal, fix). revision = a change request for the current project. ' +
            'status = asking about progress. control = pause/resume/cancel. question = anything else.',
        },
        { role: 'user', content: `${project ? `Current project: ${project.name} (status ${project.status})\n` : 'No current project.\n'}Message: ${message.slice(0, 4000)}` },
      ],
    });
    try {
      return parseJson(RouteSchema, res.content);
    } catch {
      return { route: 'question', control_action: null };
    }
  }

  // ------------------------------------------------------- PROJECT LIFECYCLE
  async createProject(request: string, idempotencyKey: string | null, actor: string, opts: { intentHint?: string; mode?: Mode; dryRun?: boolean } = {}): Promise<{ project: ProjectRow; duplicate: boolean }> {
    const key = idempotencyKey ?? `auto:${sha256(`${request.trim().toLowerCase()}|${Math.floor(Date.now() / 600_000)}`)}`;
    const { project, duplicate } = await this.d.projects.create({ name: request.slice(0, 80), kind: 'pending', request, idempotencyKey: key, status: 'PLANNING' });
    if (duplicate) return { project, duplicate };
    const mode = opts.mode ?? this.d.defaultMode;
    await this.d.db.query(`UPDATE projects SET mode = $2, dry_run = $3 WHERE id = $1`, [project.id, mode, opts.dryRun ?? false]);
    if (opts.intentHint) await this.d.memory.set('project', project.id, 'intent_hint', opts.intentHint, actor);
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
    await this.d.projects.audit(actor, 'project.create', 'project', project.id, { request: request.slice(0, 500), mode });
    await this.d.lifecycle.refresh(project.id, 'project created');
    return { project: await this.d.projects.get(project.id), duplicate };
  }

  async #root(projectId: string): Promise<TaskRow> {
    const { rows } = await this.d.db.query(`SELECT * FROM tasks WHERE project_id = $1 AND kind = 'root'`, [projectId]);
    if (!rows[0]) throw new AppError('no_root', `Project ${projectId} has no root task`, 500);
    return rows[0];
  }

  async #rootEvent(projectId: string, type: string, detail: Record<string, unknown>): Promise<void> {
    const root = await this.#root(projectId);
    await this.d.queue.recordEvent(this.d.db, root, type, root.status, root.status, 'main_agent', detail);
  }

  /** MAIN — Interpret Request */
  async interpret(projectId: string): Promise<Interpretation> {
    const project = await this.d.projects.get(projectId);
    if (project.interpretation) return project.interpretation as Interpretation;
    const hint = await this.d.memory.get<string>('project', projectId, 'intent_hint');
    const catalog = templates().map((t) => `${t.intent} = ${t.description}`).join('\n');
    const messages = [
      {
        role: 'system' as const,
        content: [
          'You are the ApexWeb Main Agent. Interpret the user request for ApexWeb, a web design agency. Reply with ONE JSON object only:',
          '{"intent": one of the workflow intents below, "project_name": short descriptive name, "summary": one paragraph, "complexity": "simple"|"moderate"|"complex",',
          ' "business": {"name": string|null, "type": string, "location": string|null, "existing_url": string|null},',
          ' "audience": string|null, "goals": [string], "constraints": [string], "deliverables": [string], "urls": [string],',
          ' "known_facts": [facts stated explicitly in the request], "needs_clarification": boolean, "clarification_questions": [string]}',
          `WORKFLOW INTENTS:\n${catalog}`,
          'Rules: choose the most specific intent (a local service business such as HVAC, plumbing or roofing -> local_business_website unless it is explicitly a demo/prospect showcase -> new_demo). Use quick_task for simple single-specialist requests.',
          'Only put facts the user actually stated in known_facts. Set needs_clarification=true ONLY if the work cannot responsibly start (e.g. improvement/redesign/audit requested but no site URL or files). A new site for an unnamed business can proceed with clearly marked placeholders.',
        ].join('\n'),
      },
      { role: 'user' as const, content: `${hint ? `(The user explicitly requested the ${hint} workflow.)\n` : ''}${project.request}` },
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
    if (hint && INTENTS.includes(hint as any)) interp.intent = hint as Interpretation['intent'];
    const urls = [...new Set([...(interp.urls ?? []), interp.business.existing_url].filter((u): u is string => !!u && /^https?:\/\//i.test(u)))];
    await this.d.projects.update(projectId, { interpretation: interp, name: interp.project_name, kind: interp.intent });
    await this.d.memory.set('project', projectId, 'brief', {
      request: project.request, intent: interp.intent, complexity: interp.complexity, summary: interp.summary, business: interp.business, audience: interp.audience,
      goals: interp.goals, constraints: interp.constraints, deliverables: interp.deliverables, urls, existing_url: interp.business.existing_url,
    }, 'main_agent');
    if (interp.known_facts.length) await this.d.memory.set('project', projectId, 'facts', interp.known_facts, 'main_agent:request');
    await this.#rootEvent(projectId, 'interpreted', { intent: interp.intent, name: interp.project_name, complexity: interp.complexity });
    if (interp.needs_clarification && interp.clarification_questions.length) {
      await this.d.projects.transition(projectId, ['PLANNING'], 'NEEDS_ATTENTION');
      await this.d.projects.addMessage(projectId, 'main_agent', `Before I start, I need a little more information:\n${interp.clarification_questions.map((q) => `- ${q}`).join('\n')}`, { clarification: interp.clarification_questions });
    }
    return interp;
  }

  /** MAIN — Build Project Blueprint (source of truth). */
  async blueprint(projectId: string): Promise<Blueprint> {
    const project = await this.d.projects.get(projectId);
    if (project.blueprint) return project.blueprint as Blueprint;
    const interp = project.interpretation as Interpretation | null;
    if (!interp) throw new AppError('not_interpreted', 'Interpret the request before writing the blueprint', 409);
    const baseline = interp.business.existing_url ? await this.#importBaseline(projectId, interp.business.existing_url) : null;
    let bp: Blueprint | null = null;
    let lastErr = '';
    for (let i = 0; i < 2 && !bp; i++) {
      const res = await this.d.provider.requestModel({
        capability: 'planning',
        maxTokens: 4000,
        temperature: 0.2,
        metadata: { purpose: 'main_agent:blueprint', projectId, priority: 95 },
        messages: [
          { role: 'system', content: BLUEPRINT_PROMPT },
          { role: 'user', content: `REQUEST:\n${project.request}\n\nINTERPRETATION:\n${JSON.stringify(interp, null, 1)}${baseline ? `\n\nEXISTING SITE (imported baseline pages): ${JSON.stringify(baseline)}` : ''}${lastErr ? `\n\nYour previous blueprint was invalid: ${lastErr}` : ''}` },
        ],
      });
      try {
        bp = parseJson(BlueprintSchema, res.content);
      } catch (err) {
        lastErr = errorMessage(err).slice(0, 400);
      }
    }
    if (!bp) throw new AppError('blueprint_failed', `Could not produce a valid blueprint: ${lastErr}`, 502);
    // Facts the user did not state cannot enter the blueprint as facts.
    const stated = [project.request, ...interp.known_facts].join(' ').toLowerCase();
    for (const k of ['phone', 'email', 'address'] as const) {
      const v = bp.business.contact[k];
      if (v && !stated.includes(v.toLowerCase())) {
        bp.open_questions.push(`Confirm the business ${k} (the blueprint had "${v}", which was not in the request).`);
        bp.business.contact[k] = null;
      }
    }
    if (bp.business.name && !stated.includes(bp.business.name.toLowerCase())) bp.business.name = null;
    bp.requirements = bp.requirements.map((r, i) => ({ ...r, id: r.id?.match(/^REQ-\d+$/) ? r.id : `REQ-${String(i + 1).padStart(2, '0')}` }));
    await this.d.db.query('UPDATE projects SET blueprint = $2, updated_at = now() WHERE id = $1', [projectId, JSON.stringify(bp)]);
    await this.d.memory.set('project', projectId, 'blueprint', bp, 'main_agent');
    await this.d.artifacts.save({ projectId, taskId: null, path: 'docs/BLUEPRINT.json', content: JSON.stringify(bp, null, 2), kind: 'doc', createdBy: 'main_agent' });
    await this.#rootEvent(projectId, 'blueprint_created', { pages: bp.pages.length, requirements: bp.requirements.length, open_questions: bp.open_questions.length });
    return bp;
  }

  async #importBaseline(projectId: string, url: string): Promise<unknown> {
    const existing = await this.d.memory.get('project', projectId, 'baseline');
    if (existing) return existing;
    try {
      const imported = await importExistingSite(url, { projectId, artifacts: this.d.artifacts, timeoutMs: this.d.config.research.fetchTimeoutMs, maxBytes: this.d.config.research.maxFetchBytes, fetchImpl: this.d.fetchImpl });
      await this.d.memory.set('project', projectId, 'baseline', imported, 'main_agent:import');
      await this.d.repos.snapshot(projectId, { label: `Baseline imported from ${url}`, taskId: null, author: 'import', stable: true });
      return imported;
    } catch (err) {
      const r = { error: errorMessage(err) };
      await this.d.memory.set('project', projectId, 'baseline', r, 'main_agent:import');
      return r;
    }
  }

  /** MAIN — Select Skill Chain */
  async selectSkills(projectId: string): Promise<ChainEntry[]> {
    const project = await this.d.projects.get(projectId);
    if (project.skill_chain) return project.skill_chain as ChainEntry[];
    const interp = project.interpretation as Interpretation;
    const { chain, method } = await this.d.skills.select({ projectId, intent: interp.intent, request: project.request, summary: interp.summary }, this.d.provider);
    // Security screening always accompanies external input.
    const full = this.d.skills.expand([...chain, { skill: 'security-screening', reason: 'external inputs are always screened', via: 'rule' as const }]);
    await this.d.db.query('UPDATE projects SET skill_chain = $2, updated_at = now() WHERE id = $1', [projectId, JSON.stringify(full)]);
    await this.#rootEvent(projectId, 'skills_selected', { method, skills: full.map((c) => c.skill) });
    return full;
  }

  /** MAIN — Build Plan (Task Decomposer over the workflow template, validated, gated, skills assigned). */
  async plan(projectId: string): Promise<{ source: string; tasks: PlanTask[]; warnings: string[]; levels: string[][]; rationale: string | null; dry_run_report: unknown }> {
    const project = await this.d.projects.get(projectId);
    if (project.plan) return project.plan as any;
    const interp = project.interpretation as Interpretation | null;
    if (!interp) throw new AppError('not_interpreted', 'Interpret the request before planning', 409);
    if (project.status === 'NEEDS_ATTENTION') throw new AppError('needs_clarification', 'Project is waiting for clarification from the user', 409);
    const template = templateFor(interp.intent);
    const chain = ((project.skill_chain ?? []) as ChainEntry[]).map((c) => c.skill);
    const registry = specialists().filter((a) => a.type !== 'task_decomposer')
      .map((a) => `- ${a.type}${a.reviewer ? ' [reviewer]' : ''}: ${a.mission}`).join('\n');
    const decomposer = getAgent('task_decomposer');
    const baseMessages = [
      {
        role: 'system' as const,
        content: [
          `You are the ${decomposer.name} working for the ApexWeb Main Agent. ${decomposer.mission}`,
          ...decomposer.instructions.map((i) => `- ${i}`),
          'Start from the TEMPLATE task graph and adapt it: tailor every mission to the blueprint, remove optional tasks that add no value, add tasks only when the request needs them (e.g. webgl_specialist only if 3D is genuinely justified). Scale to complexity: a simple request needs few tasks.',
          `Required keys that must remain: ${template.required.join(', ')}.`,
          'Keep the flags from the template: "review_of" (reviewer gate), "qa_gate", "visual_qa_gate", "triage" (Main Agent triage), "approval_gate", "priority_class".',
          `REGISTERED SPECIALISTS:\n${registry}`,
          `PROJECT SKILL CHAIN: ${chain.join(', ')}`,
          'Reply with JSON only: {"tasks":[{"key","agent_type","title","mission","depends_on":[keys],"priority","optional","review_of","qa_gate","visual_qa_gate","triage","approval_gate","priority_class"}],"rationale":string}',
        ].join('\n'),
      },
      { role: 'user' as const, content: `INTERPRETED REQUEST:\n${JSON.stringify(interp, null, 1)}\n\nBLUEPRINT:\n${JSON.stringify(project.blueprint ?? {}, null, 1).slice(0, 12_000)}\n\nTEMPLATE (${template.label}):\n${JSON.stringify(template.tasks, null, 1)}` },
    ];
    let validated: ReturnType<typeof validatePlan> | null = null;
    let source = 'task_decomposer';
    let rationale: string | null = null;
    let feedback = '';
    for (let i = 0; i < 2 && !validated; i++) {
      try {
        const res = await this.d.provider.requestModel({
          capability: 'planning', maxTokens: 7000, temperature: 0.2,
          metadata: { purpose: 'main_agent:plan', projectId, priority: 95 },
          messages: feedback ? [...baseMessages, { role: 'user', content: `Your plan was invalid: ${feedback}. Return a corrected JSON plan.` }] : baseMessages,
        });
        const proposed = parseJson(PlanSchema, res.content);
        rationale = proposed.rationale ?? null;
        validated = validatePlan(proposed.tasks as PlanTask[], template);
      } catch (err) {
        if (err instanceof ProviderError || err instanceof AppError) throw err;
        feedback = err instanceof PlanValidationError ? err.errors.join('; ') : errorMessage(err).slice(0, 400);
      }
    }
    if (!validated) {
      validated = validatePlan(template.tasks.map((t) => ({ ...t, depends_on: [...t.depends_on] })), template);
      source = 'template_fallback';
      validated.warnings.push(`Task Decomposer output rejected twice (${feedback}); using the ${template.label} template graph.`);
    }
    const gates = activeGates(project);
    const tasks = applyGates(validated.tasks, gates).map((t) => ({
      ...t,
      skills: [...new Set([...this.d.skills.forAgent(chain, t.agent_type), ...(t.skills ?? []).map((s) => this.d.skills.resolve(s)).filter(Boolean).map((d) => `${d!.name}@${d!.version}`)])],
      stage: t.stage ?? getAgent(t.agent_type).stage,
    }));
    const levels = parallelLevels(tasks);
    const plan = { source, template: template.intent, tasks, warnings: validated.warnings, levels, rationale, gates, dry_run_report: this.#dryRunReport(project, tasks, levels, gates) };
    await this.d.projects.update(projectId, { plan });
    await this.d.db.query('UPDATE projects SET dry_run_report = $2 WHERE id = $1', [projectId, JSON.stringify(plan.dry_run_report)]);
    await this.#rootEvent(projectId, 'planned', { source, tasks: tasks.length, levels: levels.length, warnings: plan.warnings, gates });
    await this.d.lifecycle.refresh(projectId, 'plan created');
    return plan;
  }

  #dryRunReport(project: ProjectRow, tasks: PlanTask[], levels: string[][], gates: Gate[]) {
    const agents = new Map<string, number>();
    for (const t of tasks) agents.set(t.agent_type, (agents.get(t.agent_type) ?? 0) + 1);
    const risks: string[] = [];
    const interp = project.interpretation as Interpretation | null;
    if (!this.d.search.configured) risks.push('No web search provider is configured: research can only use supplied URLs, so most business facts will stay placeholders.');
    if (!interp?.business.name) risks.push('No business name supplied: contact details, service area and proof will be placeholders for the client to fill.');
    if (tasks.some((t) => t.agent_type === 'webgl_specialist')) risks.push('3D is included: performance and accessibility budgets must be protected (fallbacks, reduced motion).');
    if (tasks.some((t) => t.optional)) risks.push(`${tasks.filter((t) => t.optional).length} optional task(s) may be skipped if they fail.`);
    if (gates.length) risks.push(`Approval gates active: ${gates.join(', ')}.`);
    const reviewers = tasks.filter((t) => t.review_of || t.qa_gate || t.visual_qa_gate).length;
    return {
      agents: [...agents.entries()].map(([type, n]) => ({ agent_type: type, name: getAgent(type).name, tasks: n })),
      tasks: tasks.map((t) => ({ key: t.key, agent: t.agent_type, title: t.title, depends_on: t.depends_on, gate: t.review_of ? `review of ${t.review_of}` : t.qa_gate ? 'final QA' : t.visual_qa_gate ? 'visual QA loop' : t.approval_gate ? `approval: ${t.approval_gate}` : t.triage ? 'triage' : null, skills: t.skills ?? [], stage: t.stage, priority_class: t.priority_class ?? null })),
      levels,
      max_parallel: Math.max(...levels.map((l) => l.length)),
      estimated_model_calls: { minimum: tasks.filter((t) => !t.approval_gate).length + 5, expected: Math.round(tasks.filter((t) => !t.approval_gate).length * 1.35 + reviewers * 1.5 + 5) },
      expected_artifacts: [...new Set(tasks.flatMap((t) => (getAgent(t.agent_type).producesFiles ? [t.agent_type === 'project_documentation' || t.agent_type === 'proposal_agent' ? 'docs/*' : 'site/*'] : [])).concat(['docs/BLUEPRINT.json', 'reports/scorecard.json', 'reports/completion-report.json', 'screenshots/*']))],
      risks,
    };
  }

  /** QUEUE — Enqueue Task Graph (or pause for plan approval in dry-run / assist mode). */
  async enqueue(projectId: string, actor = 'main_agent', opts: { approved?: boolean } = {}): Promise<{ tasks: TaskRow[]; awaiting_approval: string | null }> {
    const project = await this.d.projects.get(projectId);
    const plan = project.plan as { tasks: PlanTask[]; levels: string[][]; source: string; warnings: string[] } | null;
    if (!plan) throw new AppError('not_planned', 'Build the plan before enqueueing', 409);
    if (!opts.approved && activeGates(project).includes('plan_approval')) {
      const approval = await this.d.approvals.request({ projectId, gate: 'plan_approval', title: `Approve the plan for "${project.name}" (${plan.tasks.length} tasks)`, detail: project.dry_run_report });
      await this.d.projects.transition(projectId, ['PLANNING'], 'AWAITING_APPROVAL');
      await this.d.projects.addMessage(projectId, 'main_agent', `Dry run ready: ${plan.tasks.length} tasks, ${(project.dry_run_report as any)?.agents?.length ?? '?'} specialists, up to ${(project.dry_run_report as any)?.max_parallel ?? '?'} in parallel. Review the plan and approve it (/approve ${approval.id}) to start execution.`, { approval: approval.id, dry_run: project.dry_run_report });
      return { tasks: [], awaiting_approval: approval.id };
    }
    const ids = new Map(plan.tasks.map((t) => [t.key, newId('tsk')]));
    const specs: NewTaskSpec[] = plan.tasks.map((t) => ({
      id: ids.get(t.key),
      plan_key: t.key,
      agent_type: t.agent_type,
      title: t.title,
      mission: t.mission,
      kind: t.approval_gate ? 'approval' : t.triage ? 'triage' : t.visual_qa_gate ? 'visual_qa' : t.review_of ? 'review' : t.qa_gate ? 'qa' : 'work',
      priority: t.priority,
      priority_class: t.priority_class,
      optional: !!t.optional,
      dependencies: t.depends_on.map((d) => ids.get(d)!),
      review_target: t.review_of ? ids.get(t.review_of)! : null,
      inputs: t.approval_gate ? { gate: t.approval_gate } : {},
      skills: t.skills ?? [],
      stage: t.stage ?? null,
      idempotency_key: `${projectId}:plan:${t.key}`,
      allow_duplicate: true,
    }));
    const root = await this.#root(projectId);
    const tasks = await this.d.queue.createTasks(projectId, specs, actor);
    if (root.status === 'PLANNING') await this.d.queue.transition(root.id, ['PLANNING'], 'WAITING', {}, { type: 'graph_enqueued', actor, detail: { tasks: tasks.length } });
    await this.d.projects.transition(projectId, ['PLANNING', 'AWAITING_APPROVAL'], 'RUNNING');
    const specialistsUsed = [...new Set(plan.tasks.map((t) => getAgent(t.agent_type).name))];
    await this.d.projects.addMessage(projectId, 'main_agent',
      `Plan running: ${tasks.length} tasks across ${plan.levels.length} dependency levels (up to ${Math.max(...plan.levels.map((l) => l.length))} in parallel), ${specialistsUsed.length} specialists: ${specialistsUsed.join(', ')}.`,
      { plan_source: plan.source, warnings: plan.warnings });
    await this.d.queue.reconcile(projectId, actor);
    await this.d.lifecycle.refresh(projectId, 'execution started');
    this.d.queue.emit('tasks_ready', { projectId });
    return { tasks, awaiting_approval: null };
  }

  /** Internal driver: interpret -> blueprint -> skills -> plan -> enqueue (n8n drives the same steps node by node). */
  async planProject(projectId: string): Promise<void> {
    try {
      const interp = await this.interpret(projectId);
      const project = await this.d.projects.get(projectId);
      if (project.status === 'NEEDS_ATTENTION' || interp.needs_clarification) return;
      await this.blueprint(projectId);
      await this.selectSkills(projectId);
      await this.plan(projectId);
      await this.enqueue(projectId);
    } catch (err) {
      log.error('planning failed', { project: projectId, error: errorMessage(err) });
      await this.d.projects.transition(projectId, ['PLANNING'], 'NEEDS_ATTENTION');
      await this.d.projects.addMessage(projectId, 'main_agent', `I could not plan this project: ${errorMessage(err)}. You can retry planning once the issue is resolved.`, { error: errorMessage(err) });
    }
  }

  async clarify(projectId: string, answer: string, actor: string): Promise<void> {
    const project = await this.d.projects.get(projectId);
    if (project.status !== 'NEEDS_ATTENTION' || project.plan) throw new AppError('not_awaiting_clarification', 'Project is not waiting for clarification', 409);
    await this.d.db.query(`UPDATE projects SET request = request || $2, interpretation = NULL, blueprint = NULL, skill_chain = NULL, status = 'PLANNING', updated_at = now() WHERE id = $1`, [projectId, `\n\nClarification from user: ${answer}`]);
    await this.d.projects.audit(actor, 'project.clarify', 'project', projectId);
    await this.driver?.onProjectCreated(projectId);
  }

  // ------------------------------------------------------------ APPROVALS
  async #openTaskApproval(projectId: string, taskId: string): Promise<void> {
    const task = await this.d.queue.get(taskId);
    const gate = (task.inputs?.gate ?? 'major_redesign') as Gate;
    const a = await this.d.approvals.request({ projectId, taskId, gate, title: task.title, detail: { mission: task.mission } });
    await this.d.projects.addMessage(projectId, 'main_agent', `Approval needed before continuing: ${task.title}. Reply /approve ${a.id} or /reject ${a.id} <reason>.`, { approval: a.id });
  }

  async resolveApproval(approvalId: string, decision: 'approved' | 'rejected', actor: string, note?: string | null): Promise<string> {
    const a = await this.d.approvals.decide(approvalId, decision, actor, note);
    await this.d.projects.audit(actor, `approval.${decision}`, 'approval', approvalId, { gate: a.gate, note });
    const project = await this.d.projects.get(a.project_id);
    if (a.gate === 'plan_approval') {
      if (decision === 'approved') {
        await this.enqueue(project.id, actor, { approved: true });
        return 'Plan approved; execution started.';
      }
      await this.d.projects.transition(project.id, ['AWAITING_APPROVAL'], 'NEEDS_ATTENTION');
      await this.d.projects.addMessage(project.id, 'main_agent', `Plan rejected${note ? `: ${note}` : ''}. Tell me what to change and I will re-plan.`);
      return 'Plan rejected.';
    }
    if (a.task_id) {
      const task = await this.d.queue.get(a.task_id);
      if (decision === 'approved') {
        const done = await this.d.queue.transition(task.id, ['QUEUED', 'WAITING'], 'COMPLETED', { outputs: { summary: `Approved by ${actor}${note ? `: ${note}` : ''}`, approved: true }, completed_at: new Date() }, { type: 'approved', actor });
        await this.d.queue.reconcile(project.id, actor);
        this.d.queue.emit('task_terminal', { task: done });
        return `${task.title}: approved.`;
      }
      const cancelled = await this.d.queue.transition(task.id, ['QUEUED', 'WAITING'], 'CANCELLED', { error: { class: 'rejected', message: note ?? 'rejected by user' }, completed_at: new Date() }, { type: 'rejected', actor });
      await this.d.queue.reconcile(project.id, actor);
      this.d.queue.emit('task_terminal', { task: cancelled });
      return `${task.title}: rejected. Dependent work is on hold; tell me how to proceed.`;
    }
    if (a.gate === 'final_handoff') {
      if (decision === 'approved') {
        await this.d.projects.transition(project.id, ['AWAITING_APPROVAL'], 'RUNNING');
        await this.driver?.onProjectSettled(project.id);
        return 'Handoff approved; assembling the final package.';
      }
      await this.d.projects.transition(project.id, ['AWAITING_APPROVAL'], 'NEEDS_ATTENTION');
      return 'Handoff rejected; tell me what should change (a revision request works).';
    }
    if (a.gate === 'repo_irreversible' && a.detail?.action === 'rollback') {
      if (decision !== 'approved') return 'Rollback rejected; nothing changed.';
      const snap = await this.d.repos.rollback(project.id, a.detail.snapshot_id, actor);
      await this.d.projects.addMessage(project.id, 'main_agent', `Rolled back to snapshot ${a.detail.snapshot_id} as a new commit${snap?.commit_sha ? ` (${snap.commit_sha.slice(0, 8)})` : ''}. History is preserved.`);
      return 'Rollback applied as a new commit.';
    }
    return `Approval ${decision}.`;
  }

  async requestRollback(projectId: string, snapshotId: string, actor: string): Promise<string> {
    const snaps = await this.d.repos.list(projectId);
    const target = snaps.find((s) => s.id === snapshotId);
    if (!target) throw new AppError('not_found', `Snapshot ${snapshotId} not found`, 404);
    const a = await this.d.approvals.request({ projectId, gate: 'repo_irreversible', title: `Roll back to "${target.label}"`, detail: { action: 'rollback', snapshot_id: snapshotId, requested_by: actor } });
    await this.d.projects.addMessage(projectId, 'main_agent', `Rollback to "${target.label}" needs approval: /approve ${a.id}. It will be applied as a new commit; nothing is deleted.`, { approval: a.id });
    return a.id;
  }

  async setMode(projectId: string, mode: Mode, actor: string, gates?: Gate[] | null): Promise<ProjectRow> {
    if (!MODES.includes(mode)) throw new AppError('invalid_mode', `Mode must be one of ${MODES.join(', ')}`);
    await this.d.db.query('UPDATE projects SET mode = $2, approval_gates = $3, updated_at = now() WHERE id = $1', [projectId, mode, gates === undefined ? null : gates]);
    await this.d.projects.audit(actor, 'project.mode', 'project', projectId, { mode, gates });
    return this.d.projects.get(projectId);
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
            `I need your input. ${rows.length} required task(s) could not complete after automatic retries, model switching and a rescue attempt:\n${lines.join('\n')}\n\nOptions: /retry <task>, reassign it, override its result, or /cancel.`,
            { escalation: rows.map((r) => r.id) });
        }
        return;
      }
      if (activeGates(project).includes('final_handoff')) {
        const a = await this.d.approvals.request({ projectId, gate: 'final_handoff', title: `Approve final handoff of "${project.name}"`, detail: { progress } });
        await this.d.projects.transition(projectId, ['RUNNING'], 'AWAITING_APPROVAL');
        await this.d.projects.addMessage(projectId, 'main_agent', `All work is complete and QA has run. Approve the handoff (/approve ${a.id}) and I will assemble the final package.`, { approval: a.id });
        return;
      }
      await this.driver?.onProjectSettled(projectId);
    } finally {
      this.#settling.delete(projectId);
    }
  }

  // --------------------------------------------------------------- ASSEMBLY
  /** Final Assembly: package, scorecard, retrospective and the completion report. */
  async assemble(projectId: string, actor = 'main_agent'): Promise<Record<string, unknown>> {
    let project = await this.d.projects.get(projectId);
    if (project.status === 'COMPLETED' || project.status === 'APPROVED') return project.final_report ?? {};
    const moved = await this.d.projects.transition(projectId, ['RUNNING'], 'ASSEMBLING');
    if (!moved && project.status !== 'ASSEMBLING') throw new AppError('not_ready', `Project is ${project.status}; cannot assemble`, 409);
    await this.d.lifecycle.refresh(projectId, 'assembling handoff package');
    project = await this.d.projects.get(projectId);
    const tasks = await this.d.queue.listByProject(projectId);
    const work = tasks.filter((t) => t.kind !== 'root');
    const pkgDir = path.join(this.d.config.dataDir, 'projects', projectId, 'package');
    const siteFiles = await this.d.artifacts.materialise(projectId, 'site/', path.join(pkgDir, 'site'));
    const docFiles = await this.d.artifacts.materialise(projectId, 'docs/', path.join(pkgDir, 'docs'));
    await this.d.artifacts.materialise(projectId, 'screenshots/visual-qa/', path.join(pkgDir, 'screenshots'));

    const qa = work.filter((t) => t.kind === 'qa' && t.status === 'COMPLETED').sort((a, b) => +new Date(b.updated_at) - +new Date(a.updated_at))[0];
    const vqa = work.filter((t) => t.kind === 'visual_qa' && t.status === 'COMPLETED').sort((a, b) => +new Date(b.updated_at) - +new Date(a.updated_at))[0];
    const qaReview = qa?.outputs?.review ?? null;
    const agentsUsed = new Map<string, { agent_type: string; name: string; tasks: number }>();
    for (const t of work.filter((t) => t.status === 'COMPLETED' && t.kind !== 'approval')) {
      const a = getAgent(t.agent_type);
      const e = agentsUsed.get(a.type) ?? { agent_type: a.type, name: a.name, tasks: 0 };
      e.tasks++;
      agentsUsed.set(a.type, e);
    }
    const unresolved = [...new Set(work.flatMap((t) => (t.outputs?.unresolved_issues ?? []) as string[]))].slice(0, 40);
    const failed = work.filter((t) => ['FAILED', 'BLOCKED', 'CANCELLED'].includes(t.status)).map((t) => ({ task: t.id, title: t.title, status: t.status, optional: t.optional, error: t.error?.message ?? null }));
    const siteText = siteFiles.length ? await this.d.artifacts.latestText(projectId, 'site/') : {};
    const placeholderList = [...new Set(Object.values(siteText).flatMap((c) => c.match(/\[\[PLACEHOLDER:[^\]]*\]\]/g) ?? []))];
    const facts = (await this.d.memory.get<string[]>('project', projectId, 'facts')) ?? [];
    const scorecard = await computeScorecard(this.d.db, this.d.artifacts, projectId, facts);
    await this.d.db.query('UPDATE projects SET scorecard = $2 WHERE id = $1', [projectId, JSON.stringify(scorecard)]);
    const { rows: usage } = await this.d.db.query(
      `SELECT key_id, count(*)::int AS requests, count(*) FILTER (WHERE r.status = 'ok')::int AS ok, round(avg(latency_ms) FILTER (WHERE r.status = 'ok'))::int AS avg_latency_ms
       FROM key_requests r WHERE r.project_id = $1 GROUP BY key_id ORDER BY key_id`,
      [projectId],
    );
    const { rows: savings } = await this.d.db.query(`SELECT kind, count(*)::int AS n FROM usage_savings WHERE project_id = $1 GROUP BY kind`, [projectId]);
    const { rows: claimCounts } = await this.d.db.query(`SELECT classification, count(*)::int AS n FROM research_claims WHERE project_id = $1 GROUP BY classification`, [projectId]);
    const snaps = await this.d.repos.list(projectId);
    const revisions = work.reduce((n, t) => n + t.revision, 0);
    const skillsUsed = [...new Set(work.flatMap((t) => t.skills ?? []))];

    const factsForReport = {
      project: { id: project.id, name: project.name, intent: project.kind, request: project.request, mode: project.mode },
      tasks: { total: work.length, completed: work.filter((t) => t.status === 'COMPLETED').length, failed },
      agents_used: [...agentsUsed.values()],
      skills_used: skillsUsed,
      outputs: { site_files: siteFiles, docs: docFiles },
      qa: { task: qa?.id ?? null, verdict: qaReview?.verdict ?? null, score: qaReview?.score ?? null, passed: qaReview?.verdict === 'approve', remaining_issues: qaReview?.issues ?? [], fix_cycles: project.fix_cycles, visual_qa: vqa ? { verdict: vqa.outputs?.review?.verdict ?? null, refinement: vqa.outputs?.refinement ?? null } : null },
      scorecard: scorecard.totals,
      revisions,
      unresolved_issues: unresolved,
      placeholders: placeholderList,
      research_claims: Object.fromEntries(claimCounts.map((c) => [c.classification, c.n])),
      nvidia_usage: usage,
    };
    let narrative: { completed: string; issues_summary: string; recommended_next_step: string | null } | null = null;
    try {
      const res = await this.d.provider.requestModel({
        capability: 'summarization', maxTokens: 1200, temperature: 0.2,
        metadata: { purpose: 'main_agent:report', projectId, priority: 95 },
        messages: [
          { role: 'system', content: 'You are the ApexWeb Main Agent writing the completion report for the user. Use ONLY the facts provided; never claim something passed if the facts say otherwise. Be concise and specific. Reply with JSON: {"completed": "what was accomplished (3-6 sentences)", "issues_summary": "what remains unresolved, or \'None\'", "recommended_next_step": string|null}. No hidden reasoning.' },
          { role: 'user', content: JSON.stringify({ ...factsForReport, task_summaries: work.filter((t) => t.outputs?.summary).map((t) => ({ agent: t.agent_type, title: t.title, summary: String(t.outputs!.summary).slice(0, 300) })) }).slice(0, 60_000) },
        ],
      });
      narrative = parseJson(z.object({ completed: z.string(), issues_summary: z.string(), recommended_next_step: z.string().nullable().default(null) }), res.content);
    } catch (err) {
      log.warn('report narrative failed; using structured report only', { project: projectId, error: errorMessage(err) });
    }
    const retrospective = await runRetrospective({ db: this.d.db, provider: this.d.provider, kb: this.d.knowledge, projectId, scorecard: scorecard.totals, specifics: [project.name, (project.interpretation as any)?.business?.name, (project.interpretation as any)?.business?.location, ...placeholderList].filter(Boolean) as string[] });
    const report = {
      completed: narrative?.completed ?? `Completed ${factsForReport.tasks.completed} of ${factsForReport.tasks.total} tasks. (Narrative summary unavailable: the summarisation call failed; all figures below come directly from task records.)`,
      agents_used: factsForReport.agents_used,
      skills_used: skillsUsed,
      outputs: factsForReport.outputs,
      issues: { summary: narrative?.issues_summary ?? (unresolved.length || failed.length ? 'See the lists below.' : 'None'), unresolved, failed_tasks: failed, placeholders: placeholderList },
      qa: factsForReport.qa,
      scorecard: { totals: scorecard.totals, categories: scorecard.categories, failed: scorecard.criteria.filter((c) => c.passed === false).map((c) => ({ id: c.id, criterion: c.criterion, evidence: c.evidence })) },
      research: factsForReport.research_claims,
      files: { package_dir: pkgDir, archive: null as string | null, site: siteFiles.map((f) => `site/${f}`), docs: docFiles.map((f) => `docs/${f}`), snapshots: snaps.length },
      recommended_next_step: narrative?.recommended_next_step ?? null,
      nvidia_usage: usage,
      avoided_work: Object.fromEntries(savings.map((s) => [s.kind, s.n])),
      retrospective: { candidate_knowledge: (retrospective as any).candidate_knowledge_ids?.length ?? 0 },
      revisions,
      generated_at: new Date().toISOString(),
    };
    mkdirSync(path.join(pkgDir, 'reports'), { recursive: true });
    writeFileSync(path.join(pkgDir, 'reports', 'completion-report.json'), JSON.stringify(report, null, 2));
    writeFileSync(path.join(pkgDir, 'reports', 'scorecard.json'), JSON.stringify(scorecard, null, 2));
    writeFileSync(path.join(pkgDir, 'reports', 'retrospective.json'), JSON.stringify(retrospective, null, 2));
    writeFileSync(path.join(pkgDir, 'reports', 'task-log.json'), JSON.stringify(work.map((t) => ({ id: t.id, key: t.plan_key, agent: t.agent_type, title: t.title, status: t.status, stage: t.stage, skills: t.skills, attempts: t.attempt, revision: t.revision, model: t.assigned_model, nvidia_key: t.assigned_key, summary: t.outputs?.summary ?? null, review: t.outputs?.review ?? null, error: t.error })), null, 2));
    writeFileSync(path.join(pkgDir, 'REPORT.md'), renderReportMarkdown(project, report));
    try {
      const archive = path.join(this.d.config.dataDir, 'projects', projectId, `${projectId}-package.tar.gz`);
      await execFileAsync('tar', ['-czf', archive, '-C', pkgDir, '.']);
      report.files.archive = archive;
    } catch (err) {
      log.warn('tar unavailable; package left as directory', { error: errorMessage(err) });
    }
    const final = await this.d.repos.snapshot(projectId, { label: `Handoff package: ${project.name}`, taskId: null, author: 'main_orchestrator', stable: factsForReport.qa.passed });
    if (final && factsForReport.qa.passed) await this.d.repos.markStable(final.id);
    await this.d.projects.update(projectId, { final_report: report, status: 'COMPLETED', completed_at: new Date() });
    const root = await this.#root(projectId);
    if (root.status === 'WAITING') await this.d.queue.transition(root.id, ['WAITING'], 'COMPLETED', { outputs: report, completed_at: new Date() }, { type: 'assembled', actor });
    await this.d.projects.addMessage(projectId, 'main_agent', renderReportMarkdown(project, report), { report: true });
    await this.d.projects.audit(actor, 'project.assembled', 'project', projectId, { qa_passed: factsForReport.qa.passed, scorecard: scorecard.totals });
    // Autopilot completes the lifecycle when QA passed; otherwise the user approves the handoff.
    if (project.mode === 'autopilot' && factsForReport.qa.passed) {
      await this.d.projects.update(projectId, { approved_at: new Date(), approved_by: 'autopilot' });
      await this.d.projects.transition(projectId, ['COMPLETED'], 'APPROVED');
    }
    await this.d.lifecycle.refresh(projectId, 'handoff package ready');
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
    const { rows } = await this.d.db.query(`SELECT id, status FROM tasks WHERE project_id = $1 AND status NOT IN ('COMPLETED', 'FAILED', 'CANCELLED')`, [projectId]);
    for (const r of rows) {
      await this.d.queue.transition(r.id, [r.status], 'CANCELLED', { completed_at: new Date(), lease_owner: null, lease_expires_at: null }, { type: 'cancelled', actor }).catch(() => undefined);
      this.d.queue.emit('task_cancelled', { taskId: r.id });
    }
    await this.d.db.query(`UPDATE projects SET status = 'CANCELLED', paused = false, completed_at = now(), updated_at = now() WHERE id = $1`, [projectId]);
    await this.d.db.query(`UPDATE approvals SET status = 'expired' WHERE project_id = $1 AND status = 'pending'`, [projectId]);
    return this.d.projects.get(projectId);
  }

  async approve(projectId: string, actor: string): Promise<ProjectRow> {
    const p = await this.d.projects.get(projectId);
    if (p.status !== 'COMPLETED') throw new AppError('not_completed', `Only a COMPLETED project can be approved (status ${p.status})`, 409);
    await this.d.projects.audit(actor, 'project.approve', 'project', projectId);
    await this.d.projects.update(projectId, { approved_at: new Date(), approved_by: actor });
    const out = (await this.d.projects.transition(projectId, ['COMPLETED'], 'APPROVED'))!;
    await this.d.lifecycle.refresh(projectId, `handoff approved by ${actor}`);
    return out;
  }

  /** Adds a sub-graph (review, test, QA, fix workflows) to an existing project. */
  async extendProject(projectId: string, tasks: PlanTask[], label: string, actor: string): Promise<TaskRow[]> {
    const project = await this.d.projects.get(projectId);
    if (['CANCELLED', 'PLANNING', 'AWAITING_APPROVAL'].includes(project.status)) throw new AppError('not_extendable', `Project is ${project.status}`, 409);
    const n = (await this.d.db.query(`SELECT count(DISTINCT substring(plan_key from '^(.*?)__'))::int AS n FROM tasks WHERE project_id = $1 AND plan_key LIKE '%\\_\\_%'`, [projectId])).rows[0].n + 1;
    const prefix = `${label}${n}`;
    const chain = ((project.skill_chain ?? []) as ChainEntry[]).map((c) => c.skill);
    const ids = new Map(tasks.map((t) => [t.key, newId('tsk')]));
    const specs: NewTaskSpec[] = tasks.map((t) => ({
      id: ids.get(t.key), plan_key: `${prefix}__${t.key}`, agent_type: t.agent_type, title: t.title, mission: t.mission,
      kind: t.approval_gate ? 'approval' : t.triage ? 'triage' : t.visual_qa_gate ? 'visual_qa' : t.review_of ? 'review' : t.qa_gate ? 'qa' : 'work',
      priority: t.priority, priority_class: t.priority_class, optional: !!t.optional, dependencies: t.depends_on.filter((d) => ids.has(d)).map((d) => ids.get(d)!),
      review_target: t.review_of ? ids.get(t.review_of) ?? null : null, skills: this.d.skills.forAgent(chain, t.agent_type), stage: t.stage ?? getAgent(t.agent_type).stage,
      idempotency_key: `${projectId}:${prefix}:${t.key}`,
    }));
    const created = await this.d.queue.createTasks(projectId, specs, actor);
    await this.d.db.query(`UPDATE projects SET status = 'RUNNING', final_report = CASE WHEN status IN ('COMPLETED', 'APPROVED') THEN NULL ELSE final_report END, completed_at = NULL, updated_at = now() WHERE id = $1 AND status IN ('COMPLETED', 'APPROVED', 'NEEDS_ATTENTION', 'RUNNING')`, [projectId]);
    const root = await this.#root(projectId);
    if (root.status === 'COMPLETED') await this.d.queue.transition(root.id, ['COMPLETED'], 'WAITING', {}, { type: 'project_extended', actor, detail: { label } });
    await this.d.queue.reconcile(projectId, actor);
    await this.d.lifecycle.refresh(projectId, `${label} work added`);
    this.d.queue.emit('tasks_ready', { projectId });
    return created;
  }

  async startRevision(projectId: string, message: string, actor: string): Promise<string> {
    const project = await this.d.projects.get(projectId);
    if (!['COMPLETED', 'APPROVED', 'NEEDS_ATTENTION', 'RUNNING'].includes(project.status)) {
      throw new AppError('not_revisable', `Project is ${project.status}; revisions can be requested once it has run`, 409);
    }
    const tpl = templateFor('client_revision');
    const tasks = tpl.tasks.map((t) => (t.key === 'revise' ? { ...t, mission: `Convert this client change request into precise subtasks for the right specialists; preserve everything not asked to change: "${message.slice(0, 3000)}"` } : t));
    await this.extendProject(projectId, tasks, 'revision', actor);
    const reply = 'Change request recorded. The Revision Manager is turning it into tasks; Visual QA and final QA will verify the result. Everything you did not ask to change is preserved.';
    await this.d.projects.addMessage(projectId, 'main_agent', reply);
    return reply;
  }

  async statusReport(projectId: string | null): Promise<string> {
    if (!projectId) {
      const projects = await this.d.projects.list(10);
      if (!projects.length) return 'No projects yet. Describe what you need, or use /newproject.';
      const lines = [];
      for (const p of projects) {
        const pr = await this.d.queue.projectProgress(p.id);
        lines.push(`- ${p.name} [${p.id}]: ${p.status} · stage ${p.stage} · ${p.mode}${p.paused ? ' (paused)' : ''}, ${pr.completed}/${pr.total} tasks complete`);
      }
      return `Projects:\n${lines.join('\n')}`;
    }
    const p = await this.d.projects.get(projectId);
    const pr = await this.d.queue.projectProgress(projectId);
    const { rows } = await this.d.db.query(
      `SELECT agent_type, title, status FROM tasks WHERE project_id = $1 AND kind <> 'root' AND status IN ('RUNNING', 'ASSIGNED', 'REVIEW', 'RETRYING', 'FAILED', 'BLOCKED') ORDER BY updated_at DESC LIMIT 12`,
      [projectId],
    );
    const pending = await this.d.approvals.list({ projectId, status: 'pending' });
    return [
      `${p.name} [${p.id}] is ${p.status} at stage ${p.stage} (${p.mode} mode)${p.paused ? ', paused' : ''}: ${pr.completed}/${pr.total} tasks complete, ${pr.active} active, ${pr.problems} need attention.`,
      ...rows.map((r) => `- ${getAgent(r.agent_type).name}: ${r.title} — ${r.status}`),
      ...pending.map((a) => `- Waiting for your approval: ${a.title} (/approve ${a.id})`),
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
    ...(r.skills_used?.length ? ['', `Skills applied: ${r.skills_used.join(', ')}`] : []),
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
    ...(r.qa.visual_qa ? [`Visual QA verdict: ${r.qa.visual_qa.verdict ?? 'n/a'}${r.qa.visual_qa.refinement ? ` (loop ended: ${r.qa.visual_qa.refinement.terminated})` : ''}.`] : []),
    ...(r.qa.remaining_issues?.length ? ['Remaining QA issues:', list(r.qa.remaining_issues.map((i: any) => `[${i.severity}] ${i.description}`))] : []),
    ...(r.scorecard ? ['', `Scorecard: ${r.scorecard.totals.passed} criteria passed, ${r.scorecard.totals.failed} failed, ${r.scorecard.totals.not_evaluated} not evaluated.`, ...(r.scorecard.failed.length ? [list(r.scorecard.failed.map((f: any) => `${f.id} ${f.criterion}: ${f.evidence}`))] : [])] : []),
    '',
    '## Files',
    `Package directory: ${r.files.package_dir}`,
    ...(r.files.archive ? [`Archive: ${r.files.archive}`] : []),
    ...(r.recommended_next_step ? ['', '## Recommended Next Step', r.recommended_next_step] : []),
    '',
  ].join('\n');
}

export { AGENTS };
