// Scoped memory. Global = ApexWeb-wide rules; Project = one website/project;
// Task = temporary per-task data (tool results, prompts); Agent = reusable
// lessons for an agent type. Queries are always scoped by (scope, scope_id),
// so one project's memory can never leak into another's context.
import type { Db } from '../db/pool.ts';
import { redact } from '../security/redact.ts';

export type MemoryScope = 'global' | 'project' | 'task' | 'agent';

export interface MemoryEntry {
  key: string;
  value: any;
  source: string | null;
  updated_at: Date;
}

export class MemoryStore {
  #db: Db;
  constructor(db: Db) {
    this.#db = db;
  }

  async set(scope: MemoryScope, scopeId: string, key: string, value: unknown, source: string): Promise<void> {
    await this.#db.query(
      `INSERT INTO memory (scope, scope_id, key, value, source) VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (scope, scope_id, key) DO UPDATE SET value = EXCLUDED.value, source = EXCLUDED.source, updated_at = now()`,
      [scope, scopeId, key, JSON.stringify(redact(value)), source],
    );
  }

  async setIfAbsent(scope: MemoryScope, scopeId: string, key: string, value: unknown, source: string): Promise<void> {
    await this.#db.query(
      `INSERT INTO memory (scope, scope_id, key, value, source) VALUES ($1, $2, $3, $4, $5) ON CONFLICT DO NOTHING`,
      [scope, scopeId, key, JSON.stringify(value), source],
    );
  }

  async get<T = any>(scope: MemoryScope, scopeId: string, key: string): Promise<T | null> {
    const { rows } = await this.#db.query('SELECT value FROM memory WHERE scope = $1 AND scope_id = $2 AND key = $3', [scope, scopeId, key]);
    return rows[0]?.value ?? null;
  }

  async list(scope: MemoryScope, scopeId: string, prefix = ''): Promise<MemoryEntry[]> {
    const { rows } = await this.#db.query(
      `SELECT key, value, source, updated_at FROM memory WHERE scope = $1 AND scope_id = $2 AND key LIKE $3 ORDER BY key`,
      [scope, scopeId, `${prefix.replace(/[%_]/g, '\\$&')}%`],
    );
    return rows;
  }

  /** Appends to a bounded list value (e.g. agent lessons). */
  async append(scope: MemoryScope, scopeId: string, key: string, item: unknown, source: string, max = 20): Promise<void> {
    const current = ((await this.get<unknown[]>(scope, scopeId, key)) ?? []).filter((x) => JSON.stringify(x) !== JSON.stringify(item));
    current.push(item);
    await this.set(scope, scopeId, key, current.slice(-max), source);
  }

  async delete(scope: MemoryScope, scopeId: string, key: string): Promise<void> {
    await this.#db.query('DELETE FROM memory WHERE scope = $1 AND scope_id = $2 AND key = $3', [scope, scopeId, key]);
  }
}
