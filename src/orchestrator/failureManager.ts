// Failure Manager: decides what happens after a failed attempt. Pure policy
// (unit-tested); the executor applies the decision.
//
//   attempt 1 fails -> retry
//   attempt 2 fails -> retry with backoff (switching model if one is available)
//   attempt 3 fails -> failed -> rescue once on another model, else escalate
//
// Key-level problems (429, capacity waits, revoked key) do not burn task
// attempts - the Key Manager already routes the next lease to another key -
// but they are bounded so nothing retries forever.
import { backoffWithJitter } from '../util/common.ts';

export type ErrorClass =
  | 'rate_limited'
  | 'capacity_timeout'
  | 'auth_error'
  | 'model_unavailable'
  | 'server_error'
  | 'timeout'
  | 'network_error'
  | 'client_error'
  | 'malformed_output'
  | 'validation_error'
  | 'tool_error'
  | 'lease_expired'
  | 'no_keys'
  | 'cancelled'
  | 'internal_error';

export type FailureAction =
  | 'retry'
  | 'retry_backoff'
  | 'retry_other_key'
  | 'switch_model'
  | 'rescue'
  | 'fail_optional'
  | 'escalate'
  | 'none';

export interface FailureContext {
  errorClass: ErrorClass;
  attempt: number;
  maxAttempts: number;
  capacityWaits: number;
  optional: boolean;
  currentModel: string | null;
  alternativeModels: string[];
  rescued: boolean;
  retryAfterMs?: number | null;
  rand?: () => number;
}

export interface FailureDecision {
  action: FailureAction;
  delayMs: number;
  refundAttempt: boolean;
  nextModel: string | null;
  resetAttempts: boolean;
  reason: string;
}

export const MAX_CAPACITY_WAITS = 12;

const KEY_LEVEL: ErrorClass[] = ['rate_limited', 'capacity_timeout', 'auth_error'];
const TRANSIENT: ErrorClass[] = ['server_error', 'timeout', 'network_error', 'malformed_output', 'validation_error', 'tool_error', 'lease_expired', 'internal_error'];

export function decideFailure(ctx: FailureContext): FailureDecision {
  const rand = ctx.rand ?? Math.random;
  const nextModel = ctx.alternativeModels.find((m) => m !== ctx.currentModel) ?? null;
  const base = { refundAttempt: false, nextModel: null as string | null, resetAttempts: false };

  if (ctx.errorClass === 'cancelled') return { ...base, action: 'none', delayMs: 0, reason: 'task was cancelled' };

  if (ctx.errorClass === 'no_keys') {
    return { ...base, action: 'escalate', delayMs: 0, reason: 'no active NVIDIA key can serve this task; operator action required' };
  }

  if (KEY_LEVEL.includes(ctx.errorClass)) {
    if (ctx.capacityWaits >= MAX_CAPACITY_WAITS) {
      return { ...base, action: 'escalate', delayMs: 0, reason: `NVIDIA capacity unavailable after ${ctx.capacityWaits} key-level retries` };
    }
    const delay = Math.max(ctx.retryAfterMs ?? 0, backoffWithJitter(Math.min(ctx.capacityWaits + 1, 6), 1_000, 30_000, rand));
    return { ...base, action: 'retry_other_key', delayMs: delay, refundAttempt: true, reason: `${ctx.errorClass}: re-lease on another eligible key` };
  }

  if (ctx.errorClass === 'model_unavailable' || ctx.errorClass === 'client_error') {
    if (nextModel && ctx.currentModel) return { ...base, action: 'switch_model', delayMs: 500, refundAttempt: true, nextModel, reason: `${ctx.errorClass} on ${ctx.currentModel}; switching to ${nextModel}` };
    if (ctx.optional) return { ...base, action: 'fail_optional', delayMs: 0, reason: 'no alternative model for optional task' };
    return { ...base, action: 'escalate', delayMs: 0, reason: `${ctx.errorClass} and no alternative model available` };
  }

  if (TRANSIENT.includes(ctx.errorClass)) {
    if (ctx.attempt < ctx.maxAttempts) {
      if (ctx.attempt <= 1) return { ...base, action: 'retry', delayMs: 1_000 + Math.floor(rand() * 1_000), reason: `attempt ${ctx.attempt} failed (${ctx.errorClass}); retrying` };
      // Second failure: back off, and move to a fallback model if there is one.
      return {
        ...base,
        action: nextModel ? 'switch_model' : 'retry_backoff',
        delayMs: backoffWithJitter(ctx.attempt, 5_000, 60_000, rand),
        nextModel,
        reason: `attempt ${ctx.attempt} failed (${ctx.errorClass}); retrying with backoff${nextModel ? ` on ${nextModel}` : ''}`,
      };
    }
    if (ctx.optional) return { ...base, action: 'fail_optional', delayMs: 0, reason: `optional task failed after ${ctx.attempt} attempts` };
    if (!ctx.rescued && nextModel) {
      return { ...base, action: 'rescue', delayMs: backoffWithJitter(ctx.attempt, 10_000, 60_000, rand), nextModel, resetAttempts: true, reason: `failed after ${ctx.attempt} attempts; Main Agent rescue attempt on ${nextModel}` };
    }
    return { ...base, action: 'escalate', delayMs: 0, reason: `failed after ${ctx.attempt} attempts (${ctx.errorClass})` };
  }
  return { ...base, action: 'escalate', delayMs: 0, reason: `unhandled error class ${ctx.errorClass}` };
}
