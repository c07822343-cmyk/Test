// Obsidian integration: the vault becomes a second window into ApexWeb OS.
//
//  Out (ApexWeb -> vault, under <vault>/ApexWeb/):
//    Home.md                     live overview with links to everything
//    Agents/<Agent>.md           one note per agent (mission, rules, skills, recent work)
//    Skills/<skill>.md           one note per skill, linked to its agents
//    Projects/<Project>/...      project note, one note per task (linked to its agent),
//                                blueprint and completion report
//    Knowledge/<title>.md        active global knowledge
//  In (vault -> ApexWeb):
//    ApexWeb/Inbox/*.md          each new note is sent to the Main Agent as a request,
//                                then moved to Inbox/Processed with a link to its project
//    your own notes              agents get the most relevant ones as context (read-only,
//                                screened for injection and wrapped as untrusted data)
//
// Only <vault>/ApexWeb/ is ever written. Everything written is redacted.
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { getAgent, specialists, subAgents } from '../agents/registry.ts';
import type { Db } from '../db/pool.ts';
import type { KnowledgeBase } from '../knowledge/kb.ts';
import type { TaskQueue } from '../queue/taskQueue.ts';
import type { ProjectRow, TaskRow } from '../queue/types.ts';
import { redactString } from '../security/redact.ts';
import { screenText } from '../security/screen.ts';
import type { SkillEngine } from '../skills/engine.ts';
import { errorMessage, logger } from '../util/log.ts';

const log = logger('obsidian');
const ROOT = 'ApexWeb';

