// Composition root: builds every component from configuration. Extension
// folders (agents/, skills/, workflows/, tools/, providers/, memory/, qa/ and
// the same layout under APEXWEB_EXTENSIONS_DIR)
// are loaded here, so new capabilities are registered - not coded - into the OS.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { registerAgent, validateRegistry } from './agents/registry.ts';
import { APEXWEB_GLOBAL_RULES } from './agents/globalRules.ts';
import { CacheStore } from './cache/cache.ts';
import type { AppConfig } from './config/env.ts';
import { migrate } from './db/migrate.ts';
import { createPool, type Db } from './db/pool.ts';
import { loadQaChecks } from './extensions/qaChecks.ts';
import { loadToolExtensions } from './extensions/tools.ts';
import { ObsidianSync } from './integrations/obsidian.ts';
import { ProjectRepos } from './devops/git.ts';
import { KnowledgeBase } from './knowledge/kb.ts';
import { ArtifactStore } from './memory/artifacts.ts';
import { MemoryStore } from './memory/memory.ts';
import { Approvals, MODES, type Mode } from './orchestrator/approvals.ts';
import { attachCommands } from './orchestrator/commands.ts';
import { ContextBuilder } from './orchestrator/contextBuilder.ts';
import { LifecycleTracker } from './orchestrator/lifecycle.ts';
import { MainAgent } from './orchestrator/mainAgent.ts';
import { loadTemplates } from './orchestrator/templates.ts';
import { KeyPool } from './provider/keyPool.ts';
import { loadModelRegistry } from './provider/modelRegistry.ts';
import { ModelRouter } from './provider/modelRouter.ts';
import { NvidiaClient } from './provider/nvidiaClient.ts';
import { NvidiaProvider } from './provider/provider.ts';
import { createStrategy } from './provider/scheduling.ts';
import { ProjectStore } from './queue/projects.ts';
import { TaskQueue } from './queue/taskQueue.ts';
import { createSearchProvider, type SearchProvider } from './research/search.ts';
import { registerSecret } from './security/redact.ts';
import { SkillEngine } from './skills/engine.ts';
import { errorMessage, logger } from './util/log.ts';
import { TaskExecutor } from './worker/executor.ts';
import { InternalWorker } from './worker/internalWorker.ts';
import { N8nDriver } from './worker/n8nDriver.ts';
import { Heartbeats, Watchdog } from './worker/watchdog.ts';

const log = logger('services');
export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export interface Services {
  config: AppConfig;
  db: Db;
  queue: TaskQueue;
  projects: ProjectStore;
  memory: MemoryStore;
  artifacts: ArtifactStore;
  keyPool: KeyPool;
  router: ModelRouter;
  client: NvidiaClient;
  provider: NvidiaProvider;
  contextBuilder: ContextBuilder;
  executor: TaskExecutor;
  mainAgent: MainAgent;
  driver: InternalWorker | N8nDriver;
  skills: SkillEngine;
  knowledge: KnowledgeBase;
  cache: CacheStore;
  search: SearchProvider;
  repos: ProjectRepos;
  lifecycle: LifecycleTracker;
  approvals: Approvals;
  heartbeats: Heartbeats;
  watchdog: Watchdog;
  obsidian: ObsidianSync | null;
  extensions: {
    agents: string[];
    skills: { loaded: number; errors: string[] };
    templates: { loaded: number; errors: string[] };
    knowledge_seeded: number;
    tools: { loaded: string[]; errors: string[] };
    qa_checks: { loaded: string[]; errors: string[] };
    provider_models: { loaded: string[]; errors: string[] };
  };
  startedAt: Date;
}

let agentExtensionsLoaded = false;

function jsonFiles(dirs: string[]): string[] {
  return dirs.filter((d) => existsSync(d)).flatMap((d) => readdirSync(d).filter((f) => f.endsWith('.json')).sort().map((f) => path.join(d, f)));
}

