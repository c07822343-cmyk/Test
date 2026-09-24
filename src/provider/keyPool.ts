// NVIDIA Key Manager + hard rate limiter.
//
// Every NVIDIA request obtains a lease here first. Leases are granted inside a
// Postgres transaction that row-locks all key rows, counts the key's grants in
// the rolling window (DB clock), and inserts the new grant before committing.
// Because the count and the insert happen under the same lock, no interleaving
// of concurrent callers - in this process or any other replica - can push a key
// past its ceiling. When nothing is eligible the caller is told how long to
// wait; callers queue (FIFO within priority) rather than drop work.
import type { NvidiaKeyConfig } from '../config/env.ts';
import type { Db } from '../db/pool.ts';
import { withTransaction } from '../db/pool.ts';
import { maskSecret, registerSecret } from '../security/redact.ts';
import { backoffWithJitter, newId, sha256, sleep } from '../util/common.ts';
import { logger } from '../util/log.ts';
import type { KeySchedulingStrategy, KeySnapshot, KeyHealth } from './scheduling.ts';

const log = logger('keypool');

export type LeaseOutcomeStatus =
  | 'ok'
  | 'rate_limited'
  | 'server_error'
  | 'timeout'
  | 'network_error'
  | 'client_error'
  | 'auth_error'
  | 'model_unavailable'
  | 'cancelled';

export interface Lease {
  leaseId: string;
  keyId: string;
  model: string;
  grantedAt: Date;
  windowCountAfterGrant: number;
  ceiling: number;
}

export type LeaseDecision =
  | { granted: true; lease: Lease }
  | { granted: false; retryAfterMs: number; reason: 'capacity' | 'cooldown' | 'inflight' | 'fairness' | 'no_compatible_key' };

export interface AcquireOptions {
  model: string;
  requesterId: string;
  priority?: number;
  taskId?: string | null;
  purpose?: string;
  /** Restrict the grant to one key (health checks). Still subject to that key's ceiling and cooldown. */
  keyId?: string;
}

export interface KeyPoolOptions {
  rpmPerKey: number;
  windowMs: number;
  maxInflightPerKey: number;
  leaseTtlMs: number;
  strategy: KeySchedulingStrategy;
}

/** Holds credential secrets in process memory only. Nothing else can enumerate them. */
export class SecretVault {
  #secrets = new Map<string, string>();
  constructor(keys: NvidiaKeyConfig[]) {
    for (const k of keys) {
      this.#secrets.set(k.id, k.secret);
      registerSecret(k.secret);
    }
  }
  has(keyId: string): boolean {
    return this.#secrets.has(keyId);
  }
  reveal(keyId: string): string {
    const s = this.#secrets.get(keyId);
    if (!s) throw new Error(`No secret loaded for ${keyId}`);
    return s;
  }
  get size(): number {
    return this.#secrets.size;
  }
}

const REMOTE_WAITER_TTL_MS = 15_000;

interface Waiter {
  requesterId: string;
  priority: number;
  firstSeen: number;
  lastSeen: number;
  seq: number;
  model: string;
  taskId: string | null;
  purpose?: string;
  keyId?: string;
  /** Present for in-process callers parked in acquire(). */
  local?: { resolve(l: Lease): void; reject(e: Error): void; deadline: number; signal?: AbortSignal };
}

export class KeyPool {
  readonly vault: SecretVault;
  readonly opts: KeyPoolOptions;
  #db: Db;
  #keys: NvidiaKeyConfig[];
  #waiters = new Map<string, Waiter>();
  #seq = 0;
  #pumping = false;
  #wake: (() => void) | null = null;
  #sweeper: NodeJS.Timeout | null = null;

  constructor(db: Db, keys: NvidiaKeyConfig[], opts: KeyPoolOptions) {
    this.#db = db;
    this.#keys = keys;
    this.vault = new SecretVault(keys);
    this.opts = opts;
  }

  get strategyName(): string {
    return this.opts.strategy.name;
  }

