// Provider abstraction. Callers use requestModel({ capability | model, messages, ... })
// and never learn which credential served them. This layer owns key leasing,
// rate limiting, retries with jittered backoff, cooldowns, model fallback and
// request metrics.
import type { Db } from '../db/pool.ts';
import { backoffWithJitter, sleep } from '../util/common.ts';
import { logger } from '../util/log.ts';
import { KeyPool, KeyPoolError, type Lease } from './keyPool.ts';
import type { Capability, ModelSpec } from './modelRegistry.ts';
import { ModelRouter, ModelUnavailableError } from './modelRouter.ts';
import { NvidiaClient, type ChatMessage, type ChatFailure, type ChatSuccess } from './nvidiaClient.ts';

const log = logger('provider');

export interface ModelRequest {
  capability?: Capability;
  model?: string;
  messages: ChatMessage[];
  tools?: unknown[];
  temperature?: number;
  maxTokens?: number;
  metadata?: { taskId?: string | null; projectId?: string | null; purpose?: string; priority?: number; requesterId?: string };
  signal?: AbortSignal;
  maxAttempts?: number;
}

export interface ModelResponse {
  content: string;
  toolCalls: unknown[] | null;
  model: string;
  keyId: string;
  leaseId: string;
  usage: ChatSuccess['usage'];
  latencyMs: number;
  attempts: number;
  finishReason: string | null;
}

export class ProviderError extends Error {
  readonly errorClass: string;
  readonly retryable: boolean;
  readonly httpStatus: number | null;
  constructor(errorClass: string, message: string, retryable: boolean, httpStatus: number | null = null) {
    super(message);
    this.errorClass = errorClass;
    this.retryable = retryable;
    this.httpStatus = httpStatus;
  }
}

export type InvokeResult =
  | { ok: true; response: ModelResponse }
  | { ok: false; errorClass: ChatFailure['status'] | 'lease_invalid'; message: string; httpStatus: number | null; retryAfterMs: number | null; model: string; keyId: string | null };

export class NvidiaProvider {
  readonly keyPool: KeyPool;
  readonly router: ModelRouter;
  readonly client: NvidiaClient;
  readonly maxLeaseWaitMs: number;
  #db: Db;

  constructor(opts: { db: Db; keyPool: KeyPool; router: ModelRouter; client: NvidiaClient; maxLeaseWaitMs: number }) {
    this.#db = opts.db;
    this.keyPool = opts.keyPool;
    this.router = opts.router;
    this.client = opts.client;
    this.maxLeaseWaitMs = opts.maxLeaseWaitMs;
  }

  resolveCandidates(req: Pick<ModelRequest, 'capability' | 'model' | 'messages'>): ModelSpec[] {
    const needsVision = req.messages.some((m) => Array.isArray(m.content) && m.content.some((p) => p.type === 'image_url'));
    if (req.model && !req.capability) {
      const spec = this.router.get(req.model);
      if (!spec || !this.router.isAvailable(spec.id)) throw new ModelUnavailableError(`Model ${req.model} is not available`);
      return [spec];
    }
    return this.router.candidates({ capability: req.capability ?? (needsVision ? 'vision' : 'reasoning'), vision: needsVision, prefer: req.model ?? null });
  }

  /**
   * Performs one NVIDIA call with an already-granted lease. Used by the task
   * executor (internal driver and n8n driver alike) so that every attempt is
   * visible as its own step; requestModel() composes it with retries.
   */
  async invokeWithLease(lease: Lease, req: ModelRequest): Promise<InvokeResult> {
    const spec = this.router.get(lease.model);
    if (!spec) return { ok: false, errorClass: 'model_unavailable', message: `Unknown model ${lease.model}`, httpStatus: null, retryAfterMs: null, model: lease.model, keyId: lease.keyId };
    await this.keyPool.markInFlight(lease.leaseId);
    const result = await this.client.chat(lease.keyId, spec, {
      messages: req.messages,
      temperature: req.temperature,
      max_tokens: req.maxTokens,
      tools: req.tools,
    }, req.signal);
    if (result.ok) {
      await this.keyPool.complete(lease, { status: 'ok', httpStatus: result.httpStatus, latencyMs: result.latencyMs, usage: result.usage });
      await this.router.markAvailable(spec.id);
      return {
        ok: true,
        response: {
          content: result.content,
          toolCalls: result.toolCalls,
          model: spec.id,
          keyId: lease.keyId,
          leaseId: lease.leaseId,
          usage: result.usage,
          latencyMs: result.latencyMs,
          attempts: 1,
          finishReason: result.finishReason,
        },
      };
    }
    await this.keyPool.complete(lease, {
      status: result.status,
      httpStatus: result.httpStatus,
      latencyMs: result.latencyMs,
      error: result.message,
      retryAfterMs: result.retryAfterMs,
    });
    if (result.status === 'model_unavailable') await this.router.markUnavailable(spec.id, result.message);
    return { ok: false, errorClass: result.status, message: result.message, httpStatus: result.httpStatus, retryAfterMs: result.retryAfterMs, model: spec.id, keyId: lease.keyId };
  }

