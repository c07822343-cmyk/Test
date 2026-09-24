// HTTP API. Everything under /v1 requires the bearer token; the dashboard is
// a static page that asks for the token. NVIDIA secrets never appear in any
// response: keys are identified by id and a masked fingerprint only.
import { createHmac, timingSafeEqual } from 'node:crypto';
import { createReadStream, existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import { z, ZodError } from 'zod';
import { AGENTS, getAgent, allowedSubAgents } from '../agents/registry.ts';
import { contentTypeFor } from '../memory/artifacts.ts';
import { toTaskObject } from '../queue/types.ts';
import { redact } from '../security/redact.ts';
import type { Services } from '../services.ts';
import { AppError } from '../util/common.ts';
import { errorMessage, logger } from '../util/log.ts';
import type { StepContext } from '../worker/executor.ts';
import { collectMetrics, renderMetricsText } from './metrics.ts';
import { cancelTask, overrideResult, reassignTask, retryTask } from './overrides.ts';
import { activityFeed } from './activity.ts';
import { usageReport } from './usage.ts';
import { COMMANDS } from '../orchestrator/commands.ts';
import { GATES, MODES } from '../orchestrator/approvals.ts';
import { templates } from '../orchestrator/templates.ts';
import { computeScorecard } from '../quality/scorecard.ts';
import { claimsByClass, projectSources } from '../research/provenance.ts';
import { analyzeFile, extractZip } from '../files/intelligence.ts';
import { screenText, recordScreen } from '../security/screen.ts';
import { TOOLS, TOOL_PROFILES } from '../tools/catalog.ts';

const log = logger('api');
const DASHBOARD = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'dashboard', 'index.html');

function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

export function signLink(secret: string, projectId: string, resource: string, expiresAt: number): string {
  return createHmac('sha256', secret).update(`${projectId}:${resource}:${expiresAt}`).digest('base64url');
}

let n8nBeatAt = 0;
function beatN8n(s: Services): void {
  if (Date.now() - n8nBeatAt < 5_000) return;
  n8nBeatAt = Date.now();
  void s.heartbeats.beat('n8n', 'n8n').catch(() => undefined);
}

function stepCtx(req: FastifyRequest, fallbackActor: string): StepContext {
  const h = req.headers;
  const exec = typeof h['x-n8n-execution-id'] === 'string' ? h['x-n8n-execution-id'] : null;
  let wf = typeof h['x-n8n-workflow'] === 'string' ? h['x-n8n-workflow'] : null;
  if (wf) {
    try {
      wf = decodeURIComponent(wf).slice(0, 120);
    } catch {
      /* keep raw */
    }
  }
  return { actor: exec ? `n8n:${wf ?? 'workflow'}` : fallbackActor, executionId: exec, workflow: wf };
}

const ChatBody = z.object({ message: z.string().min(1).max(20_000), project_id: z.string().optional().nullable(), idempotency_key: z.string().max(200).optional().nullable() });
const ClaimBody = z.object({ limit: z.coerce.number().int().min(1).max(64).default(8), owner: z.string().max(100).default('n8n') });
const LeaseBody = z.object({});
const InvokeBody = z.object({ lease_id: z.string().min(5) });
const FailBody = z.object({ error_class: z.string().max(60), message: z.string().max(4000).default(''), retry_after_ms: z.coerce.number().nullable().optional() });
const ReassignBody = z.object({ agent_type: z.string().optional(), model: z.string().nullable().optional() });
const OverrideBody = z.object({ summary: z.string().min(3).max(6000), result: z.record(z.any()).optional(), verdict: z.enum(['approve', 'reject']).optional() });
const MemoryBody = z.object({ value: z.any() });

