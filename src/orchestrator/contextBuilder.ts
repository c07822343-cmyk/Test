// Context Builder: assembles exactly what one agent needs for one task -
// mission, project brief, direct upstream outputs, relevant files, tool
// evidence, revision feedback - within a size budget. It deliberately does not
// forward the whole project history to every agent.
import type { Db } from '../db/pool.ts';
import { allowedSubAgents, getAgent } from '../agents/registry.ts';
import type { AgentDefinition } from '../agents/types.ts';
import type { ArtifactStore } from '../memory/artifacts.ts';
import type { MemoryStore } from '../memory/memory.ts';
import type { ChatContentPart, ChatMessage } from '../provider/nvidiaClient.ts';
import type { ModelSpec } from '../provider/modelRegistry.ts';
import type { TaskRow } from '../queue/types.ts';
import { UNTRUSTED_POLICY } from '../security/untrusted.ts';
import type { ToolResult } from '../tools/runner.ts';
import { truncate } from '../util/common.ts';
import type { KnowledgeBase } from '../knowledge/kb.ts';
import type { SkillEngine } from '../skills/engine.ts';

interface Section {
  title: string;
  body: string;
  /** Lower = trimmed first when over budget. */
  priority: number;
  minChars?: number;
}

export interface BuiltContext {
  messages: ChatMessage[];
  stats: { chars: number; budget: number; sections: Array<{ title: string; chars: number; trimmed: boolean }>; images: number };
}

function json(v: unknown): string {
  return JSON.stringify(v, null, 1);
}

export class ContextBuilder {
  #db: Db;
  #memory: MemoryStore;
  #artifacts: ArtifactStore;
  #skills: SkillEngine | null = null;
  #kb: KnowledgeBase | null = null;

  constructor(db: Db, memory: MemoryStore, artifacts: ArtifactStore) {
    this.#db = db;
    this.#memory = memory;
    this.#artifacts = artifacts;
  }

  attach(opts: { skills: SkillEngine; knowledge: KnowledgeBase }): void {
    this.#skills = opts.skills;
    this.#kb = opts.knowledge;
  }

  systemPrompt(agent: AgentDefinition, task: TaskRow, globalRules: any, lessons: string[], skillsBlock = ''): string {
    const subAgents = task.phase === 'execute' ? allowedSubAgents(agent.type) : [];
    const parts = [
      `You are the ${agent.name}, a specialist worker inside the ApexWeb agent operating system. You receive one task from the ApexWeb Main Agent and return one structured result.`,
      `ROLE: ${agent.mission}`,
      `WORKING RULES:\n${agent.instructions.map((i) => `- ${i}`).join('\n')}`,
      `APEXWEB QUALITY PRINCIPLES:\n${(globalRules?.quality_principles ?? []).map((r: string) => `- ${r}`).join('\n')}`,
      `HONESTY RULES (non-negotiable):\n${(globalRules?.honesty_rules ?? []).map((r: string) => `- ${r}`).join('\n')}`,
      `ANTI-SLOP RULES:\n${(globalRules?.anti_slop_rules ?? []).map((r: string) => `- ${r}`).join('\n')}`,
      `EXISTING-SITE RULES:\n${(globalRules?.existing_site_rules ?? []).map((r: string) => `- ${r}`).join('\n')}`,
      UNTRUSTED_POLICY,
    ];
    if (lessons.length) parts.push(`LESSONS FROM PREVIOUS REVIEWS OF YOUR WORK (avoid repeating these):\n${lessons.slice(-8).map((l) => `- ${l}`).join('\n')}`);
    if (skillsBlock) parts.push(`LOADED APEXWEB SKILLS (apply all of them; your output is validated against their rules):\n${skillsBlock}`);
    parts.push('EVIDENCE LEVELS: only CONFIRMED FACTS may be stated as facts about the client. SOURCE-DERIVED claims must be phrased cautiously or confirmed; INFERENCES and UNVERIFIED items must never be presented as confirmed business facts.');
    const protocol = [
      'OUTPUT PROTOCOL (mandatory):',
      'Reply with exactly one JSON object (optionally inside a ```json fence) with these fields:',
      '{',
      '  "status": "completed" | "needs_revision" | "blocked",',
      '  "summary": "2-4 factual sentences on what you produced",',
      `  "result": ${agent.resultShape},`,
      '  "confidence": number between 0 and 1,',
      '  "assumptions": [string],',
      '  "unresolved_issues": [string],',
      '  "recommended_next_action": string or null' + (subAgents.length ? ',' : ''),
      ...(subAgents.length ? ['  "subtasks": [{"agent_type": string, "title": string, "mission": string, "depends_on": [index of earlier subtask], "inputs": {}}]'] : []),
      '}',
    ];
    if (agent.reviewer) {
      protocol.push('You are a reviewer: "result" IS your review object. Use "reject" only for problems that genuinely must change before this work can ship, and give precise, actionable fixes (file/selector/section and the change). Add "revision_instructions" (string) to the result when rejecting.');
    }
    if (agent.producesFiles) {
      protocol.push('After the JSON, write every file you create or change as a complete file:', '<<<FILE path="relative/path.ext">>>', '...entire file content...', '<<<END FILE>>>', 'Site file paths are relative to the site root (e.g. index.html, styles.css, main.js). Documentation paths start with docs/. Never truncate a file or write "unchanged" placeholders.');
    }
    if (subAgents.length) {
      protocol.push(`You MAY delegate parts of this task to sub-agents when the work is complex enough to benefit from focused parallel specialists. Allowed agent types: ${subAgents.join(', ')}. If you delegate, return your plan in "result" and list the subtasks; you will be called again with their results to synthesise the final output. Do not delegate trivial work, and never delegate when you can finish the task directly in this response.`);
    }
    if (task.phase === 'synthesize') protocol.push('PHASE: SYNTHESISE. Your sub-agents have finished (their results are below). Produce your final result now; do not request subtasks.');
    protocol.push('Write nothing outside the JSON object and FILE blocks. Do not include hidden reasoning.');
    parts.push(protocol.join('\n'));
    return parts.join('\n\n');
  }