  /** The provider interface used by the Main Agent and anything else that needs a completion. */
  async requestModel(req: ModelRequest): Promise<ModelResponse> {
    const maxAttempts = req.maxAttempts ?? 3;
    const requesterId = req.metadata?.requesterId ?? `req:${Math.random().toString(36).slice(2)}`;
    let candidates = this.resolveCandidates(req);
    if (candidates.length === 0) throw new ProviderError('model_unavailable', `No NVIDIA model available for ${req.capability ?? req.model}`, false);

    let attempts = 0;
    let transientFailures = 0;
    let keySwitches = 0;
    let lastError: InvokeResult | null = null;
    while (candidates.length > 0) {
      const spec = candidates[0];
      let lease: Lease;
      try {
        lease = await this.keyPool.acquire({
          model: spec.id,
          requesterId,
          priority: req.metadata?.priority,
          taskId: req.metadata?.taskId ?? null,
          purpose: req.metadata?.purpose,
          maxWaitMs: this.maxLeaseWaitMs,
          signal: req.signal,
        });
      } catch (err) {
        if (err instanceof KeyPoolError && err.code === 'no_compatible_key') {
          candidates = candidates.slice(1);
          continue;
        }
        if (err instanceof KeyPoolError) throw new ProviderError('capacity_timeout', err.message, true);
        throw err;
      }
      attempts++;
      if (req.metadata?.projectId) {
        await this.#db.query('UPDATE key_requests SET project_id = $2, agent_type = $3 WHERE lease_id = $1', [lease.leaseId, req.metadata.projectId, req.metadata.purpose ?? null]);
      }
      const result = await this.invokeWithLease(lease, req);
      if (result.ok) return { ...result.response, attempts };
      lastError = result;
      log.warn('model call failed', { model: spec.id, key: lease.keyId, error_class: result.errorClass, attempt: attempts, purpose: req.metadata?.purpose });
      switch (result.errorClass) {
        case 'model_unavailable':
          candidates = candidates.slice(1);
          continue;
        case 'rate_limited':
        case 'auth_error':
          // Key already cooled down / disabled by the pool; the next lease goes to another eligible key.
          if (++keySwitches > 8) throw new ProviderError(result.errorClass, result.message, true, result.httpStatus);
          continue;
        case 'server_error':
        case 'timeout':
        case 'network_error':
          if (++transientFailures >= maxAttempts) {
            // Try the next model in the fallback chain before giving up.
            candidates = candidates.slice(1);
            transientFailures = 0;
            if (candidates.length === 0) break;
            continue;
          }
          await sleep(backoffWithJitter(transientFailures, 1_000, 20_000), req.signal);
          continue;
        case 'cancelled':
          throw new ProviderError('cancelled', 'request cancelled', false);
        default:
          throw new ProviderError(result.errorClass, result.message, false, result.httpStatus);
      }
    }
    if (lastError && !lastError.ok) {
      throw new ProviderError(lastError.errorClass, lastError.message, lastError.errorClass !== 'client_error', lastError.httpStatus);
    }
    throw new ProviderError('model_unavailable', `No NVIDIA model available for ${req.capability ?? req.model}`, false);
  }

  /** Discovers the provider catalog (leased through the Key Manager like any other call). */
  async discoverModels(): Promise<{ ok: boolean; missing?: string[]; message?: string }> {
    const anyModel = this.router.registry.find((m) => m.enabled)?.id ?? 'catalog';
    let lease: Lease;
    try {
      lease = await this.keyPool.acquire({ model: anyModel, requesterId: 'model-discovery', purpose: 'model_discovery', maxWaitMs: 60_000 });
    } catch (err) {
      return { ok: false, message: (err as Error).message };
    }
    const started = Date.now();
    const res = await this.client.listModels(lease.keyId);
    if (!res.ok) {
      await this.keyPool.complete(lease, { status: res.status === 'model_unavailable' ? 'client_error' : res.status, httpStatus: res.httpStatus, latencyMs: Date.now() - started, error: res.message });
      return { ok: false, message: res.message };
    }
    await this.keyPool.complete(lease, { status: 'ok', httpStatus: 200, latencyMs: Date.now() - started });
    const { missing } = await this.router.applyDiscovery(res.ids);
    if (missing.length) log.warn('registry models missing from NVIDIA catalog (taken out of rotation)', { missing });
    return { ok: true, missing };
  }

  async recentRequests(limit = 50) {
    const { rows } = await this.#db.query(
      `SELECT lease_id, key_id, model, task_id, purpose, status, http_status, latency_ms, granted_at, finished_at, error
       FROM key_requests ORDER BY granted_at DESC LIMIT $1`,
      [limit],
    );
    return rows;
  }
}
