// Composition root: builds every component from configuration.
import { validateRegistry } from './agents/registry.ts';
import { APEXWEB_GLOBAL_RULES } from './agents/globalRules.ts';
import type { AppConfig } from './config/env.ts';
import { migrate } from './db/migrate.ts';
import { createPool, type Db } from './db/pool.ts';
import { ArtifactStore } from './memory/artifacts.ts';
import { MemoryStore } from './memory/memory.ts';
import { ContextBuilder } from './orchestrator/contextBuilder.ts';
import { MainAgent } from './orchestrator/mainAgent.ts';
import { KeyPool } from './provider/keyPool.ts';
import { loadModelRegistry } from './provider/modelRegistry.ts';
import { ModelRouter } from './provider/modelRouter.ts';
import { NvidiaClient } from './provider/nvidiaClient.ts';
import { NvidiaProvider } from './provider/provider.ts';
import { createStrategy } from './provider/scheduling.ts';
import { ProjectStore } from './queue/projects.ts';
import { TaskQueue } from './queue/taskQueue.ts';
import { registerSecret } from './security/redact.ts';
import { logger } from './util/log.ts';
import { TaskExecutor } from './worker/executor.ts';
import { InternalWorker } from './worker/internalWorker.ts';
import { N8nDriver } from './worker/n8nDriver.ts';

const log = logger('services');

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
  startedAt: Date;
}

export async function createServices(config: AppConfig, opts: { fetchImpl?: typeof fetch; researchFetchImpl?: typeof fetch; db?: Db } = {}): Promise<Services> {
  validateRegistry();
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
  const router = new ModelRouter(db, loadModelRegistry(config.nvidia.modelsFile));
  await router.load();
  const client = new NvidiaClient({ baseUrl: config.nvidia.baseUrl, timeoutMs: config.nvidia.requestTimeoutMs, vault: keyPool.vault, fetchImpl: opts.fetchImpl });
  const provider = new NvidiaProvider({ db, keyPool, router, client, maxLeaseWaitMs: config.nvidia.maxLeaseWaitMs });
  const contextBuilder = new ContextBuilder(db, memory, artifacts);
  // Seed global memory; operator edits are preserved.
  await memory.setIfAbsent('global', 'apexweb', 'rules', APEXWEB_GLOBAL_RULES, 'seed');
  const executor = new TaskExecutor({ db, config, queue, projects, provider, keyPool, memory, artifacts, contextBuilder, fetchImpl: opts.researchFetchImpl });
  const mainAgent = new MainAgent({ db, config, queue, projects, provider, memory, artifacts, fetchImpl: opts.researchFetchImpl });
  const driver = config.executionDriver === 'n8n'
    ? new N8nDriver({ config, queue, executor, owner: config.workerId })
    : new InternalWorker({ queue, executor, main: mainAgent, owner: config.workerId, maxConcurrent: config.maxConcurrentTasks });
  mainAgent.driver = driver;
  return { config, db, queue, projects, memory, artifacts, keyPool, router, client, provider, contextBuilder, executor, mainAgent, driver, startedAt: new Date() };
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
  // Projects that were mid-planning resume planning.
  const planning = await s.db.query(`SELECT id FROM projects WHERE status = 'PLANNING'`);
  for (const p of planning.rows) await s.driver.onProjectCreated(p.id);
  // Projects whose graph finished while we were down get assembled.
  for (const p of projects.rows) await s.mainAgent.checkSettled(p.id);
  if (reclaimed || expired) log.info('recovered in-flight work after restart', { reclaimed, expired_leases: expired });
  return { reclaimed, resumedProjects: projects.rows.length + planning.rows.length };
}