  async build(task: TaskRow, model: ModelSpec): Promise<BuiltContext> {
    const agent = getAgent(task.agent_type);
    const globalRules = (await this.#memory.get('global', 'apexweb', 'rules')) ?? {};
    const lessons = ((await this.#memory.get<string[]>('agent', agent.type, 'lessons')) ?? []).map(String);
    const brief = (await this.#memory.get('project', task.project_id, 'brief')) ?? {};
    const facts = (await this.#memory.get<string[]>('project', task.project_id, 'facts')) ?? [];
    const sections: Section[] = [];
    const { rows: projRows } = await this.#db.query('SELECT blueprint, stage, mode FROM projects WHERE id = $1', [task.project_id]);
    const blueprint = projRows[0]?.blueprint;

    sections.push({
      title: 'TASK',
      priority: 100,
      body: json({
        task_id: task.id,
        title: task.title,
        mission: task.mission,
        kind: task.kind,
        attempt: task.attempt,
        revision: task.revision,
        inputs: Object.fromEntries(Object.entries(task.inputs ?? {}).filter(([k]) => !['revision_feedback', 'issues', 'urls', 'children', 'spawn_round', 'previous_attempt_error', 'rescued', 'failure_count', 'models_tried'].includes(k))),
      }),
    });
    sections.push({ title: 'PROJECT BRIEF', priority: 95, body: json(brief) });
    if (blueprint) sections.push({ title: 'PROJECT BLUEPRINT (source of truth — do not contradict it)', priority: 93, minChars: 3000, body: json(blueprint) });
    const { rows: claims } = await this.#db.query(
      `SELECT statement, classification, source_ids FROM research_claims WHERE project_id = $1 AND classification <> 'VERIFIED_FACT' ORDER BY classification, created_at LIMIT 60`,
      [task.project_id],
    );
    if (claims.length) {
      sections.push({
        title: 'UNCONFIRMED RESEARCH (not facts: phrase cautiously or use placeholders)',
        priority: 62,
        body: claims.map((c) => `- [${c.classification}] ${c.statement}${c.source_ids.length ? ` (sources: ${c.source_ids.join(', ')})` : ''}`).join('\n'),
      });
    }
    if (this.#kb) {
      const tags = [agent.type, agent.department, ...(task.skills ?? []).map((sk) => sk.split('@')[0])];
      const knowledge = await this.#kb.retrieve(tags, 6);
      if (knowledge.length) sections.push({ title: 'APEXWEB KNOWLEDGE BASE', priority: 45, body: knowledge.map((k) => `- [${k.category}] ${k.title}: ${k.content}`).join('\n') });
    }
    if (facts.length) sections.push({ title: 'CONFIRMED FACTS (only these may be stated as facts about the client)', priority: 94, body: facts.map((f) => `- ${f}`).join('\n') });

    const feedback: any[] = task.inputs?.revision_feedback ?? [];
    if (feedback.length) {
      sections.push({ title: 'REVISION FEEDBACK (you must address every point)', priority: 98, body: json(feedback.slice(-3)) });
    }
    if (task.inputs?.issues) sections.push({ title: 'ISSUES TO FIX', priority: 98, body: json(task.inputs.issues) });
    const prev = task.inputs?.previous_attempt_error;
    if (prev) sections.push({ title: 'YOUR PREVIOUS ATTEMPT WAS REJECTED BY VALIDATION', priority: 99, body: String(prev) });

    // Direct upstream outputs only.
    if (task.dependencies.length) {
      const { rows } = await this.#db.query(
        `SELECT id, plan_key, agent_type, title, status, outputs, kind, review_target FROM tasks WHERE id = ANY($1::text[]) ORDER BY created_at`,
        [task.dependencies],
      );
      // A dependency on a review gate means "the approved work": include the gated output itself.
      const gated = rows.filter((d) => d.kind === 'review' && d.review_target && !task.dependencies.includes(d.review_target)).map((d) => d.review_target);
      if (gated.length) {
        const extra = await this.#db.query(
          `SELECT id, plan_key, agent_type, title, status, outputs, kind, review_target FROM tasks WHERE id = ANY($1::text[])`,
          [gated],
        );
        rows.push(...extra.rows);
      }
      for (const d of rows) {
        if (d.id === task.review_target) continue;
        if (!d.outputs) continue;
        if (d.kind === 'review') {
          sections.push({
            title: `REVIEW VERDICT: ${getAgent(d.agent_type).name} — ${d.title}`,
            priority: 66,
            body: json({ verdict: d.outputs.review?.verdict, remaining_issues: d.outputs.review?.issues, summary: d.outputs.summary }),
          });
          continue;
        }
        sections.push({
          title: `UPSTREAM OUTPUT: ${getAgent(d.agent_type).name} — ${d.title}`,
          priority: 70,
          minChars: 1500,
          body: json({ summary: d.outputs.summary, result: d.outputs.result, unresolved_issues: d.outputs.unresolved_issues, files: d.outputs.files }),
        });
      }
    }
    if (task.review_target) {
      const { rows } = await this.#db.query('SELECT agent_type, title, outputs, revision FROM tasks WHERE id = $1', [task.review_target]);
      const t = rows[0];
      if (t) {
        sections.push({
          title: `WORK UNDER REVIEW: ${getAgent(t.agent_type).name} — ${t.title} (revision ${t.revision})`,
          priority: 90,
          minChars: 4000,
          body: json({ summary: t.outputs?.summary, result: t.outputs?.result, assumptions: t.outputs?.assumptions, unresolved_issues: t.outputs?.unresolved_issues, files: t.outputs?.files }),
        });
      }
    }
    if (task.phase === 'synthesize') {
      const children: string[] = task.inputs?.children ?? [];
      const { rows } = await this.#db.query(
        `SELECT agent_type, title, status, outputs, error FROM tasks WHERE parent_task_id = $1 AND id = ANY($2::text[]) ORDER BY created_at`,
        [task.id, children],
      );
      sections.push({
        title: 'SUB-AGENT RESULTS',
        priority: 92,
        minChars: 3000,
        body: json(rows.map((r) => ({ agent: r.agent_type, title: r.title, status: r.status, summary: r.outputs?.summary, result: r.outputs?.result, review: r.outputs?.review, error: r.error?.message }))),
      });
      if (task.outputs?.result) sections.push({ title: 'YOUR DELEGATION PLAN', priority: 80, body: json(task.outputs.result) });
    }
    if (task.parent_task_id) {
      const { rows } = await this.#db.query('SELECT agent_type, title, mission FROM tasks WHERE id = $1', [task.parent_task_id]);
      if (rows[0]) sections.push({ title: 'PARENT TASK', priority: 85, body: json({ agent: rows[0].agent_type, title: rows[0].title, mission: rows[0].mission }) });
    }

    const tools = (await this.#memory.get<ToolResult[]>('task', task.id, 'tool_results')) ?? [];
    const images: Array<{ label: string; path: string }> = [];
    for (const t of tools) {
      const untrusted = t.untrusted_blocks ?? [];
      sections.push({
        title: `TOOL EVIDENCE: ${t.tool}${t.available ? '' : ' (UNAVAILABLE)'}`,
        priority: 88,
        minChars: 2000,
        body: json({ ok: t.ok, available: t.available, error: t.error, hard_failures: t.hard_failures, findings: t.findings.slice(0, 60), summary: t.summary, injection_flags: t.injection_flags }),
      });
      if (untrusted.length) sections.push({ title: `EXTERNAL SOURCES (${t.tool})`, priority: 60, minChars: 3000, body: untrusted.join('\n\n') });
      for (const img of t.images ?? []) images.push({ label: img.label, path: img.artifact_path });
    }

    if (agent.artifacts === 'site' || agent.artifacts === 'all') {
      const site = await this.#artifacts.latestText(task.project_id, 'site/');
      const names = Object.keys(site);
      if (names.length) {
        sections.push({
          title: `CURRENT SITE FILES (${names.length})`,
          priority: agent.producesFiles || agent.reviewer ? 87 : 50,
          minChars: 8000,
          body: names.map((n) => `<<<CURRENT FILE path="${n}">>>\n${site[n]}\n<<<END CURRENT FILE>>>`).join('\n'),
        });
      }
    }
    if (agent.artifacts === 'docs' || agent.artifacts === 'all') {
      const docs = await this.#artifacts.latestText(task.project_id, 'docs/');
      if (Object.keys(docs).length) sections.push({ title: 'CURRENT DOCS', priority: 55, body: Object.entries(docs).map(([n, c]) => `<<<CURRENT FILE path="docs/${n}">>>\n${c}\n<<<END CURRENT FILE>>>`).join('\n') });
      const { rows } = await this.#db.query(
        `SELECT agent_type, title, status, outputs->>'summary' AS summary, outputs->'unresolved_issues' AS unresolved FROM tasks
         WHERE project_id = $1 AND kind <> 'root' AND id <> $2 ORDER BY created_at`,
        [task.project_id, task.id],
      );
      sections.push({ title: 'PROJECT TASK LOG', priority: 65, body: json(rows) });
    }

    // Budget: leave room for the answer. ~3 chars per token is conservative for mixed code/prose.
    const budget = Math.max(24_000, Math.min(model.context_window - agent.maxTokens - 4_000, 48_000) * 3);
    const trimmedFlags = fitToBudget(sections, budget);
    const userText = sections.map((s) => `## ${s.title}\n${s.body}`).join('\n\n');
    const system = this.systemPrompt(agent, task, globalRules, lessons, this.#skills?.promptBlock(task.skills ?? []) ?? '');

    let userContent: string | ChatContentPart[] = userText;
    let imageCount = 0;
    if (agent.capability === 'vision' && images.length && model.vision) {
      const parts: ChatContentPart[] = [{ type: 'text', text: userText }];
      for (const img of images.slice(0, 3)) {
        const a = await this.#artifacts.get(task.project_id, img.path);
        if (!a) continue;
        parts.push({ type: 'text', text: `Screenshot: ${img.label}` });
        parts.push({ type: 'image_url', image_url: { url: `data:${a.content_type};base64,${a.content.toString('base64')}` } });
        imageCount++;
      }
      userContent = parts;
    }
    return {
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: userContent },
      ],
      stats: {
        chars: system.length + userText.length,
        budget,
        sections: sections.map((s, i) => ({ title: s.title, chars: s.body.length, trimmed: trimmedFlags[i] })),
        images: imageCount,
      },
    };
  }
}

/** Trims lowest-priority sections first until the total fits. */
function fitToBudget(sections: Section[], budget: number): boolean[] {
  const trimmed = sections.map(() => false);
  let total = sections.reduce((n, s) => n + s.body.length + s.title.length + 8, 0);
  const order = sections.map((s, i) => i).sort((a, b) => sections[a].priority - sections[b].priority);
  for (const i of order) {
    if (total <= budget) break;
    const s = sections[i];
    const floor = s.minChars ?? 800;
    if (s.body.length <= floor) continue;
    const excess = total - budget;
    const target = Math.max(floor, s.body.length - excess);
    total -= s.body.length - target;
    s.body = truncate(s.body, target);
    trimmed[i] = true;
  }
  return trimmed;
}
