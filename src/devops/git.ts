// Git-aware development layer. Every project gets its own repository; every
// accepted file-producing task becomes a snapshot commit (author = the agent).
// Diffs feed the Change Review skill. Rollback is a *new* commit restoring an
// earlier snapshot - history is never rewritten or destroyed - and it is only
// executed after a human approval.
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import type { Db } from '../db/pool.ts';
import type { ArtifactStore } from '../memory/artifacts.ts';
import { AppError, newId } from '../util/common.ts';
import { errorMessage, logger } from '../util/log.ts';

const run = promisify(execFile);
const log = logger('git');

export interface Snapshot {
  id: string;
  project_id: string;
  task_id: string | null;
  label: string;
  commit_sha: string | null;
  files: Record<string, number>;
  stable: boolean;
  created_by: string;
  created_at: Date;
}

export class ProjectRepos {
  #db: Db;
  #artifacts: ArtifactStore;
  #dataDir: string;
  #gitAvailable: boolean | null = null;

  constructor(db: Db, artifacts: ArtifactStore, dataDir: string) {
    this.#db = db;
    this.#artifacts = artifacts;
    this.#dataDir = dataDir;
  }

  repoDir(projectId: string): string {
    return path.join(this.#dataDir, 'projects', projectId, 'repo');
  }

  async gitAvailable(): Promise<boolean> {
    if (this.#gitAvailable === null) {
      try {
        await run('git', ['--version']);
        this.#gitAvailable = true;
      } catch {
        this.#gitAvailable = false;
        log.warn('git CLI not found; snapshots are recorded without commits');
      }
    }
    return this.#gitAvailable;
  }

  async #git(projectId: string, args: string[]): Promise<string> {
    const { stdout } = await run('git', args, { cwd: this.repoDir(projectId), maxBuffer: 20 * 1024 * 1024, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
    return stdout;
  }

  async ensure(projectId: string): Promise<void> {
    const dir = this.repoDir(projectId);
    if (existsSync(path.join(dir, '.git'))) return;
    mkdirSync(dir, { recursive: true });
    await this.#git(projectId, ['init', '-q', '-b', 'main']);
    await this.#git(projectId, ['config', 'user.email', 'agents@apexweb.local']);
    await this.#git(projectId, ['config', 'user.name', 'ApexWeb OS']);
    writeFileSync(path.join(dir, 'README.md'), `# ${projectId}\n\nManaged by ApexWeb OS. Each commit is one accepted agent change.\n`);
    await this.#git(projectId, ['add', '-A']);
    await this.#git(projectId, ['commit', '-q', '-m', 'Initialise project repository']);
  }

  /** Materialises the latest site/ and docs/ artifacts and commits them. No-op if nothing changed. */
  async snapshot(projectId: string, input: { label: string; taskId: string | null; author: string; stable?: boolean }): Promise<Snapshot | null> {
    const latest = await this.#artifacts.list(projectId);
    const files: Record<string, number> = {};
    for (const a of latest) if (a.path.startsWith('site/') || a.path.startsWith('docs/')) files[a.path] = a.version;
    const prev = await this.latest(projectId);
    if (prev && JSON.stringify(prev.files) === JSON.stringify(files)) return null;
    let sha: string | null = null;
    if (await this.gitAvailable()) {
      try {
        await this.ensure(projectId);
        const dir = this.repoDir(projectId);
        for (const entry of readdirSync(dir)) if (entry !== '.git' && entry !== 'README.md') rmSync(path.join(dir, entry), { recursive: true, force: true });
        await this.#artifacts.materialise(projectId, 'site/', path.join(dir, 'site'));
        await this.#artifacts.materialise(projectId, 'docs/', path.join(dir, 'docs'));
        await this.#git(projectId, ['add', '-A']);
        const status = await this.#git(projectId, ['status', '--porcelain']);
        if (status.trim()) {
          const author = `${input.author} <${input.author.replace(/[^a-z0-9_.-]/gi, '')}@agents.apexweb.local>`;
          await this.#git(projectId, ['commit', '-q', '--author', author, '-m', input.label.slice(0, 200)]);
        }
        sha = (await this.#git(projectId, ['rev-parse', 'HEAD'])).trim();
      } catch (err) {
        log.warn('git snapshot failed; recording snapshot without commit', { project: projectId, error: errorMessage(err) });
      }
    }
    const { rows } = await this.#db.query(
      `INSERT INTO project_snapshots (id, project_id, task_id, label, commit_sha, files, stable, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [newId('snap'), projectId, input.taskId, input.label.slice(0, 300), sha, JSON.stringify(files), !!input.stable, input.author],
    );
    return rows[0];
  }

  async list(projectId: string): Promise<Snapshot[]> {
    const { rows } = await this.#db.query('SELECT * FROM project_snapshots WHERE project_id = $1 ORDER BY created_at DESC, id DESC', [projectId]);
    return rows;
  }

  async latest(projectId: string): Promise<Snapshot | null> {
    return (await this.list(projectId))[0] ?? null;
  }

  async markStable(snapshotId: string): Promise<void> {
    await this.#db.query('UPDATE project_snapshots SET stable = true WHERE id = $1', [snapshotId]);
  }

  /** Unified diff between two snapshots (default: latest vs the one before it). */
  async diff(projectId: string, fromId?: string, toId?: string): Promise<{ from: string | null; to: string | null; diff: string; changed: string[] }> {
    const snaps = await this.list(projectId);
    const to = toId ? snaps.find((s) => s.id === toId) : snaps[0];
    const from = fromId ? snaps.find((s) => s.id === fromId) : snaps.find((s) => s !== to && s.created_at <= (to?.created_at ?? new Date()));
    if (!to) return { from: null, to: null, diff: '', changed: [] };
    const changed = Object.keys({ ...(from?.files ?? {}), ...to.files }).filter((p) => from?.files[p] !== to.files[p]);
    if (from?.commit_sha && to.commit_sha && (await this.gitAvailable())) {
      const diff = await this.#git(projectId, ['diff', '--stat', '--patch', '--no-color', from.commit_sha, to.commit_sha]);
      return { from: from.id, to: to.id, diff: diff.slice(0, 200_000), changed };
    }
    return { from: from?.id ?? null, to: to.id, diff: `(git unavailable) changed files:\n${changed.join('\n')}`, changed };
  }

  async history(projectId: string, limit = 50): Promise<Array<{ sha: string; author: string; date: string; subject: string }>> {
    if (!(await this.gitAvailable()) || !existsSync(path.join(this.repoDir(projectId), '.git'))) return [];
    const out = await this.#git(projectId, ['log', `-${limit}`, '--pretty=format:%H%x1f%an%x1f%aI%x1f%s']);
    return out.split('\n').filter(Boolean).map((l) => {
      const [sha, author, date, subject] = l.split('\x1f');
      return { sha, author, date, subject };
    });
  }

  /** Restores an earlier snapshot as new artifact versions + a new commit. Callers must hold an approval. */
  async rollback(projectId: string, snapshotId: string, actor: string): Promise<Snapshot | null> {
    const target = (await this.list(projectId)).find((s) => s.id === snapshotId);
    if (!target) throw new AppError('not_found', `Snapshot ${snapshotId} not found`, 404);
    const current = await this.#artifacts.list(projectId);
    for (const [p, version] of Object.entries(target.files)) {
      const a = await this.#artifacts.get(projectId, p, version);
      if (a) await this.#artifacts.save({ projectId, taskId: null, path: p, content: a.content, kind: a.kind, createdBy: `rollback:${actor}` });
    }
    // Files added after the target snapshot are superseded by an explicit tombstone note, not deleted from history.
    const removed = current.filter((a) => (a.path.startsWith('site/') || a.path.startsWith('docs/')) && !(a.path in target.files)).map((a) => a.path);
    if (removed.length) {
      await this.#artifacts.save({ projectId, taskId: null, path: 'docs/ROLLBACK-NOTES.md', content: `# Rollback to ${target.label}\n\nFiles that did not exist in that snapshot and should be reviewed:\n${removed.map((r) => `- ${r}`).join('\n')}\n`, kind: 'doc', createdBy: `rollback:${actor}` });
    }
    return this.snapshot(projectId, { label: `Rollback to "${target.label}" (${snapshotId}) approved by ${actor}`, taskId: null, author: `rollback-${actor}` });
  }
}
