// Heartbeats + watchdog. Workers (core, internal worker, n8n) report liveness;
// tasks carry a heartbeat refreshed during long steps. The watchdog detects:
//   - dead / disconnected workers  -> their in-flight tasks are orphaned and recovered
//   - stuck tasks (no heartbeat)    -> treated as a timed-out attempt (retry path)
//   - orphaned claims (assigned, never started, e.g. a lost n8n execution) -> released
//   - timed-out tasks (execution lease expired) -> retry path (reaper)
//   - projects whose graph settled while nobody was listening -> settlement
// Every recovery is a recorded event, so it appears in the activity feed.
import type { Db } from '../db/pool.ts';
import type { MainAgent } from '../orchestrator/mainAgent.ts';
import type { TaskQueue } from '../queue/taskQueue.ts';
import type { CacheStore } from '../cache/cache.ts';
import { errorMessage, logger } from '../util/log.ts';
import type { TaskExecutor } from './executor.ts';

const log = logger('watchdog');

export class Heartbeats {
  #db: Db;
  constructor(db: Db) {
    this.#db = db;
  }

  async beat(id: string, kind: string, inflight = 0, meta?: Record<string, unknown>): Promise<void> {
    await this.#db.query(
      `INSERT INTO workers (id, kind, status, last_seen_at, inflight, meta) VALUES ($1, $2, 'alive', now(), $3, $4)
       ON CONFLICT (id) DO UPDATE SET kind = EXCLUDED.kind, status = 'alive', last_seen_at = now(), inflight = EXCLUDED.inflight, meta = COALESCE(EXCLUDED.meta, workers.meta)`,
      [id, kind, inflight, meta ? JSON.stringify(meta) : null],
    );
  }

  async list() {
    const { rows } = await this.#db.query(`SELECT *, extract(epoch FROM now() - last_seen_at)::int AS seconds_since_seen FROM workers ORDER BY kind, id`);
    return rows;
  }
}

export interface WatchdogOptions {
  deadWorkerMs: number;
  stuckTaskMs: number;
  orphanClaimMs: number;
}

export class Watchdog {
  #db: Db;
  #queue: TaskQueue;
  #executor: TaskExecutor;
  #main: MainAgent;
  #cache: CacheStore;
  #opts: WatchdogOptions;
  #timer: NodeJS.Timeout | null = null;
  lastRun: { at: Date; recovered: Record<string, number> } | null = null;

  constructor(deps: { db: Db; queue: TaskQueue; executor: TaskExecutor; main: MainAgent; cache: CacheStore }, opts: Partial<WatchdogOptions> = {}) {
    this.#db = deps.db;
    this.#queue = deps.queue;
    this.#executor = deps.executor;
    this.#main = deps.main;
    this.#cache = deps.cache;
    this.#opts = { deadWorkerMs: 90_000, stuckTaskMs: 6 * 60_000, orphanClaimMs: 3 * 60_000, ...opts };
  }

  start(intervalMs = 30_000): void {
    this.#timer = setInterval(() => void this.run().catch((err) => log.warn('watchdog run failed', { error: errorMessage(err) })), intervalMs);
    this.#timer.unref();
  }

  stop(): void {
    if (this.#timer) clearInterval(this.#timer);
  }

  async run(): Promise<Record<string, number>> {
    const recovered = { dead_workers: 0, orphaned_tasks: 0, stuck_tasks: 0, released_claims: 0, expired_leases: 0, settled_projects: 0, cache_purged: 0 };
    // Dead / disconnected workers.
    const dead = await this.#db.query(
      `UPDATE workers SET status = 'dead' WHERE status = 'alive' AND kind <> 'n8n' AND last_seen_at < now() - ($1::int * interval '1 millisecond') RETURNING id`,
      [this.#opts.deadWorkerMs],
    );
    recovered.dead_workers = dead.rowCount ?? 0;
    for (const w of dead.rows) {
      const { rows } = await this.#db.query(`SELECT id FROM tasks WHERE lease_owner = $1 AND status IN ('ASSIGNED', 'RUNNING', 'REVIEW')`, [w.id]);
      for (const t of rows) {
        await this.#recover(t.id, 'orphaned', `worker ${w.id} stopped sending heartbeats`);
        recovered.orphaned_tasks++;
      }
    }
    // Stuck tasks: executing but no heartbeat for too long.
    const stuck = await this.#db.query(
      `SELECT id FROM tasks WHERE status IN ('RUNNING', 'REVIEW') AND COALESCE(heartbeat_at, updated_at) < now() - ($1::int * interval '1 millisecond')`,
      [this.#opts.stuckTaskMs],
    );
    for (const t of stuck.rows) {
      await this.#recover(t.id, 'stuck', `no heartbeat for ${Math.round(this.#opts.stuckTaskMs / 60000)} minutes`);
      recovered.stuck_tasks++;
    }
    // Claimed but never started (lost dispatcher execution): safe to hand back untouched.
    const orphanClaims = await this.#db.query(
      `SELECT id, status FROM tasks WHERE status = 'ASSIGNED' AND updated_at < now() - ($1::int * interval '1 millisecond')`,
      [this.#opts.orphanClaimMs],
    );
    for (const t of orphanClaims.rows) {
      try {
        const task = await this.#queue.transition(t.id, ['ASSIGNED'], 'QUEUED', { lease_owner: null, lease_expires_at: null }, { type: 'watchdog_released_claim', actor: 'watchdog', detail: { reason: 'claimed but never started' } });
        this.#queue.emit('tasks_ready', { projectId: task.project_id });
        recovered.released_claims++;
      } catch {
        /* moved on concurrently */
      }
    }
    recovered.expired_leases = await this.#executor.reapExpired('watchdog');
    // Projects that settled while no event handler was listening.
    const { rows: projects } = await this.#db.query(`SELECT id FROM projects WHERE status = 'RUNNING'`);
    for (const p of projects) {
      const pr = await this.#queue.projectProgress(p.id);
      if (pr.active === 0) {
        await this.#main.checkSettled(p.id);
        recovered.settled_projects++;
      }
    }
    recovered.cache_purged = await this.#cache.purgeExpired();
    this.lastRun = { at: new Date(), recovered };
    if (Object.entries(recovered).some(([k, v]) => v > 0 && k !== 'cache_purged')) log.warn('watchdog recovered work', recovered);
    return recovered;
  }

  async #recover(taskId: string, kind: 'stuck' | 'orphaned', reason: string): Promise<void> {
    const t = await this.#queue.find(taskId);
    if (!t) return;
    await this.#queue.recordEvent(this.#db, t, `watchdog_${kind}`, t.status, t.status, 'watchdog', { reason });
    await this.#executor.fail(taskId, { errorClass: 'lease_expired', message: `watchdog: ${reason}` }, { actor: 'watchdog' });
  }
}