/** File-name safe title (no path separators, no Obsidian link syntax). */
export function noteName(s: string): string {
  return s.replace(/[\\/:*?"<>|#^[\]]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 90) || 'Untitled';
}

const link = (target: string, label?: string) => `[[${target}${label ? `|${label.replace(/[|\]]/g, ' ')}` : ''}]]`;
const agentLink = (type: string) => {
  try {
    return link(`${ROOT}/Agents/${noteName(getAgent(type).name)}`, getAgent(type).name);
  } catch {
    return type;
  }
};
const skillLink = (ref: string) => link(`${ROOT}/Skills/${noteName(ref.split('@')[0])}`, ref);
const yaml = (o: Record<string, unknown>) => `---\n${Object.entries(o).filter(([, v]) => v !== undefined && v !== null).map(([k, v]) => `${k}: ${Array.isArray(v) ? `[${v.map((x) => JSON.stringify(String(x))).join(', ')}]` : JSON.stringify(v)}`).join('\n')}\n---\n`;

export interface ObsidianDeps {
  vault: string;
  /** Where the vault lives on the user's computer when the core runs in a container (for obsidian:// links). */
  hostVault?: string | null;
  db: Db;
  queue: TaskQueue;
  skills: SkillEngine;
  knowledge: KnowledgeBase;
  /** Sends an Inbox note to the Main Agent. */
  submit(message: string): Promise<{ projectId: string | null; reply: string }>;
}

export class ObsidianSync {
  readonly vault: string;
  #d: ObsidianDeps;
  #dirty = new Set<string>();
  #timers: NodeJS.Timeout[] = [];
  #flushing = false;
  #inboxBusy = false;
  lastSyncAt: Date | null = null;
  lastError: string | null = null;
  notesWritten = 0;
  inboxProcessed = 0;

  constructor(d: ObsidianDeps) {
    this.#d = d;
    this.vault = path.resolve(d.vault);
  }

  get root(): string {
    return path.join(this.vault, ROOT);
  }

  /** Writes a note only when its content changed (keeps Obsidian's file watcher quiet). */
  #write(rel: string, content: string): void {
    const abs = path.resolve(this.root, rel);
    if (!abs.startsWith(this.root + path.sep)) throw new Error(`refusing to write outside the ApexWeb folder: ${rel}`);
    const text = redactString(content);
    if (existsSync(abs) && readFileSync(abs, 'utf8') === text) return;
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, text);
    this.notesWritten++;
  }

  start(): void {
    mkdirSync(path.join(this.root, 'Inbox', 'Processed'), { recursive: true });
    const readme = path.join(this.root, 'Inbox', 'README.md');
    if (!existsSync(readme)) {
      writeFileSync(readme, '# Inbox\n\nCreate a note in this folder and ApexWeb OS sends its text to the Main Agent as a request — e.g. *"Create a premium website for a local HVAC company."* or a command like `/status`.\n\nWithin ~10 seconds the note moves to `Processed/` with the reply and a link to the project.\n');
    }
    this.#d.queue.on('task_changed', ({ task }: { task: TaskRow }) => this.#dirty.add(task.project_id));
    void this.syncAll().catch((err) => this.#fail(err));
    this.#timers.push(setInterval(() => void this.#flush().catch((err) => this.#fail(err)), 3_000));
    this.#timers.push(setInterval(() => void this.pollInbox().catch((err) => this.#fail(err)), 10_000));
    this.#timers.push(setInterval(() => void this.syncCatalog().catch((err) => this.#fail(err)), 10 * 60_000));
    log.info('obsidian vault connected', { vault: this.vault });
  }

  stop(): void {
    for (const t of this.#timers) clearInterval(t);
    this.#timers = [];
  }

  #fail(err: unknown): void {
    this.lastError = errorMessage(err).slice(0, 300);
    log.warn('obsidian sync failed', { error: this.lastError });
  }

  status() {
    return { connected: existsSync(this.vault), vault: this.#d.hostVault || this.vault, folder: this.root, folder_host: this.#d.hostVault ? path.join(this.#d.hostVault, ROOT) : this.root, last_sync_at: this.lastSyncAt, last_error: this.lastError, notes_written: this.notesWritten, inbox_processed: this.inboxProcessed };
  }

  async syncAll(): Promise<void> {
    await this.syncCatalog();
    const { rows } = await this.#d.db.query(`SELECT id FROM projects ORDER BY created_at DESC LIMIT 200`);
    for (const r of rows) await this.syncProject(r.id);
    await this.syncHome();
    this.lastSyncAt = new Date();
  }

  async #flush(): Promise<void> {
    if (this.#flushing || !this.#dirty.size) return;
    this.#flushing = true;
    try {
      const ids = [...this.#dirty];
      this.#dirty.clear();
      for (const id of ids) await this.syncProject(id);
      await this.syncHome();
      this.lastSyncAt = new Date();
    } finally {
      this.#flushing = false;
    }
  }

  /** Agents, skills and knowledge. */
  async syncCatalog(): Promise<void> {
    const skills = this.#d.skills.catalog();
    const { rows: recent } = await this.#d.db.query(
      `SELECT t.agent_type, t.title, t.status, t.plan_key, t.updated_at, p.name AS project, p.id AS project_id
       FROM tasks t JOIN projects p ON p.id = t.project_id WHERE t.kind <> 'root' ORDER BY t.updated_at DESC LIMIT 2000`,
    );
    for (const a of [...specialists(), ...subAgents()]) {
      const mine = skills.filter((s) => s.compatible_agents.includes(a.type));
      const work = recent.filter((r) => r.agent_type === a.type).slice(0, 15);
      this.#write(`Agents/${noteName(a.name)}.md`, `${yaml({ apexweb: 'agent', type: a.type, department: a.department, pipeline: a.pipeline, capability: a.capability, tool_profile: a.toolProfile, reviewer: !!a.reviewer, tags: ['apexweb/agent', `apexweb/${a.department}`] })}
# ${a.name}

> ${a.mission}

**Department:** ${a.department} · **Pipeline:** ${a.pipeline} · **Model capability:** ${a.capability} · **Tools profile:** ${a.toolProfile}
${a.parent ? `\n**Sub-agent of:** ${agentLink(a.parent)}\n` : ''}${a.subAgents?.length ? `\n**Can delegate to:** ${a.subAgents.map(agentLink).join(', ')}\n` : ''}
## Working rules
${a.instructions.map((i) => `- ${i}`).join('\n')}

## Tools
${(a.tools ?? []).map((t) => `- \`${t}\``).join('\n') || '- none'}

## Skills it can use
${mine.map((s) => `- ${skillLink(`${s.name}@${s.latest}`)} — ${s.title}`).join('\n') || '- none'}

## Recent work
${work.map((w) => `- ${link(`${ROOT}/Projects/${noteName(w.project)} (${w.project_id})/Tasks/${noteName(w.plan_key)}`, w.title)} · ${w.status} · ${link(`${ROOT}/Projects/${noteName(w.project)} (${w.project_id})/Project`, w.project)}`).join('\n') || '- nothing yet'}
`);
    }
    for (const s of skills) {
      this.#write(`Skills/${noteName(s.name)}.md`, `${yaml({ apexweb: 'skill', name: s.name, latest: s.latest, category: s.category, tags: ['apexweb/skill', `apexweb/skill/${s.category}`] })}
# ${s.title}

${s.description}

**When to use:** ${s.when_to_use}

**Versions:** ${s.versions.map((v) => `${v.version}${v.enabled ? '' : ' (disabled)'}`).join(', ')}

## Agents
${s.compatible_agents.map((a) => `- ${agentLink(a)}`).join('\n')}
${s.sub_skills.length ? `\n## Uses skills\n${s.sub_skills.map((x) => `- ${skillLink(x)}`).join('\n')}\n` : ''}${s.tools.length ? `\n## Tools\n${s.tools.map((t) => `- \`${t}\``).join('\n')}\n` : ''}`);
    }
    for (const k of await this.#d.knowledge.list('active')) {
      this.#write(`Knowledge/${noteName(k.title)}.md`, `${yaml({ apexweb: 'knowledge', id: k.id, category: k.category, tags: ['apexweb/knowledge', ...k.tags.map((t) => `apexweb/${t}`)] })}\n# ${k.title}\n\n${k.content}\n`);
    }
  }

  async syncProject(projectId: string): Promise<void> {
    const { rows } = await this.#d.db.query(`SELECT * FROM projects WHERE id = $1`, [projectId]);
    const p = rows[0] as ProjectRow | undefined;
    if (!p) return;
    const dir = `Projects/${noteName(p.name)} (${p.id})`;
    const tasks = (await this.#d.queue.listByProject(p.id)).filter((t) => t.kind !== 'root');
    const byId = new Map(tasks.map((t) => [t.id, t]));
    const taskLink = (t: TaskRow) => link(`${ROOT}/${dir}/Tasks/${noteName(t.plan_key)}`, t.title);
    const done = tasks.filter((t) => t.status === 'COMPLETED').length;
    const agents = [...new Set(tasks.map((t) => t.agent_type))];
    this.#write(`${dir}/Project.md`, `${yaml({ apexweb: 'project', id: p.id, status: p.status, stage: p.stage, mode: p.mode, created: new Date(p.created_at).toISOString(), tags: ['apexweb/project', `apexweb/status/${p.status.toLowerCase()}`] })}
# ${p.name}

**Status:** ${p.status}${p.paused ? ' (paused)' : ''} · **Stage:** ${p.stage} · **Mode:** ${p.mode} · **Progress:** ${done}/${tasks.length} tasks

> ${p.request.replace(/\n/g, '\n> ')}

${p.blueprint ? `- ${link(`${ROOT}/${dir}/Blueprint`, 'Blueprint')}\n` : ''}${p.final_report ? `- ${link(`${ROOT}/${dir}/Report`, 'Completion report')}\n` : ''}
## Agents on this project
${agents.map((a) => `- ${agentLink(a)}`).join('\n') || '- none yet'}

## Tasks
| Task | Agent | Status | Depends on |
|---|---|---|---|
${tasks.map((t) => `| ${taskLink(t)} | ${agentLink(t.agent_type)} | ${t.status} | ${t.dependencies.map((d) => byId.get(d)).filter(Boolean).map((d) => taskLink(d!)).join(', ')} |`).join('\n')}
`);
    for (const t of tasks) {
      const summary = t.outputs?.summary ? String(t.outputs.summary) : '';
      const review = t.outputs?.review;
      this.#write(`${dir}/Tasks/${noteName(t.plan_key)}.md`, `${yaml({ apexweb: 'task', id: t.id, project: p.id, agent: t.agent_type, status: t.status, kind: t.kind, attempts: t.attempt, model: t.assigned_model, tags: ['apexweb/task', `apexweb/status/${t.status.toLowerCase()}`] })}
# ${t.title}

**Agent:** ${agentLink(t.agent_type)} · **Status:** ${t.status} · **Kind:** ${t.kind} · **Project:** ${link(`${ROOT}/${dir}/Project`, p.name)}
${(t.skills ?? []).length ? `\n**Skills:** ${(t.skills ?? []).map(skillLink).join(', ')}\n` : ''}${t.dependencies.length ? `\n**After:** ${t.dependencies.map((d) => byId.get(d)).filter(Boolean).map((d) => taskLink(d!)).join(', ')}\n` : ''}
## Mission
${t.mission}
${summary ? `\n## Result\n${summary}\n` : ''}${review ? `\n## Review\n**Verdict:** ${review.verdict ?? '-'}${review.score != null ? ` · **Score:** ${review.score}/10` : ''}\n${(review.issues ?? []).slice(0, 20).map((i: any) => `- ${typeof i === 'string' ? i : `${i.severity ? `**${i.severity}** ` : ''}${i.issue ?? i.detail ?? JSON.stringify(i)}`}`).join('\n')}\n` : ''}${(t.outputs?.files ?? []).length ? `\n## Files\n${(t.outputs!.files as string[]).map((f) => `- \`${f}\``).join('\n')}\n` : ''}${t.error?.message ? `\n## Error\n${t.error.message}\n` : ''}`);
    }
    if (p.blueprint) this.#write(`${dir}/Blueprint.md`, `${yaml({ apexweb: 'blueprint', project: p.id })}\n# Blueprint — ${p.name}\n\n\`\`\`json\n${JSON.stringify(p.blueprint, null, 2)}\n\`\`\`\n`);
    if (p.final_report) {
      const r = p.final_report as any;
      this.#write(`${dir}/Report.md`, `${yaml({ apexweb: 'report', project: p.id, qa_passed: !!r.qa?.passed })}
# Completion report — ${p.name}

## Completed
${r.completed ?? ''}

## Agents used
${(r.agents_used ?? []).map((a: any) => `- ${agentLink(a.agent_type)} (${a.tasks} task${a.tasks === 1 ? '' : 's'})`).join('\n')}

## Issues
${r.issues?.summary ?? 'None'}
${(r.issues?.placeholders ?? []).length ? `\n**Details the client must supply:**\n${r.issues.placeholders.map((x: string) => `- ${x}`).join('\n')}\n` : ''}
## QA
${r.qa?.passed ? 'Passed' : 'Not passed'}${r.qa?.score != null ? ` · score ${r.qa.score}/10` : ''} · scorecard ${r.scorecard?.totals?.passed ?? '-'} passed / ${r.scorecard?.totals?.failed ?? '-'} failed

## Files
${(r.outputs?.site_files ?? []).map((f: string) => `- \`site/${f}\``).join('\n')}
Package: \`${r.files?.package_dir ?? ''}\`

## Recommended next step
${r.recommended_next_step ?? '—'}
`);
    }
  }

  async syncHome(): Promise<void> {
    const { rows: projects } = await this.#d.db.query(`SELECT id, name, status, stage, created_at FROM projects ORDER BY created_at DESC LIMIT 50`);
    const { rows: [q] } = await this.#d.db.query(`SELECT count(*) FILTER (WHERE status IN ('RUNNING','ASSIGNED'))::int AS running, count(*) FILTER (WHERE status = 'QUEUED')::int AS queued, count(*) FILTER (WHERE status = 'FAILED')::int AS failed FROM tasks WHERE kind <> 'root'`);
    const { rows: [a] } = await this.#d.db.query(`SELECT count(*)::int AS n FROM approvals WHERE status = 'pending'`);
    const byDept = new Map<string, string[]>();
    for (const ag of specialists()) byDept.set(ag.department, [...(byDept.get(ag.department) ?? []), agentLink(ag.type)]);
    this.#write('Home.md', `${yaml({ apexweb: 'home', updated: new Date().toISOString(), tags: ['apexweb'] })}
# ApexWeb OS

**Now:** ${q.running} task(s) running · ${q.queued} queued · ${q.failed} failed · ${a.n} approval(s) waiting
*Updated ${new Date().toISOString().replace('T', ' ').slice(0, 16)} UTC — this note is rewritten automatically.*

> Start work by creating a note in \`ApexWeb/Inbox\`.

## Projects
${projects.map((p) => `- ${link(`${ROOT}/Projects/${noteName(p.name)} (${p.id})/Project`, p.name)} — ${p.status} · ${p.stage}`).join('\n') || '- none yet'}

## Team
${[...byDept.entries()].map(([d, list]) => `**${d}:** ${list.join(' · ')}`).join('\n\n')}
`);
  }

  /** Inbox notes become requests to the Main Agent. */
  async pollInbox(): Promise<number> {
    if (this.#inboxBusy) return 0;
    this.#inboxBusy = true;
    let n = 0;
    try {
      const dir = path.join(this.root, 'Inbox');
      if (!existsSync(dir)) return 0;
      for (const f of readdirSync(dir).filter((x) => x.endsWith('.md') && x !== 'README.md').sort()) {
        const abs = path.join(dir, f);
        // Skip notes still being typed (modified in the last 5 s).
        if (Date.now() - statSync(abs).mtimeMs < 5_000) continue;
        const raw = readFileSync(abs, 'utf8');
        const body = raw.replace(/^---[\s\S]*?---\s*/, '').trim();
        const message = body || path.basename(f, '.md');
        const r = await this.#d.submit(message.slice(0, 8000));
        const processed = path.join(dir, 'Processed', `${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')} ${noteName(path.basename(f, '.md'))}.md`);
        let projectLink = '';
        if (r.projectId) {
          const { rows } = await this.#d.db.query(`SELECT name FROM projects WHERE id = $1`, [r.projectId]);
          if (rows[0]) projectLink = `\nProject: ${link(`${ROOT}/Projects/${noteName(rows[0].name)} (${r.projectId})/Project`, rows[0].name)}\n`;
        }
        writeFileSync(processed, `${raw.trimEnd()}\n\n---\n**ApexWeb OS:** ${r.reply}\n${projectLink}`);
        rmSync(abs);
        if (r.projectId) this.#dirty.add(r.projectId);
        this.inboxProcessed++;
        n++;
      }
    } finally {
      this.#inboxBusy = false;
    }
    return n;
  }

  /**
   * The user's own notes (never the generated ApexWeb folder) that best match
   * the query. Returned text is screened; callers wrap it as untrusted data.
   */
  relevantNotes(query: string, limit = 4, maxChars = 1_500): Array<{ path: string; text: string; flags: string[] }> {
    const terms = [...new Set(query.toLowerCase().match(/[a-z0-9][a-z0-9-]{3,}/g) ?? [])].slice(0, 30);
    if (!terms.length || !existsSync(this.vault)) return [];
    const scored: Array<{ rel: string; score: number; text: string }> = [];
    const walk = (dir: string, depth: number) => {
      if (depth > 6 || scored.length > 5_000) return;
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        if (e.name.startsWith('.')) continue;
        const abs = path.join(dir, e.name);
        if (e.isDirectory()) {
          if (abs !== this.root) walk(abs, depth + 1);
        } else if (e.name.endsWith('.md')) {
          try {
            if (statSync(abs).size > 300_000) continue;
            const text = readFileSync(abs, 'utf8');
            const hay = `${e.name} ${text}`.toLowerCase();
            const score = terms.reduce((s, t) => s + (hay.includes(t) ? 1 + (e.name.toLowerCase().includes(t) ? 2 : 0) : 0), 0);
            if (score >= Math.min(2, terms.length)) scored.push({ rel: path.relative(this.vault, abs), score, text });
          } catch {
            /* unreadable note */
          }
        }
      }
    };
    walk(this.vault, 0);
    return scored.sort((a, b) => b.score - a.score).slice(0, limit).map((s) => {
      const r = screenText(s.text.slice(0, maxChars), `obsidian:${s.rel}`);
      return { path: s.rel, text: r.sanitized, flags: r.flags };
    });
  }
}
