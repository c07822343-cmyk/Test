// Versioned project artifacts (site files, docs, reports, screenshots) stored in
// Postgres so they survive restarts, then materialised to disk for packaging.
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import type { Db } from '../db/pool.ts';
import { AppError, newId, sha256 } from '../util/common.ts';

export type ArtifactKind = 'site' | 'doc' | 'report' | 'screenshot' | 'client_file';

export interface ArtifactMeta {
  id: string;
  project_id: string;
  task_id: string | null;
  path: string;
  version: number;
  kind: ArtifactKind;
  content_type: string;
  bytes: number;
  sha256: string;
  created_by: string;
  created_at: Date;
}

const TEXT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml',
  '.md': 'text/markdown; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml',
};
const BINARY_TYPES: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp' };

export const MAX_ARTIFACT_BYTES = 800_000;

/** Validates an agent-supplied relative path. Rejects traversal, absolute paths and unexpected types. */
export function normaliseArtifactPath(raw: string): string {
  const cleaned = raw.trim().replace(/\\/g, '/').replace(/^\.\/+/, '');
  if (!cleaned || cleaned.startsWith('/') || /^[a-z]+:/i.test(cleaned)) throw new AppError('invalid_path', `Invalid artifact path: ${raw}`);
  const norm = path.posix.normalize(cleaned);
  if (norm.startsWith('..') || norm.includes('/../') || norm === '.') throw new AppError('invalid_path', `Path traversal rejected: ${raw}`);
  if (!/^[A-Za-z0-9._\-/]+$/.test(norm)) throw new AppError('invalid_path', `Unsupported characters in path: ${raw}`);
  const ext = path.posix.extname(norm).toLowerCase();
  if (!TEXT_TYPES[ext] && !BINARY_TYPES[ext]) throw new AppError('invalid_path', `Unsupported file type: ${raw}`);
  return norm;
}

export function contentTypeFor(p: string): string {
  const ext = path.posix.extname(p).toLowerCase();
  return TEXT_TYPES[ext] ?? BINARY_TYPES[ext] ?? 'application/octet-stream';
}

export class ArtifactStore {
  #db: Db;
  constructor(db: Db) {
    this.#db = db;
  }

  async save(input: { projectId: string; taskId: string | null; path: string; content: string | Buffer; kind: ArtifactKind; createdBy: string }): Promise<ArtifactMeta> {
    const p = normaliseArtifactPath(input.path);
    const buf = typeof input.content === 'string' ? Buffer.from(input.content, 'utf8') : input.content;
    if (buf.length > MAX_ARTIFACT_BYTES) throw new AppError('artifact_too_large', `${p} is ${buf.length} bytes (max ${MAX_ARTIFACT_BYTES})`);
    const digest = sha256(buf);
    const latest = await this.#db.query('SELECT version, sha256 FROM artifacts WHERE project_id = $1 AND path = $2 ORDER BY version DESC LIMIT 1', [input.projectId, p]);
    if (latest.rows[0]?.sha256 === digest) {
      const { rows } = await this.#db.query(
        'SELECT id, project_id, task_id, path, version, kind, content_type, bytes, sha256, created_by, created_at FROM artifacts WHERE project_id = $1 AND path = $2 AND version = $3',
        [input.projectId, p, latest.rows[0].version],
      );
      return rows[0];
    }
    // Retry on the rare version race between two writers.
    for (let i = 0; i < 5; i++) {
      const version = ((await this.#db.query('SELECT max(version) AS v FROM artifacts WHERE project_id = $1 AND path = $2', [input.projectId, p])).rows[0]?.v ?? 0) + 1;
      try {
        const { rows } = await this.#db.query(
          `INSERT INTO artifacts (id, project_id, task_id, path, version, kind, content_type, content, bytes, sha256, created_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
           RETURNING id, project_id, task_id, path, version, kind, content_type, bytes, sha256, created_by, created_at`,
          [newId('art'), input.projectId, input.taskId, p, version, input.kind, contentTypeFor(p), buf, buf.length, digest, input.createdBy],
        );
        return rows[0];
      } catch (err: any) {
        if (err?.code !== '23505') throw err;
      }
    }
    throw new AppError('artifact_conflict', `Could not version ${p}`, 409);
  }

  /** Latest version of every artifact under a prefix (e.g. "site/"). */
  async latest(projectId: string, prefix = ''): Promise<Array<ArtifactMeta & { content: Buffer }>> {
    const { rows } = await this.#db.query(
      `SELECT DISTINCT ON (path) id, project_id, task_id, path, version, kind, content_type, bytes, sha256, created_by, created_at, content
       FROM artifacts WHERE project_id = $1 AND path LIKE $2 ORDER BY path, version DESC`,
      [projectId, `${prefix}%`],
    );
    return rows;
  }

  async latestText(projectId: string, prefix: string): Promise<Record<string, string>> {
    const out: Record<string, string> = {};
    for (const a of await this.latest(projectId, prefix)) {
      if (!a.content_type.startsWith('image/') || a.content_type === 'image/svg+xml') out[a.path.slice(prefix.length)] = a.content.toString('utf8');
    }
    return out;
  }

  async list(projectId: string): Promise<ArtifactMeta[]> {
    const { rows } = await this.#db.query(
      `SELECT DISTINCT ON (path) id, project_id, task_id, path, version, kind, content_type, bytes, sha256, created_by, created_at
       FROM artifacts WHERE project_id = $1 ORDER BY path, version DESC`,
      [projectId],
    );
    return rows;
  }

  async get(projectId: string, p: string, version?: number): Promise<(ArtifactMeta & { content: Buffer }) | null> {
    const { rows } = await this.#db.query(
      `SELECT * FROM artifacts WHERE project_id = $1 AND path = $2 AND ($3::int IS NULL OR version = $3) ORDER BY version DESC LIMIT 1`,
      [projectId, p, version ?? null],
    );
    return rows[0] ?? null;
  }

  /** Writes the latest version of every artifact under `prefix` into `dir`, stripping the prefix. */
  async materialise(projectId: string, prefix: string, dir: string): Promise<string[]> {
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    const written: string[] = [];
    for (const a of await this.latest(projectId, prefix)) {
      const rel = a.path.slice(prefix.length);
      const target = path.join(dir, rel);
      if (!target.startsWith(path.resolve(dir))) continue;
      mkdirSync(path.dirname(target), { recursive: true });
      writeFileSync(target, a.content);
      written.push(rel);
    }
    return written;
  }
}
