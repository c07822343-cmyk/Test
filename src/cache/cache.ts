// Result cache with explicit scope, expiry and source information. Used for
// research fetches/searches (short TTLs - research is time-sensitive) and for
// model responses of side-effect-free research agents within one project.
import type { Db } from '../db/pool.ts';
import { sha256, stableStringify } from '../util/common.ts';

export type CacheScope = 'project' | 'global';

export interface CacheEntry<T = any> {
  key: string;
  result: T;
  sources: unknown;
  created_at: Date;
  expires_at: Date;
  hits: number;
}

export const TTL = {
  webPage: 6 * 3600_000,
  search: 3600_000,
  modelResponse: 12 * 3600_000,
};

export class CacheStore {
  #db: Db;
  constructor(db: Db) {
    this.#db = db;
  }

  key(kind: string, scope: CacheScope, scopeId: string, query: unknown): string {
    return `${kind}:${scope}:${scopeId}:${sha256(stableStringify(query)).slice(0, 40)}`;
  }

  async get<T>(key: string): Promise<CacheEntry<T> | null> {
    const { rows } = await this.#db.query(
      `UPDATE result_cache SET hits = hits + 1 WHERE key = $1 AND expires_at > now() RETURNING key, result, sources, created_at, expires_at, hits`,
      [key],
    );
    return rows[0] ?? null;
  }

  async set(input: { key: string; scope: CacheScope; scopeId: string; kind: string; query: string; result: unknown; sources?: unknown; ttlMs: number }): Promise<void> {
    await this.#db.query(
      `INSERT INTO result_cache (key, scope, scope_id, kind, query, result, sources, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, now() + ($8::int * interval '1 millisecond'))
       ON CONFLICT (key) DO UPDATE SET result = EXCLUDED.result, sources = EXCLUDED.sources, created_at = now(), expires_at = EXCLUDED.expires_at, hits = 0`,
      [input.key, input.scope, input.scopeId, input.kind, input.query.slice(0, 2000), JSON.stringify(input.result), input.sources ? JSON.stringify(input.sources) : null, input.ttlMs],
    );
  }

  async purgeExpired(): Promise<number> {
    const r = await this.#db.query('DELETE FROM result_cache WHERE expires_at < now()');
    return r.rowCount ?? 0;
  }

  async stats() {
    const { rows } = await this.#db.query(`SELECT kind, count(*)::int AS entries, coalesce(sum(hits), 0)::int AS hits FROM result_cache WHERE expires_at > now() GROUP BY kind ORDER BY kind`);
    return rows;
  }
}