export async function buildServer(s: Services): Promise<FastifyInstance> {
  const app = Fastify({ logger: false, bodyLimit: 5 * 1024 * 1024 });
  const token = s.config.apiToken;
  app.addContentTypeParser(['application/octet-stream', 'application/zip', 'application/pdf', 'image/png', 'image/jpeg', 'image/webp', 'image/svg+xml', 'text/plain', 'text/markdown'], { parseAs: 'buffer', bodyLimit: 30 * 1024 * 1024 }, (_req, body, done) => done(null, body));
  app.addHook('preHandler', async (req) => {
    if (req.headers['x-n8n-execution-id']) beatN8n(s);
  });

  app.setErrorHandler((err: any, req, reply) => {
    if (err instanceof ZodError) return reply.status(400).send({ error: 'validation_error', issues: err.issues.slice(0, 10) });
    if (err instanceof AppError) return reply.status(err.status).send({ error: err.code, message: errorMessage(err), details: redact(err.details) });
    if (err?.statusCode && err.statusCode < 500) return reply.status(err.statusCode).send({ error: 'bad_request', message: errorMessage(err) });
    log.error('unhandled API error', { route: req.url, error: errorMessage(err) });
    return reply.status(500).send({ error: 'internal_error', message: errorMessage(err) });
  });

  app.addHook('onRequest', async (req, reply) => {
    if (!req.url.startsWith('/v1/')) return;
    const h = req.headers.authorization ?? '';
    const presented = h.startsWith('Bearer ') ? h.slice(7) : '';
    if (!presented || !safeEqual(presented, token)) {
      return reply.status(401).send({ error: 'unauthorized', message: 'Bearer token required' });
    }
  });

  // ---------------------------------------------------------------- PUBLIC
  app.get('/healthz', async () => {
    await s.db.query('SELECT 1');
    return { ok: true, driver: s.driver.kind, keys_configured: s.keyPool.vault.size, uptime_s: Math.round((Date.now() - s.startedAt.getTime()) / 1000) };
  });
  app.get('/', async (_req, reply) => {
    reply.header('content-type', 'text/html; charset=utf-8');
    reply.header('content-security-policy', "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; img-src 'self' data:; frame-src 'self'");
    return readFileSync(DASHBOARD, 'utf8');
  });

  // Signed, expiring links so the browser can open previews/downloads without the bearer token.
  app.get('/files/:projectId/preview/*', async (req: any, reply) => {
    const { projectId } = req.params;
    const exp = Number(req.query.exp);
    if (!exp || exp < Date.now() || !safeEqual(String(req.query.sig ?? ''), signLink(token, projectId, 'preview', exp))) return reply.status(403).send({ error: 'invalid_or_expired_link' });
    let rel = String(req.params['*'] || 'index.html');
    if (rel.endsWith('/')) rel += 'index.html';
    const a = await s.artifacts.get(projectId, `site/${path.posix.normalize(rel)}`);
    if (!a) return reply.status(404).send({ error: 'not_found' });
    reply.header('content-type', contentTypeFor(a.path));
    reply.header('content-security-policy', "default-src 'self' data:; img-src * data:; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com data:; script-src 'self' 'unsafe-inline'");
    // Relative links inside the preview keep the signature.
    if (a.content_type.startsWith('text/html')) {
      const html = a.content.toString('utf8').replace(/(href|src)="(?!https?:|mailto:|tel:|#|data:|\/\/)([^"]+)"/g, (_m, attr, ref) => `${attr}="${ref}${ref.includes('?') ? '&' : '?'}exp=${exp}&sig=${req.query.sig}"`);
      return html;
    }
    return a.content;
  });
  app.get('/files/:projectId/package', async (req: any, reply) => {
    const { projectId } = req.params;
    const exp = Number(req.query.exp);
    if (!exp || exp < Date.now() || !safeEqual(String(req.query.sig ?? ''), signLink(token, projectId, 'package', exp))) return reply.status(403).send({ error: 'invalid_or_expired_link' });
    const archive = path.join(s.config.dataDir, 'projects', projectId, `${projectId}-package.tar.gz`);
    if (!existsSync(archive)) return reply.status(404).send({ error: 'package_not_built' });
    reply.header('content-type', 'application/gzip');
    reply.header('content-disposition', `attachment; filename="${projectId}-package.tar.gz"`);
    reply.header('content-length', statSync(archive).size);
    return reply.send(createReadStream(archive));
  });

  // ------------------------------------------------------------ MAIN AGENT
  app.post('/v1/chat', async (req) => {
    const body = ChatBody.parse(req.body);
    const r = await s.mainAgent.receive({ message: body.message, projectId: body.project_id ?? null, idempotencyKey: body.idempotency_key ?? (req.headers['idempotency-key'] as string | undefined) ?? null, actor: 'user' });
    return { type: r.type, reply: r.reply, project: r.project ? { id: r.project.id, name: r.project.name, status: r.project.status } : null, duplicate: 'duplicate' in r ? r.duplicate : false };
  });
  app.get('/v1/messages', async (req: any) => ({ messages: await s.projects.messages(req.query.project_id ?? null, Math.min(Number(req.query.limit ?? 100), 500)) }));

  // Step APIs used by the n8n "Main Agent Orchestrator" workflow.
  app.post('/v1/main/intake', async (req) => {
    const body = ChatBody.parse(req.body);
    const { project, duplicate } = await s.mainAgent.createProject(body.message, body.idempotency_key ?? null, stepCtx(req, 'user').actor);
    await s.projects.addMessage(project.id, 'user', body.message);
    return { project_id: project.id, duplicate, status: project.status };
  });
  app.post('/v1/main/projects/:id/interpret', async (req: any) => {
    const interp = await s.mainAgent.interpret(req.params.id);
    const p = await s.projects.get(req.params.id);
    return { project_id: p.id, status: p.status, intent: interp.intent, name: interp.project_name, needs_clarification: p.status === 'NEEDS_ATTENTION', questions: interp.clarification_questions };
  });
  app.post('/v1/main/projects/:id/blueprint', async (req: any) => {
    const bp = await s.mainAgent.blueprint(req.params.id);
    return { project_id: req.params.id, pages: bp.pages.map((p) => p.path), requirements: bp.requirements.length, open_questions: bp.open_questions };
  });
  app.post('/v1/main/projects/:id/skills', async (req: any) => {
    const chain = await s.mainAgent.selectSkills(req.params.id);
    return { project_id: req.params.id, skills: chain };
  });
  app.post('/v1/main/projects/:id/plan', async (req: any) => {
    const plan = await s.mainAgent.plan(req.params.id);
    return { project_id: req.params.id, source: plan.source, tasks: plan.tasks.map((t) => ({ key: t.key, agent_type: t.agent_type, depends_on: t.depends_on, skills: t.skills, gate: t.review_of ?? (t.qa_gate ? 'qa' : t.visual_qa_gate ? 'visual_qa' : t.approval_gate ?? (t.triage ? 'triage' : null)) })), levels: plan.levels, warnings: plan.warnings, dry_run_report: plan.dry_run_report };
  });
  app.post('/v1/main/projects/:id/enqueue', async (req: any) => {
    const { tasks, awaiting_approval } = await s.mainAgent.enqueue(req.params.id, stepCtx(req, 'main_agent').actor);
    const ready = tasks.filter((t) => t.status === 'QUEUED').map((t) => t.plan_key);
    return { project_id: req.params.id, enqueued: tasks.length, ready_now: ready, waiting: tasks.length - ready.length, awaiting_approval };
  });
  app.post('/v1/main/projects/:id/fail-planning', async (req: any) => {
    const body = z.object({ message: z.string().max(2000) }).parse(req.body);
    await s.projects.transition(req.params.id, ['PLANNING'], 'NEEDS_ATTENTION');
    await s.projects.addMessage(req.params.id, 'main_agent', `I could not plan this project: ${body.message}`);
    return { ok: true };
  });
  app.post('/v1/main/projects/:id/assemble', async (req: any) => {
    const report = await s.mainAgent.assemble(req.params.id, stepCtx(req, 'main_agent').actor);
    return { project_id: req.params.id, report };
  });

  // --------------------------------------------------------------- PROJECTS
  app.get('/v1/projects', async () => {
    const list = await s.projects.list(100);
    return { projects: await Promise.all(list.map(async (p) => ({ id: p.id, name: p.name, kind: p.kind, status: p.status, stage: p.stage, paused: p.paused, created_at: p.created_at, progress: await s.queue.projectProgress(p.id) }))) };
  });
  app.get('/v1/projects/:id', async (req: any) => {
    const p = await s.projects.get(req.params.id);
    const tasks = await s.queue.listByProject(p.id);
    return { project: p, progress: await s.queue.projectProgress(p.id), tasks: tasks.map(toTaskObject), waiting: await s.queue.waitingSummary(p.id) };
  });
  app.get('/v1/projects/:id/graph', async (req: any) => {
    const tasks = await s.queue.listByProject(req.params.id);
    const byId = new Map(tasks.map((t) => [t.id, t]));
    // Layout hint for dynamically inserted fixes: draw them after the stage that spawned them.
    const layoutAfter = (t: (typeof tasks)[number]): string[] => {
      if (t.kind !== 'fix') return [];
      if (t.inputs?.triage_task) return [t.inputs.triage_task];
      const gate = byId.get(t.inputs?.qa_task);
      return gate ? gate.dependencies.filter((d) => byId.get(d)?.kind !== 'fix') : [];
    };
    return {
      nodes: tasks.filter((t) => t.kind !== 'root').map((t) => ({ id: t.id, layout_after: layoutAfter(t), key: t.plan_key, agent: t.agent_type, agent_name: getAgent(t.agent_type).name, pipeline: getAgent(t.agent_type).pipeline, title: t.title, status: t.status, kind: t.kind, parent: t.parent_task_id, attempt: t.attempt, revision: t.revision, optional: t.optional, model: t.assigned_model, nvidia_key: t.assigned_key })),
      edges: tasks.flatMap((t) => t.dependencies.map((d) => ({ from: d, to: t.id }))).concat(tasks.filter((t) => t.parent_task_id && t.kind === 'subtask').map((t) => ({ from: t.parent_task_id!, to: t.id, sub: true } as any))),
    };
  });
  app.get('/v1/projects/:id/events', async (req: any) => ({ events: await s.queue.projectEvents(req.params.id, Number(req.query.since ?? 0)) }));
  app.get('/v1/projects/:id/artifacts', async (req: any) => ({ artifacts: await s.artifacts.list(req.params.id) }));
  app.get('/v1/projects/:id/artifacts/*', async (req: any, reply) => {
    const a = await s.artifacts.get(req.params.id, req.params['*'], req.query.version ? Number(req.query.version) : undefined);
    if (!a) throw new AppError('not_found', 'Artifact not found', 404);
    reply.header('content-type', a.content_type);
    return a.content;
  });
  app.get('/v1/projects/:id/links', async (req: any) => {
    const exp = Date.now() + 6 * 3600_000;
    const id = req.params.id;
    return {
      preview: `/files/${id}/preview/index.html?exp=${exp}&sig=${signLink(token, id, 'preview', exp)}`,
      package: `/files/${id}/package?exp=${exp}&sig=${signLink(token, id, 'package', exp)}`,
      expires_at: new Date(exp).toISOString(),
    };
  });
  app.get('/v1/projects/:id/report', async (req: any) => {
    const p = await s.projects.get(req.params.id);
    return { project_id: p.id, status: p.status, report: p.final_report };
  });
  for (const action of ['pause', 'resume', 'cancel'] as const) {
    app.post(`/v1/projects/:id/${action}`, async (req: any) => ({ project: await s.mainAgent.control(req.params.id, action, 'user') }));
  }
  app.post('/v1/projects/:id/approve', async (req: any) => ({ project: await s.mainAgent.approve(req.params.id, 'user') }));
  app.post('/v1/projects/:id/revise', async (req: any) => {
    const body = z.object({ message: z.string().min(3).max(6000) }).parse(req.body);
    return { reply: await s.mainAgent.startRevision(req.params.id, body.message, 'user') };
  });
  app.post('/v1/projects/:id/clarify', async (req: any) => {
    const body = z.object({ message: z.string().min(1).max(6000) }).parse(req.body);
    await s.mainAgent.clarify(req.params.id, body.message, 'user');
    return { ok: true };
  });
  app.post('/v1/projects/:id/replan', async (req: any) => {
    const p = await s.projects.get(req.params.id);
    if (p.status !== 'NEEDS_ATTENTION' || p.plan) throw new AppError('not_replannable', 'Only projects that failed during planning can be re-planned', 409);
    await s.db.query(`UPDATE projects SET status = 'PLANNING', updated_at = now() WHERE id = $1`, [p.id]);
    await s.mainAgent.driver?.onProjectCreated(p.id);
    return { ok: true };
  });

  // ------------------------------------------------------------------ TASKS
  app.get('/v1/tasks', async (req: any) => {
    const { rows } = await s.db.query(
      `SELECT * FROM tasks WHERE ($1::text IS NULL OR status = $1) AND ($2::text IS NULL OR project_id = $2) AND kind <> 'root' ORDER BY updated_at DESC LIMIT 300`,
      [req.query.status ?? null, req.query.project_id ?? null],
    );
    return { tasks: rows.map(toTaskObject) };
  });
  app.get('/v1/tasks/:id', async (req: any) => {
    const t = await s.queue.get(req.params.id);
    const include = String(req.query.include ?? '').split(',');
    const [events, runs, tools, prompt, raw] = await Promise.all([
      s.queue.events(t.id),
      s.db.query('SELECT workflow, execution_id, step, status, at FROM workflow_runs WHERE task_id = $1 ORDER BY id', [t.id]).then((r) => r.rows),
      s.memory.get('task', t.id, 'tool_results'),
      include.includes('prompt') ? s.memory.get('task', t.id, 'prompt') : Promise.resolve(undefined),
      include.includes('raw') ? s.memory.get('task', t.id, 'raw_output') : Promise.resolve(undefined),
    ]);
    const { rows: requests } = await s.db.query(
      `SELECT lease_id, key_id, model, status, http_status, latency_ms, granted_at, finished_at FROM key_requests WHERE task_id = $1 ORDER BY granted_at`,
      [t.id],
    );
    return { task: toTaskObject(t), agent: getAgent(t.agent_type), events, workflow_runs: runs, nvidia_requests: requests, tool_results: tools, prompt, raw_output: raw };
  });
  app.post('/v1/tasks/:id/cancel', async (req: any) => ({ task: toTaskObject(await cancelTask(s, req.params.id, 'user')) }));
  app.post('/v1/tasks/:id/retry', async (req: any) => ({ task: toTaskObject(await retryTask(s, req.params.id, 'user')) }));
  app.post('/v1/tasks/:id/continue', async (req: any) => ({ task: toTaskObject(await retryTask(s, req.params.id, 'user')) }));
  app.post('/v1/tasks/:id/reassign', async (req: any) => ({ task: toTaskObject(await reassignTask(s, req.params.id, ReassignBody.parse(req.body ?? {}), 'user')) }));
  app.post('/v1/tasks/:id/override', async (req: any) => ({ task: toTaskObject(await overrideResult(s, req.params.id, OverrideBody.parse(req.body), 'user')) }));

  // ----------------------------------------------------- n8n EXECUTION STEPS
  app.post('/v1/queue/claim', async (req) => {
    const body = ClaimBody.parse(req.body ?? {});
    const claimed = await s.queue.claimReady(body.owner, body.limit);
    const waiting = await s.queue.waitingSummary();
    return {
      claimed: claimed.map((t) => ({ task_id: t.id, project_id: t.project_id, agent_type: t.agent_type, agent_name: getAgent(t.agent_type).name, pipeline: getAgent(t.agent_type).pipeline, title: t.title, kind: t.kind, phase: t.phase, priority: t.priority, attempt: t.attempt + 1 })),
      claimed_count: claimed.length,
      waiting_on_dependencies: waiting.map((w) => ({ task_id: w.task_id, agent_type: w.agent_type, title: w.title, waiting_on: w.waiting_on })),
    };
  });
  app.post('/v1/queue/reap', async () => ({ reaped: await s.executor.reapExpired('n8n:reaper') }));
  app.post('/v1/tasks/:id/start', async (req: any) => {
    const t = await s.executor.start(req.params.id, stepCtx(req, 'n8n'));
    const agent = getAgent(t.agent_type);
    return { task_id: t.id, project_id: t.project_id, agent_type: t.agent_type, agent_name: agent.name, pipeline: agent.pipeline, title: t.title, attempt: t.attempt, phase: t.phase, tools: agent.tools ?? [], may_spawn: allowedSubAgents(agent.type).length > 0 };
  });
  app.post('/v1/tasks/:id/tools', async (req: any) => s.executor.runTools(req.params.id, stepCtx(req, 'n8n')));
  app.post('/v1/tasks/:id/model', async (req: any) => s.executor.selectModel(req.params.id, stepCtx(req, 'n8n')));
  app.post('/v1/tasks/:id/context', async (req: any) => s.executor.buildContext(req.params.id, stepCtx(req, 'n8n')));
  app.post('/v1/tasks/:id/lease', async (req: any) => {
    LeaseBody.parse(req.body ?? {});
    return s.executor.lease(req.params.id, stepCtx(req, 'n8n'));
  });
  app.post('/v1/tasks/:id/invoke', async (req: any) => s.executor.invoke(req.params.id, InvokeBody.parse(req.body).lease_id, stepCtx(req, 'n8n')));
  app.post('/v1/tasks/:id/review', async (req: any) => s.executor.review(req.params.id, stepCtx(req, 'n8n')));
  app.post('/v1/tasks/:id/fail', async (req: any) => {
    const body = FailBody.parse(req.body);
    return s.executor.fail(req.params.id, { errorClass: body.error_class, message: body.message, retryAfterMs: body.retry_after_ms ?? null }, stepCtx(req, 'n8n'));
  });

  // ------------------------------------------------------------ AGENCY OS
  app.get('/v1/commands', async () => ({ commands: COMMANDS }));
  app.get('/v1/templates', async () => ({ templates: templates().map((t) => ({ intent: t.intent, label: t.label, description: t.description, tasks: t.tasks.length, required: t.required, source: t.source })) }));
  app.get('/v1/extensions', async () => ({ extensions: s.extensions }));
  app.get('/v1/integrations/obsidian', async () => ({ enabled: !!s.obsidian, ...(s.obsidian?.status() ?? { hint: 'Set OBSIDIAN_VAULT_PATH to your vault folder to connect Obsidian.' }) }));
  app.post('/v1/integrations/obsidian/sync', async () => {
    if (!s.obsidian) throw new AppError('not_configured', 'Obsidian is not connected (set OBSIDIAN_VAULT_PATH)', 409);
    await s.obsidian.syncAll();
    return s.obsidian.status();
  });
  app.get('/v1/skills', async () => ({ skills: s.skills.catalog(), load: s.extensions.skills }));
  app.get('/v1/skills/:name', async (req: any) => {
    const d = s.skills.resolve(req.params.name);
    if (!d) throw new AppError('not_found', `Skill ${req.params.name} not found`, 404);
    return { skill: d, versions: s.skills.catalog().find((c) => c.name === d.name)?.versions ?? [] };
  });
  app.post('/v1/skills', async (req) => ({ skill: await s.skills.register(req.body, 'user') }));
  app.post('/v1/skills/:name/:version/:action', async (req: any) => {
    const action = z.enum(['enable', 'disable']).parse(req.params.action);
    await s.skills.setEnabled(req.params.name, req.params.version, action === 'enable');
    await s.projects.audit('user', `skill.${action}`, 'skill', `${req.params.name}@${req.params.version}`);
    return { ok: true };
  });
  /** Every skill is directly callable: runs it as a task with a compatible agent (in a project or a new quick project). */
  app.post('/v1/skills/:name/run', async (req: any) => {
    const body = z.object({ project_id: z.string().optional(), agent_type: z.string().optional(), mission: z.string().min(5).max(4000), priority_class: z.enum(['CRITICAL', 'HIGH', 'NORMAL', 'LOW', 'BACKGROUND']).optional() }).parse(req.body);
    const d = s.skills.resolve(req.params.name);
    if (!d) throw new AppError('not_found', `Skill ${req.params.name} not found`, 404);
    const agent = body.agent_type ?? d.compatible_agents.find((a) => a !== 'main_orchestrator') ?? d.compatible_agents[0];
    if (!d.compatible_agents.includes(agent)) throw new AppError('incompatible_agent', `${agent} is not compatible with ${d.name}`);
    let projectId = body.project_id;
    if (!projectId) {
      const { project } = await s.mainAgent.createProject(`Skill run ${d.name}: ${body.mission}`, null, 'user', { intentHint: 'quick_task' });
      await s.db.query(`UPDATE projects SET status = 'RUNNING', plan = $2 WHERE id = $1`, [project.id, JSON.stringify({ source: 'skill_run', tasks: [], levels: [] })]);
      await s.db.query(`UPDATE tasks SET status = 'WAITING' WHERE project_id = $1 AND kind = 'root'`, [project.id]);
      projectId = project.id;
    }
    const [task] = await s.mainAgent.extendProject(projectId, [{ key: 'skill', agent_type: agent, title: `${d.title}: ${body.mission.slice(0, 80)}`, mission: body.mission, depends_on: [], priority: 60, priority_class: body.priority_class, skills: [`${d.name}@${d.version}`] }], 'skill', 'user');
    return { project_id: projectId, task_id: task.id, agent_type: agent, skill: `${d.name}@${d.version}` };
  });

  app.get('/v1/approvals', async (req: any) => ({ approvals: await s.approvals.list({ projectId: req.query.project_id ?? null, status: req.query.status ?? null }) }));
  app.post('/v1/approvals/:id/:decision', async (req: any) => {
    const decision = z.enum(['approve', 'reject']).parse(req.params.decision);
    const note = z.object({ note: z.string().max(2000).optional() }).parse(req.body ?? {}).note ?? null;
    return { result: await s.mainAgent.resolveApproval(req.params.id, decision === 'approve' ? 'approved' : 'rejected', 'user', note) };
  });
  app.post('/v1/projects/:id/mode', async (req: any) => {
    const body = z.object({ mode: z.enum(MODES), gates: z.array(z.enum(GATES)).nullable().optional() }).parse(req.body);
    return { project: await s.mainAgent.setMode(req.params.id, body.mode, 'user', body.gates) };
  });
  app.get('/v1/projects/:id/blueprint', async (req: any) => ({ blueprint: (await s.projects.get(req.params.id)).blueprint }));
  app.get('/v1/projects/:id/dry-run', async (req: any) => ({ dry_run: (await s.projects.get(req.params.id)).dry_run_report }));
  app.get('/v1/projects/:id/scorecard', async (req: any) => ({ scorecard: (await s.projects.get(req.params.id)).scorecard }));
  app.post('/v1/projects/:id/scorecard', async (req: any) => {
    const card = await computeScorecard(s.db, s.artifacts, req.params.id, (await s.memory.get<string[]>('project', req.params.id, 'facts')) ?? []);
    await s.db.query('UPDATE projects SET scorecard = $2 WHERE id = $1', [req.params.id, JSON.stringify(card)]);
    return { scorecard: card };
  });
  app.get('/v1/projects/:id/claims', async (req: any) => ({ claims: await claimsByClass(s.db, req.params.id), facts: await s.memory.get('project', req.params.id, 'facts') }));
  app.get('/v1/projects/:id/sources', async (req: any) => ({ sources: await projectSources(s.db, req.params.id) }));
  app.get('/v1/projects/:id/stages', async (req: any) => ({ stage: (await s.projects.get(req.params.id)).stage, history: await s.lifecycle.history(req.params.id) }));
  app.get('/v1/projects/:id/snapshots', async (req: any) => ({ snapshots: await s.repos.list(req.params.id), commits: await s.repos.history(req.params.id) }));
  app.get('/v1/projects/:id/diff', async (req: any) => s.repos.diff(req.params.id, req.query.from, req.query.to));
  app.post('/v1/projects/:id/rollback', async (req: any) => {
    const body = z.object({ snapshot_id: z.string() }).parse(req.body);
    return { approval_id: await s.mainAgent.requestRollback(req.params.id, body.snapshot_id, 'user') };
  });
  app.get('/v1/projects/:id/retrospective', async (req: any) => ({ retrospective: (await s.db.query('SELECT report, created_at FROM retrospectives WHERE project_id = $1', [req.params.id])).rows[0] ?? null }));
  app.get('/v1/projects/:id/files', async (req: any) => ({ files: (await s.db.query('SELECT path, kind, analysis, created_at FROM file_analyses WHERE project_id = $1 ORDER BY path', [req.params.id])).rows }));
  /** Client file upload (raw body). ZIP archives are extracted safely; every file is analysed and security-screened. */
  app.post('/v1/projects/:id/files', async (req: any) => {
    const name = String(req.query.name ?? '').replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 120);
    if (!name || !Buffer.isBuffer(req.body)) throw new AppError('bad_upload', 'Send the file as the raw request body with ?name=<filename>');
    await s.projects.get(req.params.id);
    const entries = /\.zip$/i.test(name) ? extractZip(req.body).map((e) => ({ path: `${name.replace(/\.zip$/i, '')}/${e.path}`, data: e.data })) : [{ path: name, data: req.body as Buffer }];
    const stored: unknown[] = [];
    for (const e of entries.slice(0, 500)) {
      try {
        const meta = await s.artifacts.save({ projectId: req.params.id, taskId: null, path: `client/${e.path.replace(/ /g, '_')}`, content: e.data, kind: 'client_file', createdBy: 'user:upload' });
        const analysis = await analyzeFile(e.path, e.data);
        if (analysis.text_excerpt) await recordScreen(s.db, screenText(analysis.text_excerpt, `upload ${e.path}`), { projectId: req.params.id, kind: 'client_file' });
        stored.push({ path: meta.path, kind: analysis.kind, bytes: analysis.bytes, dimensions: analysis.dimensions, pages: analysis.pages });
      } catch (err) {
        stored.push({ path: e.path, error: errorMessage(err) });
      }
    }
    await s.projects.audit('user', 'files.upload', 'project', req.params.id, { name, files: stored.length });
    return { files: stored };
  });

  app.get('/v1/activity', async (req: any) => activityFeed(s.db, { projectId: req.query.project_id ?? null, sinceId: Number(req.query.since ?? 0), limit: Number(req.query.limit ?? 200) }));
  /** Server-sent events: pushes new activity as it is recorded (fetch with the Authorization header). */
  app.get('/v1/activity/stream', async (req: any, reply) => {
    reply.raw.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
    let cursor = Number(req.query.since ?? 0);
    const projectId = req.query.project_id ?? null;
    let closed = false;
    req.raw.on('close', () => (closed = true));
    if (!cursor) {
      const first = await activityFeed(s.db, { projectId, limit: 100 });
      for (const i of first.items) reply.raw.write(`data: ${JSON.stringify(i)}\n\n`);
      cursor = first.cursor;
    }
    while (!closed) {
      await new Promise((r) => setTimeout(r, 1000));
      const next = await activityFeed(s.db, { projectId, sinceId: cursor, limit: 200 }).catch(() => ({ items: [], cursor }));
      for (const i of next.items) reply.raw.write(`data: ${JSON.stringify(i)}\n\n`);
      cursor = next.cursor;
      reply.raw.write(': keep-alive\n\n');
    }
    return reply;
  });
  app.get('/v1/usage', async (req: any) => usageReport(s.db, req.query.project_id ?? null));
  app.get('/v1/workers', async () => ({ workers: await s.heartbeats.list(), watchdog: s.watchdog.lastRun }));
  app.post('/v1/watchdog/run', async () => ({ recovered: await s.watchdog.run() }));
  app.get('/v1/security/events', async (req: any) => ({ events: (await s.db.query('SELECT * FROM security_events WHERE ($1::text IS NULL OR project_id = $1) ORDER BY id DESC LIMIT 200', [req.query.project_id ?? null])).rows }));
  app.get('/v1/tools', async () => ({ tools: TOOLS, profiles: TOOL_PROFILES }));
  app.get('/v1/knowledge', async (req: any) => ({ knowledge: await s.knowledge.list(req.query.status ?? null, req.query.category ?? null) }));
  app.post('/v1/knowledge', async (req: any) => ({ entry: await s.knowledge.add(req.body, 'active', 'user') }));
  app.post('/v1/knowledge/:id/:decision', async (req: any) => {
    const decision = z.enum(['promote', 'reject', 'archive']).parse(req.params.decision);
    return { entry: await s.knowledge.decide(req.params.id, decision, 'user') };
  });

  // ------------------------------------------------------ KEYS / MODELS / AGENTS
  app.post('/v1/keys/check', async () => {
    await s.projects.audit('user', 'keys.check', 'nvidia_keys', null);
    return { results: await s.provider.checkKeys() };
  });
  app.get('/v1/keys', async () => ({ strategy: s.keyPool.strategyName, ceiling: s.config.nvidia.rpmPerKey, window_ms: s.config.nvidia.windowMs, waiting: s.keyPool.waitingCount, keys: await s.keyPool.snapshots() }));
  app.post('/v1/keys/:id/enable', async (req: any) => {
    await s.keyPool.setActive(req.params.id, true, null);
    await s.projects.audit('user', 'key.enable', 'key', req.params.id);
    return { ok: true };
  });
  app.post('/v1/keys/:id/disable', async (req: any) => {
    await s.keyPool.setActive(req.params.id, false, 'operator_disabled');
    await s.projects.audit('user', 'key.disable', 'key', req.params.id);
    return { ok: true };
  });
  app.get('/v1/keys/requests', async (req: any) => ({ requests: await s.provider.recentRequests(Math.min(Number(req.query.limit ?? 100), 500)) }));
  app.get('/v1/models', async () => ({ models: s.router.describe() }));
  app.post('/v1/models/discover', async () => s.provider.discoverModels());
  app.post('/v1/models/:id/available', async (req: any) => {
    const body = z.object({ available: z.boolean(), reason: z.string().max(200).optional() }).parse(req.body);
    const id = decodeURIComponent(req.params.id);
    if (!s.router.get(id)) throw new AppError('not_found', `Model ${id} not in registry`, 404);
    if (body.available) await s.router.markAvailable(id);
    else await s.router.markUnavailable(id, body.reason ?? 'operator_disabled');
    return { ok: true };
  });
  app.get('/v1/agents', async () => {
    const { rows } = await s.db.query(`SELECT agent_type, status, count(*)::int AS n FROM tasks WHERE kind <> 'root' GROUP BY agent_type, status`);
    return {
      agents: AGENTS.map((a) => ({
        type: a.type, name: a.name, department: a.department, pipeline: a.pipeline, capability: a.capability, parent: a.parent ?? null, mission: a.mission,
        sub_agents: a.subAgents ?? [], reviewer: !!a.reviewer, tools: a.tools ?? [], produces_files: !!a.producesFiles,
        tasks: Object.fromEntries(rows.filter((r) => r.agent_type === a.type).map((r) => [r.status, r.n])),
      })),
    };
  });

  // ------------------------------------------------------------ OBSERVABILITY
  app.get('/v1/metrics', async () => collectMetrics(s));
  app.get('/v1/metrics/text', async (_req, reply) => {
    reply.header('content-type', 'text/plain; charset=utf-8');
    return renderMetricsText(await collectMetrics(s));
  });
  app.get('/v1/dead-letters', async () => ({ dead_letters: (await s.db.query('SELECT * FROM dead_letters ORDER BY id DESC LIMIT 200')).rows }));
  app.get('/v1/audit', async () => ({ audit: (await s.db.query('SELECT * FROM audit_log ORDER BY id DESC LIMIT 300')).rows }));
  app.post('/v1/observability/snapshot', async (req) => {
    // Called by the n8n Observability workflow; stores a snapshot so trends survive restarts.
    const m = await collectMetrics(s);
    await s.memory.set('global', 'observability', `snapshot:${new Date().toISOString().slice(0, 16)}`, { tasks: m.tasks, nvidia: { ...m.nvidia, keys: m.nvidia.keys.map((k) => ({ id: k.id, rpm_used: k.rpm_used, health: k.health })) } }, stepCtx(req, 'n8n').actor);
    return { metrics: m, text: renderMetricsText(m), alerts: alertsFor(m) };
  });

  // ------------------------------------------------------------------ MEMORY
  app.get('/v1/memory/:scope/:scopeId', async (req: any) => ({ entries: await s.memory.list(req.params.scope, req.params.scopeId) }));
  app.put('/v1/memory/:scope/:scopeId/:key', async (req: any) => {
    const scope = z.enum(['global', 'project', 'agent']).parse(req.params.scope);
    await s.memory.set(scope, req.params.scopeId, req.params.key, MemoryBody.parse(req.body).value, 'user');
    await s.projects.audit('user', 'memory.set', 'memory', `${scope}/${req.params.scopeId}/${req.params.key}`);
    return { ok: true };
  });

  return app;
}

export function alertsFor(m: Awaited<ReturnType<typeof collectMetrics>>): string[] {
  const alerts: string[] = [];
  const active = m.nvidia.keys.filter((k) => k.active);
  if (active.length === 0) alerts.push('No active NVIDIA keys');
  for (const k of m.nvidia.keys) {
    if (k.disabled_reason === 'auth_failed') alerts.push(`${k.id} was rejected by NVIDIA (auth failed) and is disabled`);
    if (k.health === 'cooldown') alerts.push(`${k.id} cooling down for ${Math.ceil(k.cooldown_ms / 1000)}s`);
  }
  if (m.nvidia.error_rate_5m > 0.2 && m.nvidia.requests_last_5m >= 10) alerts.push(`NVIDIA error rate ${(m.nvidia.error_rate_5m * 100).toFixed(0)}% over 5 minutes`);
  if (m.tasks.dead_letters_open > 0) alerts.push(`${m.tasks.dead_letters_open} dead-lettered task(s) need attention`);
  for (const p of m.projects) if (p.status === 'NEEDS_ATTENTION') alerts.push(`Project ${p.name} needs attention`);
  return alerts;
}