  /** Registers configured keys (fingerprints only) and retires rows for keys no longer configured. */
  async sync(): Promise<void> {
    await withTransaction(this.#db, async (c) => {
      const configured = new Set<string>();
      for (const k of this.#keys) {
        configured.add(k.id);
        const fingerprint = sha256(k.secret).slice(0, 16);
        const existing = await c.query('SELECT fingerprint, active, disabled_reason FROM nvidia_keys WHERE id = $1', [k.id]);
        if (existing.rowCount === 0) {
          await c.query(
            `INSERT INTO nvidia_keys (id, slot, fingerprint, masked, active) VALUES ($1, $2, $3, $4, true)`,
            [k.id, k.slot, fingerprint, maskSecret(k.secret)],
          );
        } else {
          const row = existing.rows[0];
          const rotated = row.fingerprint !== fingerprint;
          // A rotated credential gets a clean slate; an unchanged one keeps an auth-failure disable.
          const keepDisabled = !rotated && row.active === false && row.disabled_reason === 'auth_failed';
          await c.query(
            `UPDATE nvidia_keys SET fingerprint = $2, masked = $3, slot = $4,
               active = $5, disabled_reason = CASE WHEN $5 THEN NULL ELSE disabled_reason END,
               consecutive_failures = CASE WHEN $6 THEN 0 ELSE consecutive_failures END,
               cooldown_until = CASE WHEN $6 THEN NULL ELSE cooldown_until END,
               updated_at = now()
             WHERE id = $1`,
            [k.id, fingerprint, maskSecret(k.secret), k.slot, !keepDisabled, rotated],
          );
        }
      }
      await c.query(
        `UPDATE nvidia_keys SET active = false, disabled_reason = 'not_configured', updated_at = now()
         WHERE NOT (id = ANY($1::text[]))`,
        [[...configured]],
      );
    });
  }

  startSweeper(intervalMs = 15_000): void {
    this.#sweeper = setInterval(() => {
      this.expireStaleLeases().catch((err) => log.warn('lease sweep failed', { error: String(err) }));
    }, intervalMs);
    this.#sweeper.unref();
  }

  stop(): void {
    if (this.#sweeper) clearInterval(this.#sweeper);
  }

  /** Leases that were never completed (crashed caller) stop counting as in-flight. They still count toward the window. */
  async expireStaleLeases(): Promise<number> {
    const r = await this.#db.query(
      `UPDATE key_requests SET status = 'expired', finished_at = clock_timestamp()
       WHERE status IN ('granted', 'in_flight') AND granted_at < clock_timestamp() - ($1::int * interval '1 millisecond')`,
      [this.opts.leaseTtlMs],
    );
    return r.rowCount ?? 0;
  }

  /** Builds live snapshots from the DB. `client` lets acquisition reuse its locked transaction. */
  async snapshots(client: { query: Db['query'] } = this.#db): Promise<KeySnapshot[]> {
    const { rows } = await client.query(
      `WITH now_ts AS (SELECT clock_timestamp() AS now)
       SELECT k.*,
         (SELECT now FROM now_ts) AS db_now,
         COALESCE(w.window_count, 0)::int AS window_count,
         w.oldest_in_window,
         COALESCE(f.inflight, 0)::int AS inflight,
         COALESCE(s.recent_requests, 0)::int AS recent_requests,
         COALESCE(s.recent_errors, 0)::int AS recent_errors,
         COALESCE(s.recent_429, 0)::int AS recent_429,
         COALESCE(s.recent_5xx, 0)::int AS recent_5xx,
         COALESCE(s.recent_timeouts, 0)::int AS recent_timeouts,
         s.latency_avg, s.latency_p50, s.latency_p95
       FROM nvidia_keys k
       LEFT JOIN LATERAL (
         SELECT count(*) AS window_count, min(granted_at) AS oldest_in_window
         FROM key_requests r
         WHERE r.key_id = k.id AND r.granted_at > (SELECT now FROM now_ts) - ($1::int * interval '1 millisecond')
       ) w ON true
       LEFT JOIN LATERAL (
         SELECT count(*) AS inflight FROM key_requests r
         WHERE r.key_id = k.id AND r.status IN ('granted', 'in_flight')
           AND r.granted_at > (SELECT now FROM now_ts) - ($2::int * interval '1 millisecond')
       ) f ON true
       LEFT JOIN LATERAL (
         SELECT count(*) FILTER (WHERE status NOT IN ('granted', 'in_flight')) AS recent_requests,
                count(*) FILTER (WHERE status IN ('rate_limited', 'server_error', 'timeout', 'network_error', 'auth_error')) AS recent_errors,
                count(*) FILTER (WHERE status = 'rate_limited') AS recent_429,
                count(*) FILTER (WHERE status = 'server_error') AS recent_5xx,
                count(*) FILTER (WHERE status = 'timeout') AS recent_timeouts,
                avg(latency_ms) FILTER (WHERE status = 'ok') AS latency_avg,
                percentile_cont(0.5) WITHIN GROUP (ORDER BY latency_ms) FILTER (WHERE status = 'ok') AS latency_p50,
                percentile_cont(0.95) WITHIN GROUP (ORDER BY latency_ms) FILTER (WHERE status = 'ok') AS latency_p95
         FROM key_requests r
         WHERE r.key_id = k.id AND r.granted_at > (SELECT now FROM now_ts) - interval '5 minutes'
       ) s ON true
       ORDER BY k.slot`,
      [this.opts.windowMs, this.opts.leaseTtlMs],
    );
    return rows.map((r) => this.#toSnapshot(r));
  }

  #toSnapshot(r: Record<string, any>): KeySnapshot {
    const now = new Date(r.db_now).getTime();
    const cooldownUntil = r.cooldown_until ? new Date(r.cooldown_until) : null;
    const cooldownRemainingMs = cooldownUntil ? Math.max(0, cooldownUntil.getTime() - now) : 0;
    const ceiling = this.opts.rpmPerKey;
    const windowCount = r.window_count as number;
    const recentRequests = r.recent_requests as number;
    const recentErrors = r.recent_errors as number;
    const errorRate = recentRequests > 0 ? recentErrors / recentRequests : 0;
    const cfg = this.#keys.find((k) => k.id === r.id);
    const active = r.active && this.vault.has(r.id);
    let health: KeyHealth = 'healthy';
    if (!active) health = 'disabled';
    else if (cooldownRemainingMs > 0) health = 'cooldown';
    else if (windowCount >= ceiling) health = 'exhausted';
    else if (r.consecutive_failures >= 2 || (recentRequests >= 5 && errorRate > 0.2)) health = 'degraded';
    return {
      id: r.id,
      slot: r.slot,
      masked: r.masked,
      active,
      disabledReason: r.disabled_reason ?? (this.vault.has(r.id) ? null : 'not_configured'),
      cooldownUntil,
      cooldownRemainingMs,
      ceiling,
      windowCount,
      remaining: Math.max(0, ceiling - windowCount),
      oldestInWindow: r.oldest_in_window ? new Date(r.oldest_in_window) : null,
      inflight: r.inflight,
      maxInflight: this.opts.maxInflightPerKey,
      lastUsedAt: r.last_used_at ? new Date(r.last_used_at) : null,
      consecutiveFailures: r.consecutive_failures,
      recentRequests,
      recentErrors,
      recent429: r.recent_429,
      recent5xx: r.recent_5xx,
      recentTimeouts: r.recent_timeouts,
      errorRate,
      latencyAvgMs: r.latency_avg == null ? null : Math.round(Number(r.latency_avg)),
      latencyP50Ms: r.latency_p50 == null ? null : Math.round(Number(r.latency_p50)),
      latencyP95Ms: r.latency_p95 == null ? null : Math.round(Number(r.latency_p95)),
      totalRequests: Number(r.total_requests),
      totalFailures: Number(r.total_failures),
      currentModel: r.current_model,
      allowedModels: cfg?.allowedModels ?? null,
      health,
    };
  }

  // ---------------------------------------------------------------------------
  // Wait queue. Local callers (acquire) park in an in-process queue served by a
  // single pump, so only one grant transaction per process is ever in flight -
  // waiting callers never pile onto the key-row locks. Remote pollers (n8n via
  // tryAcquire) join the same ordering and have capacity reserved for them.
  // ---------------------------------------------------------------------------

  #ordered(): Waiter[] {
    const now = Date.now();
    for (const [id, w] of this.#waiters) {
      if (!w.local && now - w.lastSeen > REMOTE_WAITER_TTL_MS) this.#waiters.delete(id);
    }
    return [...this.#waiters.values()].sort((a, b) => b.priority - a.priority || a.firstSeen - b.firstSeen || a.seq - b.seq);
  }

  forgetWaiter(requesterId: string): void {
    this.#waiters.delete(requesterId);
  }

  get waitingCount(): number {
    return this.#ordered().length;
  }

  #compatible(k: KeySnapshot, model: string): boolean {
    return k.active && (!k.allowedModels || k.allowedModels.includes(model));
  }

  /**
   * One locked pass over the queue in order. Every waiter ahead of (or equal
   * to) the targets consumes capacity; only targets receive real grants.
   * Returns grants plus a wait hint for targets that got nothing.
   */
  async #grantPass(isTarget: (w: Waiter) => boolean, stopAt?: string): Promise<{ grants: Map<string, Lease>; hints: Map<string, LeaseDecision & { granted: false }> }> {
    return withTransaction(this.#db, async (c) => {
      await c.query('SELECT id FROM nvidia_keys ORDER BY id FOR UPDATE');
      const snaps = await this.snapshots(c);
      const grants = new Map<string, Lease>();
      const hints = new Map<string, LeaseDecision & { granted: false }>();
      for (const w of this.#ordered()) {
        const compatible = snaps.filter((k) => this.#compatible(k, w.model) && (!w.keyId || k.id === w.keyId));
        const eligible = compatible.filter((k) => k.cooldownRemainingMs === 0 && k.windowCount < k.ceiling && k.inflight < k.maxInflight);
        if (eligible.length === 0) {
          if (isTarget(w)) {
            hints.set(w.requesterId, compatible.length === 0
              ? { granted: false, retryAfterMs: 0, reason: 'no_compatible_key' }
              : { granted: false, ...this.#waitHint(compatible) });
          }
        } else {
          const [chosen] = this.opts.strategy.rank(eligible, { model: w.model });
          // Consume the slot in the working snapshot whether granted now or reserved for a waiter ahead.
          chosen.windowCount++;
          chosen.remaining = Math.max(0, chosen.ceiling - chosen.windowCount);
          chosen.inflight++;
          if (isTarget(w)) {
            const leaseId = newId('lease');
            const ins = await c.query(
              `INSERT INTO key_requests (lease_id, key_id, granted_at, model, task_id, purpose, status)
               VALUES ($1, $2, clock_timestamp(), $3, $4, $5, 'granted') RETURNING granted_at`,
              [leaseId, chosen.id, w.model, w.taskId ?? null, w.purpose ?? null],
            );
            await c.query(
              `UPDATE nvidia_keys SET total_requests = total_requests + 1, last_used_at = clock_timestamp(),
                 current_model = $2, updated_at = now() WHERE id = $1`,
              [chosen.id, w.model],
            );
            grants.set(w.requesterId, {
              leaseId,
              keyId: chosen.id,
              model: w.model,
              grantedAt: new Date(ins.rows[0].granted_at),
              windowCountAfterGrant: chosen.windowCount,
              ceiling: chosen.ceiling,
            });
          }
        }
        if (stopAt && w.requesterId === stopAt) break;
      }
      return { grants, hints };
    });
  }

  #waitHint(compatible: KeySnapshot[]): { retryAfterMs: number; reason: 'capacity' | 'cooldown' | 'inflight' } {
    type WaitReason = 'capacity' | 'cooldown' | 'inflight';
    let best = Number.POSITIVE_INFINITY;
    let reason: WaitReason = 'capacity';
    for (const k of compatible) {
      let wait = 0;
      let why: WaitReason = 'capacity';
      if (k.cooldownRemainingMs > 0) {
        wait = k.cooldownRemainingMs;
        why = 'cooldown';
      }
      if (k.windowCount >= k.ceiling && k.oldestInWindow) {
        // The oldest grant leaves the rolling window at oldest + window.
        const leaves = k.oldestInWindow.getTime() + this.opts.windowMs - Date.now();
        if (leaves > wait) {
          wait = leaves;
          why = 'capacity';
        }
      }
      if (wait === 0 && k.inflight >= k.maxInflight) {
        wait = 500;
        why = 'inflight';
      }
      if (wait < best) {
        best = wait;
        reason = why;
      }
    }
    return { retryAfterMs: Math.max(50, Math.ceil(Number.isFinite(best) ? best : 1_000)), reason };
  }

  /**
   * Non-blocking attempt, used by n8n (which renders the wait visibly). The
   * caller keeps its place in line between polls as long as it polls within
   * REMOTE_WAITER_TTL_MS.
   */
  async tryAcquire(opts: AcquireOptions): Promise<LeaseDecision> {
    const now = Date.now();
    const existing = this.#waiters.get(opts.requesterId);
    if (existing) {
      existing.lastSeen = now;
      existing.priority = opts.priority ?? existing.priority;
      existing.model = opts.model;
      existing.taskId = opts.taskId ?? existing.taskId;
    } else {
      this.#waiters.set(opts.requesterId, {
        requesterId: opts.requesterId, priority: opts.priority ?? 50, firstSeen: now, lastSeen: now, seq: this.#seq++,
        model: opts.model, taskId: opts.taskId ?? null, purpose: opts.purpose, keyId: opts.keyId,
      });
    }
    const { grants, hints } = await this.#grantPass((w) => w.requesterId === opts.requesterId, opts.requesterId);
    const lease = grants.get(opts.requesterId);
    if (lease) {
      this.#waiters.delete(opts.requesterId);
      return { granted: true, lease };
    }
    const hint = hints.get(opts.requesterId);
    if (hint?.reason === 'no_compatible_key') this.#waiters.delete(opts.requesterId);
    // No hint means capacity exists but callers ahead of us have it reserved.
    return hint ?? { granted: false, retryAfterMs: 250, reason: 'fairness' };
  }

  /** Blocking acquisition: parks in the queue (never dropped) until granted, aborted or maxWaitMs elapses. */
  acquire(opts: AcquireOptions & { maxWaitMs: number; signal?: AbortSignal }): Promise<Lease> {
    opts.signal?.throwIfAborted();
    return new Promise<Lease>((resolve, reject) => {
      const now = Date.now();
      const requesterId = this.#waiters.has(opts.requesterId) ? `${opts.requesterId}#${this.#seq}` : opts.requesterId;
      const waiter: Waiter = {
        requesterId, priority: opts.priority ?? 50, firstSeen: now, lastSeen: now, seq: this.#seq++,
        model: opts.model, taskId: opts.taskId ?? null, purpose: opts.purpose, keyId: opts.keyId,
        local: { resolve, reject, deadline: now + opts.maxWaitMs, signal: opts.signal },
      };
      this.#waiters.set(requesterId, waiter);
      opts.signal?.addEventListener('abort', () => {
        if (this.#waiters.get(requesterId) === waiter) {
          this.#waiters.delete(requesterId);
          reject(opts.signal?.reason ?? new Error('aborted'));
        }
      }, { once: true });
      this.#kick();
    });
  }

  #kick(): void {
    if (this.#pumping) {
      this.#wake?.();
      return;
    }
    this.#pumping = true;
    void this.#pump().finally(() => {
      this.#pumping = false;
      if ([...this.#waiters.values()].some((w) => w.local)) this.#kick();
    });
  }

  async #pump(): Promise<void> {
    let failures = 0;
    for (;;) {
      const now = Date.now();
      for (const w of [...this.#waiters.values()]) {
        if (w.local && now > w.local.deadline) {
          this.#waiters.delete(w.requesterId);
          w.local.reject(new KeyPoolError('capacity_timeout', `Waited ${Math.round((now - w.firstSeen) / 1000)}s for NVIDIA capacity`));
        }
      }
      if (![...this.#waiters.values()].some((w) => w.local)) return;
      let grants: Map<string, Lease>;
      let hints: Map<string, LeaseDecision & { granted: false }>;
      try {
        ({ grants, hints } = await this.#grantPass((w) => !!w.local));
        failures = 0;
      } catch (err) {
        log.error('grant pass failed', { error: String((err as Error)?.message ?? err) });
        await sleep(Math.min(5_000, 200 * 2 ** failures++));
        continue;
      }
      for (const [id, lease] of grants) {
        const w = this.#waiters.get(id);
        this.#waiters.delete(id);
        w?.local?.resolve(lease);
      }
      let nextWait = Number.POSITIVE_INFINITY;
      for (const [id, hint] of hints) {
        const w = this.#waiters.get(id);
        if (!w?.local) continue;
        if (hint.reason === 'no_compatible_key') {
          this.#waiters.delete(id);
          w.local.reject(new KeyPoolError('no_compatible_key', `No active NVIDIA key can serve model ${w.model}`));
        } else nextWait = Math.min(nextWait, hint.retryAfterMs);
      }
      if (grants.size === 0) {
        // Nothing grantable: sleep until capacity is expected back (or a lease completes / new waiter arrives).
        const wait = Math.min(Number.isFinite(nextWait) ? nextWait : 250, 2_000) + Math.floor(Math.random() * 25);
        await new Promise<void>((resolve) => {
          const t = setTimeout(resolve, wait);
          this.#wake = () => {
            clearTimeout(t);
            resolve();
          };
        });
        this.#wake = null;
      }
    }
  }

  async markInFlight(leaseId: string): Promise<void> {
    await this.#db.query(`UPDATE key_requests SET status = 'in_flight' WHERE lease_id = $1 AND status = 'granted'`, [leaseId]);
  }

  /** Records the outcome of a leased request and updates key health / cooldown. */
  async complete(
    lease: Pick<Lease, 'leaseId' | 'keyId'>,
    outcome: { status: LeaseOutcomeStatus; httpStatus?: number | null; latencyMs?: number | null; error?: string | null; retryAfterMs?: number | null; usage?: unknown },
  ): Promise<void> {
    const dbStatus = outcome.status === 'model_unavailable' ? 'client_error' : outcome.status === 'cancelled' ? 'expired' : outcome.status;
    await withTransaction(this.#db, async (c) => {
      const upd = await c.query(
        `UPDATE key_requests SET status = $2, http_status = $3, latency_ms = $4, finished_at = clock_timestamp(),
           error = $5, usage = $6 WHERE lease_id = $1 AND status IN ('granted', 'in_flight') RETURNING key_id`,
        [lease.leaseId, dbStatus, outcome.httpStatus ?? null, outcome.latencyMs ?? null, outcome.error?.slice(0, 500) ?? null, outcome.usage ? JSON.stringify(outcome.usage) : null],
      );
      if (upd.rowCount === 0) return;
      queueMicrotask(() => this.#wake?.());
      const key = await c.query('SELECT consecutive_failures FROM nvidia_keys WHERE id = $1 FOR UPDATE', [lease.keyId]);
      const failures = (key.rows[0]?.consecutive_failures ?? 0) as number;
      switch (outcome.status) {
        case 'ok':
          await c.query(`UPDATE nvidia_keys SET consecutive_failures = 0, last_error = NULL, updated_at = now() WHERE id = $1`, [lease.keyId]);
          break;
        case 'rate_limited': {
          // Honour provider Retry-After; otherwise back off exponentially with jitter.
          const cooldown = Math.max(outcome.retryAfterMs ?? 0, backoffWithJitter(failures + 1, 5_000, 120_000));
          await c.query(
            `UPDATE nvidia_keys SET consecutive_failures = consecutive_failures + 1, total_failures = total_failures + 1,
               total_429 = total_429 + 1, cooldown_until = clock_timestamp() + ($2::int * interval '1 millisecond'),
               last_error = $3, updated_at = now() WHERE id = $1`,
            [lease.keyId, cooldown, 'HTTP 429 rate limited'],
          );
          log.warn('key rate limited by provider; cooling down', { key: lease.keyId, cooldown_ms: cooldown });
          break;
        }
        case 'server_error':
        case 'timeout':
        case 'network_error': {
          const next = failures + 1;
          // Circuit breaker: after repeated transient failures, rest the key briefly.
          const cooldown = next >= 3 ? backoffWithJitter(next - 2, 10_000, 300_000) : 0;
          await c.query(
            `UPDATE nvidia_keys SET consecutive_failures = consecutive_failures + 1, total_failures = total_failures + 1,
               total_5xx = total_5xx + $2, total_timeouts = total_timeouts + $3,
               cooldown_until = CASE WHEN $4 > 0 THEN clock_timestamp() + ($4::int * interval '1 millisecond') ELSE cooldown_until END,
               last_error = $5, updated_at = now() WHERE id = $1`,
            [lease.keyId, outcome.status === 'server_error' ? 1 : 0, outcome.status === 'timeout' ? 1 : 0, cooldown, outcome.error?.slice(0, 300) ?? outcome.status],
          );
          break;
        }
        case 'auth_error':
          await c.query(
            `UPDATE nvidia_keys SET active = false, disabled_reason = 'auth_failed', total_failures = total_failures + 1,
               last_error = $2, updated_at = now() WHERE id = $1`,
            [lease.keyId, `HTTP ${outcome.httpStatus ?? 401} authentication failed`],
          );
          log.error('NVIDIA key rejected by provider and disabled', { key: lease.keyId });
          break;
        default:
          // client_error / model_unavailable / cancelled are not the credential's fault.
          break;
      }
    });
  }

  async setActive(keyId: string, active: boolean, reason: string | null): Promise<void> {
    await this.#db.query(
      `UPDATE nvidia_keys SET active = $2, disabled_reason = $3, consecutive_failures = CASE WHEN $2 THEN 0 ELSE consecutive_failures END,
         cooldown_until = CASE WHEN $2 THEN NULL ELSE cooldown_until END, updated_at = now() WHERE id = $1`,
      [keyId, active, active ? null : reason ?? 'operator_disabled'],
    );
  }
}

export class KeyPoolError extends Error {
  readonly code: 'no_compatible_key' | 'capacity_timeout';
  constructor(code: 'no_compatible_key' | 'capacity_timeout', message: string) {
    super(message);
    this.code = code;
  }
}
