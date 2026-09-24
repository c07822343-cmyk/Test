// Key scheduling strategies. The Key Manager filters keys down to the eligible
// set (active, not cooling down, under the 55 RPM ceiling, below the in-flight
// cap, compatible with the model) and asks a strategy to rank them. Strategies
// are pure functions of runtime state so they can be swapped or unit tested.

export type KeyHealth = 'healthy' | 'degraded' | 'cooldown' | 'exhausted' | 'disabled';

export interface KeySnapshot {
  id: string;
  slot: number;
  masked: string;
  active: boolean;
  disabledReason: string | null;
  cooldownUntil: Date | null;
  cooldownRemainingMs: number;
  ceiling: number;
  windowCount: number;
  remaining: number;
  oldestInWindow: Date | null;
  inflight: number;
  maxInflight: number;
  lastUsedAt: Date | null;
  consecutiveFailures: number;
  recentRequests: number;
  recentErrors: number;
  recent429: number;
  recent5xx: number;
  recentTimeouts: number;
  errorRate: number;
  latencyAvgMs: number | null;
  latencyP50Ms: number | null;
  latencyP95Ms: number | null;
  totalRequests: number;
  totalFailures: number;
  currentModel: string | null;
  allowedModels: string[] | null;
  health: KeyHealth;
}

export interface SchedulingContext {
  model: string;
}

export interface KeySchedulingStrategy {
  readonly name: string;
  rank(candidates: KeySnapshot[], ctx: SchedulingContext): KeySnapshot[];
}

function lruTiebreak(a: KeySnapshot, b: KeySnapshot): number {
  const at = a.lastUsedAt?.getTime() ?? 0;
  const bt = b.lastUsedAt?.getTime() ?? 0;
  return at - bt || a.slot - b.slot;
}

/**
 * Default: prefer the key with the most rolling-window headroom, discounted by
 * recent error rate, latency, in-flight load and consecutive failures.
 */
export class HealthWeightedHeadroomStrategy implements KeySchedulingStrategy {
  readonly name = 'health-weighted-headroom';

  score(k: KeySnapshot): number {
    const headroom = k.ceiling > 0 ? k.remaining / k.ceiling : 0;
    const reliability = 1 - Math.min(1, k.errorRate);
    const latency = k.latencyAvgMs == null ? 1 : 1 / (1 + k.latencyAvgMs / 10_000);
    const concurrency = 1 - Math.min(1, k.inflight / Math.max(1, k.maxInflight));
    const failurePenalty = Math.min(0.5, k.consecutiveFailures * 0.15);
    const degradedPenalty = k.health === 'degraded' ? 0.2 : 0;
    return 0.45 * headroom + 0.25 * reliability + 0.15 * latency + 0.15 * concurrency - failurePenalty - degradedPenalty;
  }

  rank(candidates: KeySnapshot[]): KeySnapshot[] {
    return [...candidates].sort((a, b) => {
      const diff = this.score(b) - this.score(a);
      return Math.abs(diff) > 1e-9 ? diff : lruTiebreak(a, b);
    });
  }
}

/** Alternative: weighted least-loaded (window usage + in-flight), scaled by error rate. */
export class WeightedLeastLoadedStrategy implements KeySchedulingStrategy {
  readonly name = 'weighted-least-loaded';

  load(k: KeySnapshot): number {
    return (k.windowCount + 2 * k.inflight) * (1 + 2 * k.errorRate) + 5 * k.consecutiveFailures;
  }

  rank(candidates: KeySnapshot[]): KeySnapshot[] {
    return [...candidates].sort((a, b) => this.load(a) - this.load(b) || lruTiebreak(a, b));
  }
}

export function createStrategy(name: string): KeySchedulingStrategy {
  switch (name) {
    case 'health-weighted-headroom':
      return new HealthWeightedHeadroomStrategy();
    case 'weighted-least-loaded':
      return new WeightedLeastLoadedStrategy();
    default:
      throw new Error(`Unknown NVIDIA_KEY_STRATEGY: ${name}`);
  }
}