/** agents/*.json extension definitions (registered once per process). */
export function loadAgentExtensions(dirs: string[]): string[] {
  if (agentExtensionsLoaded) return [];
  agentExtensionsLoaded = true;
  const added: string[] = [];
  for (const dir of dirs) {
    if (!existsSync(dir)) continue;
    for (const f of readdirSync(dir).filter((x) => x.endsWith('.json')).sort()) {
      try {
        added.push(registerAgent(JSON.parse(readFileSync(path.join(dir, f), 'utf8'))).type);
      } catch (err) {
        log.error('agent extension rejected', { file: f, error: errorMessage(err) });
      }
    }
  }
  return added;
}

export async function createServices(config: AppConfig, opts: { fetchImpl?: typeof fetch; researchFetchImpl?: typeof fetch; db?: Db; env?: NodeJS.ProcessEnv } = {}): Promise<Services> {
  const env = opts.env ?? process.env;
  const extRoot = env.APEXWEB_EXTENSIONS_DIR ? path.resolve(env.APEXWEB_EXTENSIONS_DIR) : null;
  const dirs = (name: string) => [path.join(ROOT, name), ...(extRoot ? [path.join(extRoot, name)] : [])];
  // Tools first: agent extensions may reference extension tools.
  const toolExt = await loadToolExtensions(dirs('tools'));
  if (toolExt.errors.length) log.warn('tool extension problems', { errors: toolExt.errors });
  const agentExt = loadAgentExtensions(dirs('agents'));
  validateRegistry();
  const qaExt = loadQaChecks(dirs('qa'));
  if (qaExt.errors.length) log.warn('qa check extension problems', { errors: qaExt.errors });
  const templatesLoaded = loadTemplates(dirs('workflows'));
  if (templatesLoaded.errors.length) log.warn('workflow template problems', { errors: templatesLoaded.errors });
  registerSecret(config.apiToken);
  registerSecret(config.n8n.webhookSecret);
  if (config.nvidia.keys.length === 0) {
    log.warn('No NVIDIA API keys configured (NVIDIA_API_KEY_1..4). Model calls will fail until keys are provided.');
  }
  const db = opts.db ?? createPool(config.databaseUrl, 30);
  await migrate(db);
  const queue = new TaskQueue(db, { maxConcurrent: config.maxConcurrentTasks, leaseMs: config.taskLeaseMs });
  queue.setMaxListeners(50);
  const projects = new ProjectStore(db);
  const memory = new MemoryStore(db);
  const artifacts = new ArtifactStore(db);
  const keyPool = new KeyPool(db, config.nvidia.keys, {
    rpmPerKey: config.nvidia.rpmPerKey,
    windowMs: config.nvidia.windowMs,
    maxInflightPerKey: config.nvidia.maxInflightPerKey,
    leaseTtlMs: config.nvidia.requestTimeoutMs + 60_000,
    strategy: createStrategy(config.nvidia.schedulingStrategy),
  });
  await keyPool.sync();
  const registry = loadModelRegistry(config.nvidia.modelsFile, jsonFiles(dirs('providers')));
  if (registry.extensions.errors.length) log.warn('provider extension problems', { errors: registry.extensions.errors });
  const router = new ModelRouter(db, registry.models);
  await router.load();
  const client = new NvidiaClient({ baseUrl: config.nvidia.baseUrl, timeoutMs: config.nvidia.requestTimeoutMs, vault: keyPool.vault, fetchImpl: opts.fetchImpl });
  const provider = new NvidiaProvider({ db, keyPool, router, client, maxLeaseWaitMs: config.nvidia.maxLeaseWaitMs });
  const skills = new SkillEngine(db, dirs('skills'));
  const skillLoad = await skills.load();
  const knowledge = new KnowledgeBase(db);
  let seeded = 0;
  for (const d of dirs('memory')) seeded += await knowledge.seed(d);
  const cache = new CacheStore(db);
  const search = createSearchProvider(env, opts.researchFetchImpl);
  const repos = new ProjectRepos(db, artifacts, config.dataDir);
  const lifecycle = new LifecycleTracker(db);
  const approvals = new Approvals(db);
  const heartbeats = new Heartbeats(db);
  const contextBuilder = new ContextBuilder(db, memory, artifacts);
  const vault = env.OBSIDIAN_VAULT_PATH?.trim();
  let obsidian: ObsidianSync | null = null;
  contextBuilder.attach({ skills, knowledge });
  await memory.setIfAbsent('global', 'apexweb', 'rules', APEXWEB_GLOBAL_RULES, 'seed');
  const executor = new TaskExecutor({ db, config, queue, projects, provider, keyPool, memory, artifacts, contextBuilder, skills, cache, search, repos, lifecycle, fetchImpl: opts.researchFetchImpl });
  const defaultMode = (MODES.includes(env.APEXWEB_DEFAULT_MODE as Mode) ? env.APEXWEB_DEFAULT_MODE : 'semi') as Mode;
  const mainAgent = new MainAgent({ db, config, queue, projects, provider, memory, artifacts, skills, approvals, lifecycle, knowledge, repos, search, defaultMode, fetchImpl: opts.researchFetchImpl });
  const driver = config.executionDriver === 'n8n'
    ? new N8nDriver({ config, queue, executor, owner: config.workerId })
    : new InternalWorker({ queue, executor, main: mainAgent, owner: config.workerId, maxConcurrent: config.maxConcurrentTasks, heartbeats });
  mainAgent.driver = driver;
  const watchdog = new Watchdog({ db, queue, executor, main: mainAgent, cache });
  if (vault) {
    obsidian = new ObsidianSync({
      vault, hostVault: env.OBSIDIAN_VAULT_HOST_PATH?.trim() || null, db, queue, skills, knowledge,
      submit: async (message) => {
        const r = await mainAgent.receive({ message, actor: 'obsidian' });
        return { projectId: (r as any).project?.id ?? null, reply: (r as any).reply ?? '' };
      },
    });
    contextBuilder.attach({ skills, knowledge, obsidian });
  }
  const services: Services = {
    config, db, queue, projects, memory, artifacts, keyPool, router, client, provider, contextBuilder, executor, mainAgent, driver,
    skills, knowledge, cache, search, repos, lifecycle, approvals, heartbeats, watchdog, obsidian,
    extensions: { agents: agentExt, skills: skillLoad, templates: templatesLoaded, knowledge_seeded: seeded, tools: toolExt, qa_checks: qaExt, provider_models: registry.extensions },
    startedAt: new Date(),
  };
  attachCommands(services);
  return services;
}

