// Model Router: callers ask for a capability ("need high-quality copy", "need
// vision", "need fast classification"); the router returns an ordered list of
// currently-available models that satisfy it, fallbacks included.
import type { Db } from '../db/pool.ts';
import { logger } from '../util/log.ts';
import type { Capability, ModelSpec } from './modelRegistry.ts';

const log = logger('model-router');

export interface ModelRequirement {
  capability: Capability;
  vision?: boolean;
  tools?: boolean;
  minContext?: number;
  /** Explicit model preference (e.g. an operator reassignment); still subject to availability. */
  prefer?: string | null;
  exclude?: string[];
}

export interface ModelHealth {
  available: boolean;
  reason: string | null;
  consecutiveFailures: number;
}

export class ModelRouter {
  readonly registry: ModelSpec[];
  #db: Db;
  #health = new Map<string, ModelHealth>();

  constructor(db: Db, registry: ModelSpec[]) {
    this.#db = db;
    this.registry = registry;
  }

  async load(): Promise<void> {
    const { rows } = await this.#db.query('SELECT model_id, available, reason, consecutive_failures FROM model_health');
    this.#health.clear();
    for (const r of rows) {
      this.#health.set(r.model_id, { available: r.available, reason: r.reason, consecutiveFailures: r.consecutive_failures });
    }
  }

  get(id: string): ModelSpec | undefined {
    return this.registry.find((m) => m.id === id);
  }

  isAvailable(id: string): boolean {
    const m = this.get(id);
    return !!m && m.enabled && (this.#health.get(id)?.available ?? true);
  }

  health(id: string): ModelHealth {
    return this.#health.get(id) ?? { available: true, reason: null, consecutiveFailures: 0 };
  }

  #satisfies(m: ModelSpec, req: ModelRequirement): boolean {
    if (!m.enabled || !this.isAvailable(m.id)) return false;
    if (req.exclude?.includes(m.id)) return false;
    if (req.capability === 'vision' || req.vision) {
      if (!m.vision) return false;
    } else if (!m.text) return false;
    if (req.tools && !m.tool_calling) return false;
    if (req.minContext && m.context_window < req.minContext) return false;
    return true;
  }

  score(m: ModelSpec, capability: Capability): number {
    let s = m.quality_tier * 2;
    const idx = m.preferred_tasks.indexOf(capability);
    if (idx >= 0) s += 12 - idx; // earlier listing = stronger preference
    if (capability === 'classification' || capability === 'summarization') {
      s += m.speed_tier === 'fast' ? 6 : m.speed_tier === 'slow' ? -4 : 0;
    } else if (m.speed_tier === 'slow') s -= 1;
    return s;
  }

  /** Ordered candidates: best match first, then its declared fallbacks, then other qualifying models. */
  candidates(req: ModelRequirement): ModelSpec[] {
    const qualifying = this.registry.filter((m) => this.#satisfies(m, req));
    qualifying.sort((a, b) => this.score(b, req.capability) - this.score(a, req.capability) || a.id.localeCompare(b.id));
    const ordered: ModelSpec[] = [];
    const push = (m: ModelSpec | undefined) => {
      if (m && !ordered.includes(m) && this.#satisfies(m, req)) ordered.push(m);
    };
    if (req.prefer) push(this.get(req.prefer));
    const primary = qualifying[0];
    push(primary);
    for (const f of primary?.fallbacks ?? []) push(this.get(f));
    for (const m of qualifying) push(m);
    return ordered;
  }

  select(req: ModelRequirement): ModelSpec {
    const [first] = this.candidates(req);
    if (!first) throw new ModelUnavailableError(`No available NVIDIA model satisfies capability "${req.capability}"${req.vision ? ' (vision)' : ''}`);
    return first;
  }

  async markUnavailable(id: string, reason: string): Promise<void> {
    this.#health.set(id, { available: false, reason, consecutiveFailures: (this.#health.get(id)?.consecutiveFailures ?? 0) + 1 });
    await this.#db.query(
      `INSERT INTO model_health (model_id, available, reason, consecutive_failures, last_checked_at, updated_at)
       VALUES ($1, false, $2, 1, now(), now())
       ON CONFLICT (model_id) DO UPDATE SET available = false, reason = $2,
         consecutive_failures = model_health.consecutive_failures + 1, last_checked_at = now(), updated_at = now()`,
      [id, reason.slice(0, 300)],
    );
    log.warn('model marked unavailable', { model: id, reason });
  }

  async markAvailable(id: string): Promise<void> {
    const h = this.#health.get(id);
    if (h && h.available && h.consecutiveFailures === 0) return;
    this.#health.set(id, { available: true, reason: null, consecutiveFailures: 0 });
    await this.#db.query(
      `INSERT INTO model_health (model_id, available, reason, consecutive_failures, last_checked_at, updated_at)
       VALUES ($1, true, NULL, 0, now(), now())
       ON CONFLICT (model_id) DO UPDATE SET available = true, reason = NULL, consecutive_failures = 0, last_checked_at = now(), updated_at = now()`,
      [id],
    );
  }

  /** Reconcile the registry with the provider catalog. Models the catalog does not list are taken out of rotation. */
  async applyDiscovery(catalog: string[]): Promise<{ missing: string[]; present: string[] }> {
    const set = new Set(catalog);
    const missing: string[] = [];
    const present: string[] = [];
    for (const m of this.registry) {
      if (!m.discoverable) continue;
      if (set.has(m.id)) {
        present.push(m.id);
        if (this.#health.get(m.id)?.reason === 'not in provider catalog') await this.markAvailable(m.id);
      } else {
        missing.push(m.id);
        await this.markUnavailable(m.id, 'not in provider catalog');
      }
    }
    return { missing, present };
  }

  describe(): Array<ModelSpec & { available: boolean; unavailable_reason: string | null }> {
    return this.registry.map((m) => ({ ...m, available: this.isAvailable(m.id), unavailable_reason: this.#health.get(m.id)?.reason ?? null }));
  }
}

export class ModelUnavailableError extends Error {
  readonly code = 'model_unavailable';
}
