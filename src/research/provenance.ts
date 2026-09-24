// Research provenance: every fetched source is recorded (URL, retrieval time,
// type, content hash, excerpt) and every research claim is classified.
// Classification is enforced, not trusted: a claim marked VERIFIED_FACT must
// cite a source that was actually fetched for this project and whose text
// supports it; otherwise it is downgraded and the reason recorded. Only
// VERIFIED_FACT claims become project facts the writers may state.
import type { Db } from '../db/pool.ts';
import { newId, sha256 } from '../util/common.ts';

export type Classification = 'VERIFIED_FACT' | 'SOURCE_DERIVED' | 'INFERENCE' | 'UNVERIFIED';

export interface SourceRecord {
  id: string;
  url: string;
  final_url: string | null;
  title: string | null;
  source_type: string;
  retrieved_at: Date;
  excerpt: string | null;
  injection_flags: string[];
}

export async function recordSource(db: Db, input: { projectId: string; taskId: string | null; url: string; finalUrl: string; title: string; sourceType: string; text: string; flags: string[] }): Promise<SourceRecord> {
  const hash = sha256(input.text);
  const existing = await db.query(`SELECT * FROM research_sources WHERE project_id = $1 AND final_url = $2 AND content_sha256 = $3`, [input.projectId, input.finalUrl, hash]);
  if (existing.rows[0]) return existing.rows[0];
  const { rows } = await db.query(
    `INSERT INTO research_sources (id, project_id, task_id, url, final_url, title, source_type, content_sha256, excerpt, injection_flags)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING *`,
    [newId('src'), input.projectId, input.taskId, input.url, input.finalUrl, input.title.slice(0, 300), input.sourceType, hash, input.text.slice(0, 6000), input.flags],
  );
  return rows[0];
}

export async function projectSources(db: Db, projectId: string): Promise<SourceRecord[]> {
  const { rows } = await db.query(`SELECT id, url, final_url, title, source_type, retrieved_at, excerpt, injection_flags FROM research_sources WHERE project_id = $1 ORDER BY retrieved_at`, [projectId]);
  return rows;
}

const STOP = new Set(['the', 'and', 'for', 'with', 'that', 'this', 'from', 'are', 'was', 'our', 'your', 'their', 'has', 'have', 'its', 'into', 'about', 'they', 'offers', 'provides', 'company', 'business']);

/** Share of the claim's significant terms that appear in the source text. */
export function support(statement: string, sourceText: string): number {
  const terms = statement.toLowerCase().match(/[a-z0-9][a-z0-9'-]{2,}/g)?.filter((t) => !STOP.has(t)) ?? [];
  if (!terms.length) return 0;
  const hay = sourceText.toLowerCase();
  return terms.filter((t) => hay.includes(t)).length / terms.length;
}

export interface ClaimInput {
  statement: string;
  classification: string;
  source_ids?: string[];
  confidence?: number;
}

export interface VerifiedClaim {
  statement: string;
  classification: Classification;
  claimed_as: string;
  source_ids: string[];
  confidence: number | null;
  downgrade_reason: string | null;
}

/** Enforces classification rules against the project's real source records. */
export function verifyClaims(claims: ClaimInput[], sources: Map<string, { excerpt: string }>): VerifiedClaim[] {
  return claims.slice(0, 200).map((c) => {
    const claimedAs = String(c.classification ?? 'UNVERIFIED').toUpperCase();
    const ids = (c.source_ids ?? []).map(String).filter((id) => sources.has(id));
    const unknownIds = (c.source_ids ?? []).length - ids.length;
    let classification: Classification = (['VERIFIED_FACT', 'SOURCE_DERIVED', 'INFERENCE', 'UNVERIFIED'].includes(claimedAs) ? claimedAs : 'UNVERIFIED') as Classification;
    let reason: string | null = unknownIds > 0 ? `${unknownIds} cited source id(s) were never fetched` : null;
    if (classification === 'VERIFIED_FACT') {
      const best = Math.max(0, ...ids.map((id) => support(c.statement, sources.get(id)!.excerpt ?? '')));
      if (ids.length === 0) {
        classification = 'UNVERIFIED';
        reason = 'claimed as verified without a fetched source';
      } else if (best < 0.6) {
        classification = 'SOURCE_DERIVED';
        reason = `cited source only partially supports the statement (${Math.round(best * 100)}% term overlap)`;
      }
    } else if (classification === 'SOURCE_DERIVED' && ids.length === 0) {
      classification = 'INFERENCE';
      reason = 'no fetched source cited';
    }
    return { statement: String(c.statement).slice(0, 1000), classification, claimed_as: claimedAs, source_ids: ids, confidence: typeof c.confidence === 'number' ? c.confidence : null, downgrade_reason: reason };
  });
}

export async function storeClaims(db: Db, projectId: string, taskId: string, claims: VerifiedClaim[]): Promise<void> {
  for (const c of claims) {
    await db.query(
      `INSERT INTO research_claims (id, project_id, task_id, statement, classification, claimed_as, source_ids, confidence, downgrade_reason) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [newId('clm'), projectId, taskId, c.statement, c.classification, c.claimed_as, c.source_ids, c.confidence, c.downgrade_reason],
    );
  }
}

export async function claimsByClass(db: Db, projectId: string) {
  const { rows } = await db.query(
    `SELECT c.*, coalesce(json_agg(json_build_object('id', s.id, 'url', s.final_url, 'type', s.source_type, 'retrieved_at', s.retrieved_at)) FILTER (WHERE s.id IS NOT NULL), '[]') AS sources
     FROM research_claims c LEFT JOIN research_sources s ON s.id = ANY(c.source_ids)
     WHERE c.project_id = $1 GROUP BY c.id ORDER BY c.classification, c.created_at`,
    [projectId],
  );
  const out: Record<Classification, any[]> = { VERIFIED_FACT: [], SOURCE_DERIVED: [], INFERENCE: [], UNVERIFIED: [] };
  for (const r of rows) out[r.classification as Classification].push(r);
  return out;
}
