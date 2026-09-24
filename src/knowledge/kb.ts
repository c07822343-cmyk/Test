// ApexWeb knowledge base (GLOBAL knowledge). Project knowledge lives in
// project-scoped memory and task knowledge in task memory; nothing here is
// client-specific. Retrospectives propose *candidate* entries; only an explicit
// promotion makes them active - one project never silently rewrites how the
// agency works.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import type { Db } from '../db/pool.ts';
import { AppError, newId } from '../util/common.ts';

export const KnowledgeSchema = z.object({
  id: z.string().optional(),
  category: z.enum(['design_principles', 'coding_patterns', 'successful_patterns', 'common_bugs', 'client_requirements', 'seo_rules', 'accessibility_rules', 'apexweb_preferences', 'approved_libraries', 'project_structure', 'performance', 'qa_findings', 'process']),
  title: z.string().min(3).max(200),
  content: z.string().min(10).max(4000),
  tags: z.array(z.string()).default([]),
});
export type KnowledgeInput = z.infer<typeof KnowledgeSchema>;

export interface KnowledgeEntry extends KnowledgeInput {
  id: string;
  status: 'active' | 'candidate' | 'rejected' | 'archived';
  source: string;
  source_project: string | null;
}

/** Refuses candidate knowledge that carries client-specific details. */
export function containsProjectSpecifics(text: string, specifics: string[]): string | null {
  const lower = text.toLowerCase();
  for (const s of specifics) {
    const v = s.trim().toLowerCase();
    if (v.length >= 4 && lower.includes(v)) return s;
  }
  if (/\[\[PLACEHOLDER/i.test(text)) return 'placeholder';
  if (/https?:\/\/(?!(www\.)?(w3\.org|schema\.org|developer\.mozilla\.org|web\.dev))/i.test(text)) return 'url';
  if (/(\+?1[\s.-]?)?\(?\d{3}\)?[\s.-]\d{3}[\s.-]\d{4}/.test(text)) return 'phone number';
  return null;
}

export class KnowledgeBase {
  #db: Db;
  constructor(db: Db) {
    this.#db = db;
  }

  /** Seeds memory/*.json (global, active). Existing ids are left as operators edited them. */
  async seed(dir: string): Promise<number> {
    if (!existsSync(dir)) return 0;
    let n = 0;
    for (const f of readdirSync(dir).filter((x) => x.endsWith('.json')).sort()) {
      const entries = z.array(KnowledgeSchema.extend({ id: z.string() })).parse(JSON.parse(readFileSync(path.join(dir, f), 'utf8')));
      for (const e of entries) {
        const r = await this.#db.query(
          `INSERT INTO knowledge (id, category, title, content, tags, status, source) VALUES ($1, $2, $3, $4, $5, 'active', $6) ON CONFLICT (id) DO NOTHING`,
          [e.id, e.category, e.title, e.content, e.tags, `seed:${f}`],
        );
        n += r.rowCount ?? 0;
      }
    }
    return n;
  }

  /** Active entries whose tags overlap the request (agent type, skills, categories), best overlap first. */
  async retrieve(tags: string[], limit = 8): Promise<KnowledgeEntry[]> {
    const { rows } = await this.#db.query(
      `SELECT *, cardinality(ARRAY(SELECT unnest(tags) INTERSECT SELECT unnest($1::text[]))) AS overlap
       FROM knowledge WHERE status = 'active' AND tags && $1::text[] ORDER BY overlap DESC, updated_at DESC LIMIT $2`,
      [tags, limit],
    );
    return rows;
  }

  async list(status?: string, category?: string): Promise<KnowledgeEntry[]> {
    const { rows } = await this.#db.query(
      `SELECT * FROM knowledge WHERE ($1::text IS NULL OR status = $1) AND ($2::text IS NULL OR category = $2) ORDER BY status, category, title`,
      [status ?? null, category ?? null],
    );
    return rows;
  }

  async add(input: KnowledgeInput, status: 'active' | 'candidate', source: string, sourceProject: string | null = null): Promise<KnowledgeEntry> {
    const e = KnowledgeSchema.parse(input);
    const { rows } = await this.#db.query(
      `INSERT INTO knowledge (id, category, title, content, tags, status, source, source_project) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [e.id ?? newId('kb'), e.category, e.title, e.content, e.tags, status, source, sourceProject],
    );
    return rows[0];
  }

  /** Controlled knowledge promotion: candidate -> active (or rejected) by an explicit decision. */
  async decide(id: string, decision: 'promote' | 'reject' | 'archive', actor: string): Promise<KnowledgeEntry> {
    const status = decision === 'promote' ? 'active' : decision === 'reject' ? 'rejected' : 'archived';
    const { rows } = await this.#db.query(
      `UPDATE knowledge SET status = $2, decided_by = $3, decided_at = now(), updated_at = now()
       WHERE id = $1 AND ($2 = 'archived' OR status = 'candidate') RETURNING *`,
      [id, status, actor],
    );
    if (!rows[0]) throw new AppError('not_candidate', `Knowledge ${id} is not a pending candidate`, 409);
    return rows[0];
  }
}
