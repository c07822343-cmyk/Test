// n8n execution driver: the core owns state and the step functions; n8n owns
// *driving* them. The core only nudges n8n through authenticated webhooks:
//   - a new project        -> Main Agent Orchestrator workflow (interpret/plan/enqueue)
//   - tasks became ready   -> Agent Dispatcher workflow (claim + fan out to pipelines)
//   - project settled      -> Final Assembly workflow
// A scheduled dispatcher run in n8n is the safety net if a nudge is lost.
import type { AppConfig } from '../config/env.ts';
import type { ExecutionDriver } from '../orchestrator/mainAgent.ts';
import type { TaskQueue } from '../queue/taskQueue.ts';
import { errorMessage, logger } from '../util/log.ts';
import type { TaskExecutor } from './executor.ts';

const log = logger('n8n-driver');

export class N8nDriver implements ExecutionDriver {
  readonly kind = 'n8n' as const;
  #config: AppConfig;
  #queue: TaskQueue;
  #executor: TaskExecutor;
  #owner: string;
  #debounce: NodeJS.Timeout | null = null;
  #reaper: NodeJS.Timeout | null = null;
  #fetch: typeof fetch;
  lastError: string | null = null;
  sent = { dispatch: 0, orchestrate: 0, assemble: 0, failures: 0 };

  constructor(opts: { config: AppConfig; queue: TaskQueue; executor: TaskExecutor; owner: string; fetchImpl?: typeof fetch }) {
    if (!opts.config.n8n.baseUrl || !opts.config.n8n.webhookSecret) {
      throw new Error('EXECUTION_DRIVER=n8n requires N8N_BASE_URL and N8N_WEBHOOK_SECRET');
    }
    this.#config = opts.config;
    this.#queue = opts.queue;
    this.#executor = opts.executor;
    this.#owner = opts.owner;
    this.#fetch = opts.fetchImpl ?? fetch;
  }

  start(): void {
    this.#queue.on('tasks_ready', this.#onReady);
    this.#reaper = setInterval(() => {
      this.#executor.reapExpired(this.#owner).catch((err) => log.warn('reaper failed', { error: errorMessage(err) }));
    }, 30_000);
  }

  async stop(): Promise<void> {
    this.#queue.off('tasks_ready', this.#onReady);
    if (this.#reaper) clearInterval(this.#reaper);
    if (this.#debounce) clearTimeout(this.#debounce);
  }

  #onReady = () => {
    if (this.#debounce) return;
    this.#debounce = setTimeout(() => {
      this.#debounce = null;
      void this.#post(this.#config.n8n.dispatchWebhookPath, { reason: 'tasks_ready' }, 'dispatch');
    }, 250);
  };

  async onProjectCreated(projectId: string): Promise<void> {
    await this.#post('apexweb/orchestrate', { project_id: projectId }, 'orchestrate');
  }

  async onProjectSettled(projectId: string): Promise<void> {
    await this.#post(this.#config.n8n.assemblyWebhookPath, { project_id: projectId }, 'assemble');
  }

  async #post(pathname: string, body: unknown, kind: 'dispatch' | 'orchestrate' | 'assemble'): Promise<void> {
    const url = `${this.#config.n8n.baseUrl}/webhook/${pathname}`;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const res = await this.#fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-ApexWeb-Webhook-Secret': this.#config.n8n.webhookSecret! },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(10_000),
        });
        if (res.ok) {
          this.sent[kind]++;
          this.lastError = null;
          return;
        }
        this.lastError = `n8n webhook ${pathname} returned HTTP ${res.status}`;
      } catch (err) {
        this.lastError = `n8n webhook ${pathname} failed: ${errorMessage(err)}`;
      }
      await new Promise((r) => setTimeout(r, 500 * attempt));
    }
    this.sent.failures++;
    log.error('could not reach n8n; the scheduled dispatcher will pick work up', { error: this.lastError });
  }
}
