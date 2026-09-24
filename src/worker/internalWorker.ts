// Internal execution driver: claims ready tasks and runs them through the
// executor's steps in-process. Used for headless operation and tests; the n8n
// driver runs the same steps as visible workflow nodes.
import type { MainAgent, ExecutionDriver } from '../orchestrator/mainAgent.ts';
import type { TaskQueue } from '../queue/taskQueue.ts';
import { errorMessage, logger } from '../util/log.ts';
import type { TaskExecutor } from './executor.ts';

const log = logger('internal-worker');

export class InternalWorker implements ExecutionDriver {
  readonly kind = 'internal' as const;
  #queue: TaskQueue;
  #executor: TaskExecutor;
  #main: MainAgent;
  #owner: string;
  #max: number;
  #inflight = new Map<string, AbortController>();
  #timer: NodeJS.Timeout | null = null;
  #reaper: NodeJS.Timeout | null = null;
  #pumping = false;
  #again = false;
  #stopped = true;

  constructor(opts: { queue: TaskQueue; executor: TaskExecutor; main: MainAgent; owner: string; maxConcurrent: number }) {
    this.#queue = opts.queue;
    this.#executor = opts.executor;
    this.#main = opts.main;
    this.#owner = opts.owner;
    this.#max = opts.maxConcurrent;
  }

  async onProjectCreated(projectId: string): Promise<void> {
    void this.#main.planProject(projectId);
  }

  async onProjectSettled(projectId: string): Promise<void> {
    try {
      await this.#main.assemble(projectId, this.#owner);
    } catch (err) {
      log.error('assembly failed', { project: projectId, error: errorMessage(err) });
    }
  }

  start(pollMs = 1_000): void {
    this.#stopped = false;
    this.#queue.on('tasks_ready', this.#onReady);
    this.#queue.on('task_cancelled', this.#onCancelled);
    this.#timer = setInterval(() => this.pump(), pollMs);
    this.#reaper = setInterval(() => {
      this.#executor.reapExpired(this.#owner).catch((err) => log.warn('reaper failed', { error: errorMessage(err) }));
    }, 30_000);
    this.pump();
  }

  #onReady = () => this.pump();
  #onCancelled = ({ taskId }: { taskId: string }) => this.#inflight.get(taskId)?.abort(new Error('task cancelled'));

  get inflight(): number {
    return this.#inflight.size;
  }

  /** Claims as many ready tasks as there are free slots and starts them. */
  pump(): void {
    if (this.#stopped) return;
    if (this.#pumping) {
      this.#again = true;
      return;
    }
    this.#pumping = true;
    void (async () => {
      try {
        do {
          this.#again = false;
          const free = this.#max - this.#inflight.size;
          if (free <= 0) break;
          const claimed = await this.#queue.claimReady(this.#owner, free);
          for (const task of claimed) {
            const ac = new AbortController();
            this.#inflight.set(task.id, ac);
            void this.#executor
              .runClaimed(task, { actor: this.#owner }, ac.signal)
              .catch((err) => log.error('task execution crashed', { task: task.id, error: errorMessage(err) }))
              .finally(() => {
                this.#inflight.delete(task.id);
                this.pump();
              });
          }
          if (claimed.length === free) this.#again = true;
        } while (this.#again && !this.#stopped);
      } catch (err) {
        log.error('claim failed', { error: errorMessage(err) });
      } finally {
        this.#pumping = false;
      }
    })();
  }

  /** Graceful stop: no new claims; running tasks are aborted and their leases expire into a retry. */
  async stop(opts: { abort?: boolean; timeoutMs?: number } = {}): Promise<void> {
    this.#stopped = true;
    if (this.#timer) clearInterval(this.#timer);
    if (this.#reaper) clearInterval(this.#reaper);
    this.#queue.off('tasks_ready', this.#onReady);
    this.#queue.off('task_cancelled', this.#onCancelled);
    if (opts.abort) for (const ac of this.#inflight.values()) ac.abort(new Error('worker stopping'));
    const deadline = Date.now() + (opts.timeoutMs ?? 30_000);
    while (this.#inflight.size && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
  }
}