/** Recovery after a restart: tasks that were mid-flight when the process died are re-queued via the failure path. */
export async function recoverAfterRestart(s: Services): Promise<{ reclaimed: number; resumedProjects: number }> {
  const { rows } = await s.db.query(`SELECT id FROM tasks WHERE status IN ('ASSIGNED', 'RUNNING', 'REVIEW') AND lease_owner = $1`, [s.config.workerId]);
  for (const r of rows) {
    await s.executor.fail(r.id, { errorClass: 'lease_expired', message: 'worker restarted while task was in flight' }, { actor: 'recovery' });
  }
  const reclaimed = rows.length + (await s.executor.reapExpired('recovery'));
  const expired = await s.keyPool.expireStaleLeases();
  const projects = await s.db.query(`SELECT id FROM projects WHERE status = 'RUNNING'`);
  for (const p of projects.rows) await s.queue.reconcile(p.id, 'recovery');
  const planning = await s.db.query(`SELECT id FROM projects WHERE status = 'PLANNING'`);
  for (const p of planning.rows) await s.driver.onProjectCreated(p.id);
  for (const p of projects.rows) await s.mainAgent.checkSettled(p.id);
  if (reclaimed || expired) log.info('recovered in-flight work after restart', { reclaimed, expired_leases: expired });
  return { reclaimed, resumedProjects: projects.rows.length + planning.rows.length };
}
