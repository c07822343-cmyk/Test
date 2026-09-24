// Skills Engine: a versioned registry of packaged capabilities. The Main Agent
// discovers skills, selects a chain for a project (with sub-skill
// composition), pins versions, and the engine loads the right skills into each
// agent's context, widens the agent's tool set (within its permission profile)
// and validates every output against the skills' rules.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { hasAgent } from '../agents/registry.ts';
import type { Db } from '../db/pool.ts';
import { extractJsonObject } from '../agents/output.ts';
import type { NvidiaProvider } from '../provider/provider.ts';
import { TOOL_NAMES } from '../tools/catalog.ts';
import { AppError } from '../util/common.ts';
import { errorMessage, logger } from '../util/log.ts';
import { compareVersions, parseRef, refString, SkillSchema, type SkillDefinition, type SkillRef } from './types.ts';
import { describeRule, knownRules, runValidations, type ValidationContext, type ValidationResult } from './validators.ts';

const log = logger('skills');

export interface ChainEntry {
  skill: string;
  reason: string;
  via: 'main_agent' | 'rule' | 'sub_skill' | 'template' | 'explicit';
}

export class SkillEngine {
  #db: Db;
  #dirs: string[];
  #defs = new Map<string, SkillDefinition[]>();
  #enabled = new Map<string, boolean>();

  constructor(db: Db, dirs: string[]) {
    this.#db = db;
    this.#dirs = dirs;
  }

  #key(name: string, version: string): string {
    return `${name}@${version}`;
  }

  #add(def: SkillDefinition): void {
    const list = this.#defs.get(def.name) ?? [];
    if (!list.some((d) => d.version === def.version)) list.push(def);
    list.sort((a, b) => compareVersions(a.version, b.version));
    this.#defs.set(def.name, list);
  }

  validateDefinition(raw: unknown): SkillDefinition {
    const def = SkillSchema.parse(raw);
    const problems: string[] = [];
    for (const a of def.compatible_agents) if (!hasAgent(a)) problems.push(`unknown agent ${a}`);
    for (const t of def.tools) if (!TOOL_NAMES.includes(t)) problems.push(`unknown tool ${t}`);
    const rules = knownRules();
    for (const v of def.validation) if (!rules.includes(v.rule)) problems.push(`unknown validation rule ${v.rule}`);
    if (problems.length) throw new AppError('invalid_skill', `Skill ${def.name}@${def.version}: ${problems.join('; ')}`);
    return def;
  }

  /** Loads skill files from the registry folders and persists every version. */
  async load(): Promise<{ loaded: number; errors: string[] }> {
    const errors: string[] = [];
    let loaded = 0;
    for (const dir of this.#dirs) {
      if (!existsSync(dir)) continue;
      for (const file of readdirSync(dir).filter((f) => f.endsWith('.json')).sort()) {
        try {
          const def = this.validateDefinition(JSON.parse(readFileSync(path.join(dir, file), 'utf8')));
          this.#add(def);
          await this.#db.query(
            `INSERT INTO skills (name, version, definition, changes, enabled, source) VALUES ($1, $2, $3, $4, $5, $6)
             ON CONFLICT (name, version) DO UPDATE SET definition = EXCLUDED.definition, changes = EXCLUDED.changes, updated_at = now()
             WHERE skills.source <> 'api'`,
            [def.name, def.version, JSON.stringify(def), def.changes, def.enabled, `file:${path.basename(dir)}`],
          );
          loaded++;
        } catch (err) {
          errors.push(`${file}: ${errorMessage(err)}`);
        }
      }
    }
    // API-registered versions and persisted enable/disable state.
    const { rows } = await this.#db.query('SELECT name, version, definition, enabled FROM skills');
    for (const r of rows) {
      try {
        this.#add(this.validateDefinition(r.definition));
        this.#enabled.set(this.#key(r.name, r.version), r.enabled);
      } catch (err) {
        errors.push(`db ${r.name}@${r.version}: ${errorMessage(err)}`);
      }
    }
    // Every sub-skill must resolve.
    for (const def of this.all()) {
      for (const sub of def.sub_skills) {
        if (!this.resolve(sub)) errors.push(`${def.name}@${def.version}: sub-skill ${sub} does not resolve`);
      }
    }
    if (errors.length) log.warn('skill load problems', { errors });
    return { loaded, errors };
  }

  all(): SkillDefinition[] {
    return [...this.#defs.values()].flat();
  }

  isEnabled(name: string, version: string): boolean {
    return this.#enabled.get(this.#key(name, version)) ?? this.get(name, version)?.enabled ?? false;
  }

  get(name: string, version: string): SkillDefinition | undefined {
    return this.#defs.get(name)?.find((d) => d.version === version);
  }

  /** "name" -> latest enabled version; "name@x.y" -> that exact version (even if a newer one exists). */
  resolve(ref: string): SkillDefinition | undefined {
    const { name, version } = parseRef(ref);
    const list = this.#defs.get(name) ?? [];
    if (version) return list.find((d) => d.version === version);
    return [...list].reverse().find((d) => this.isEnabled(d.name, d.version));
  }

  latest(): SkillDefinition[] {
    return [...this.#defs.keys()].map((n) => this.resolve(n)).filter((d): d is SkillDefinition => !!d);
  }

  catalog() {
    return [...this.#defs.entries()].map(([name, versions]) => ({
      name,
      latest: this.resolve(name)?.version ?? null,
      versions: versions.map((v) => ({ version: v.version, enabled: this.isEnabled(name, v.version), changes: v.changes, created: v.created })),
      title: versions[versions.length - 1].title,
      category: versions[versions.length - 1].category,
      description: versions[versions.length - 1].description,
      when_to_use: versions[versions.length - 1].when_to_use,
      compatible_agents: versions[versions.length - 1].compatible_agents,
      sub_skills: versions[versions.length - 1].sub_skills,
      tools: versions[versions.length - 1].tools,
    }));
  }

  async register(raw: unknown, actor: string): Promise<SkillDefinition> {
    const def = this.validateDefinition(raw);
    const existing = this.#defs.get(def.name) ?? [];
    if (existing.some((d) => d.version === def.version)) throw new AppError('version_exists', `${def.name}@${def.version} already exists; publish a new version`, 409);
    const newest = existing[existing.length - 1];
    if (newest && compareVersions(def.version, newest.version) <= 0) throw new AppError('version_not_newer', `New version must be greater than ${newest.version}`, 409);
    await this.#db.query(`INSERT INTO skills (name, version, definition, changes, enabled, source) VALUES ($1, $2, $3, $4, $5, 'api')`, [def.name, def.version, JSON.stringify(def), def.changes, def.enabled]);
    this.#add(def);
    this.#enabled.set(this.#key(def.name, def.version), def.enabled);
    log.info('skill version registered', { skill: refString(def), actor });
    return def;
  }

  async setEnabled(name: string, version: string, enabled: boolean): Promise<void> {
    if (!this.get(name, version)) throw new AppError('not_found', `Skill ${name}@${version} not found`, 404);
    await this.#db.query('UPDATE skills SET enabled = $3, updated_at = now() WHERE name = $1 AND version = $2', [name, version, enabled]);
    this.#enabled.set(this.#key(name, version), enabled);
  }

  /** Expands a chain with sub-skills (depth-first, cycle-safe) and pins versions. */
  expand(entries: Array<{ skill: string; reason: string; via: ChainEntry['via'] }>): ChainEntry[] {
    const out: ChainEntry[] = [];
    const seen = new Set<string>();
    const visit = (ref: string, reason: string, via: ChainEntry['via'], stack: string[]) => {
      const def = this.resolve(ref);
      if (!def) return;
      const pinned = refString(def);
      if (stack.includes(def.name)) return; // cycle
      if (!seen.has(def.name)) {
        seen.add(def.name);
        out.push({ skill: pinned, reason, via });
      }
      for (const sub of def.sub_skills) visit(sub, `required by ${def.name}`, 'sub_skill', [...stack, def.name]);
    };
    for (const e of entries) visit(e.skill, e.reason, e.via, []);
    return out;
  }

  /** Deterministic pre-selection: intent match + trigger keywords in the request. */
  scoreCandidates(intent: string, text: string): Array<{ name: string; score: number; reasons: string[] }> {
    const lower = text.toLowerCase();
    return this.latest()
      .map((d) => {
        const reasons: string[] = [];
        let score = 0;
        if (d.intents.includes(intent)) {
          score += 5;
          reasons.push(`fits ${intent}`);
        }
        for (const t of d.triggers) {
          if (lower.includes(t.toLowerCase())) {
            score += 2;
            reasons.push(`mentions "${t}"`);
          }
        }
        return { name: d.name, score, reasons };
      })
      .filter((c) => c.score > 0)
      .sort((a, b) => b.score - a.score);
  }

  /** Main Agent skill selection: rule-based candidates refined by the planning model. */
  async select(input: { projectId: string; intent: string; request: string; summary: string }, provider: NvidiaProvider): Promise<{ chain: ChainEntry[]; method: 'main_agent' | 'rule' }> {
    const candidates = this.scoreCandidates(input.intent, `${input.request}\n${input.summary}`);
    const ruleChain = candidates.filter((c) => c.score >= 5).map((c) => ({ skill: c.name, reason: c.reasons.join('; '), via: 'rule' as const }));
    const catalog = this.latest().map((d) => `- ${d.name}: ${d.when_to_use}`).join('\n');
    try {
      const res = await provider.requestModel({
        capability: 'planning',
        maxTokens: 1500,
        temperature: 0.1,
        metadata: { purpose: 'main_agent:skills', projectId: input.projectId, priority: 95 },
        messages: [
          { role: 'system', content: `You are the ApexWeb Main Agent choosing which skills this project needs. Choose only skills that genuinely apply; do not add 3D, motion or other enhancements unless they serve the request. Reply with JSON: {"skills":[{"name": string, "reason": string}]}.\nSKILL CATALOG:\n${catalog}` },
          { role: 'user', content: `Intent: ${input.intent}\nRequest: ${input.request}\nSummary: ${input.summary}\nRule-based candidates: ${candidates.slice(0, 20).map((c) => `${c.name} (${c.reasons.join(', ')})`).join('; ')}` },
        ],
      });
      const json = extractJsonObject(res.content);
      const parsed = z.object({ skills: z.array(z.object({ name: z.string(), reason: z.string().default('') })).min(1).max(40) }).parse(JSON.parse(json ?? '{}'));
      const valid = parsed.skills.filter((s) => this.resolve(s.name));
      if (valid.length) {
        return { chain: this.expand(valid.map((s) => ({ skill: s.name, reason: s.reason || 'selected by Main Agent', via: 'main_agent' as const }))), method: 'main_agent' };
      }
    } catch (err) {
      log.warn('model skill selection failed; using rule-based chain', { error: errorMessage(err) });
    }
    return { chain: this.expand(ruleChain), method: 'rule' };
  }

  /** Skills from a chain that a given agent can execute. */
  forAgent(chain: string[], agentType: string): string[] {
    return chain.filter((ref) => this.resolve(ref)?.compatible_agents.includes(agentType));
  }

  tools(refs: string[]): string[] {
    return [...new Set(refs.flatMap((r) => this.resolve(r)?.tools ?? []))];
  }

  /** Prompt block injected into the agent's context for its loaded skills. */
  promptBlock(refs: string[]): string {
    return refs
      .map((r) => this.resolve(r))
      .filter((d): d is SkillDefinition => !!d)
      .map((d) => [
        `### SKILL ${refString(d)} — ${d.title}`,
        d.description,
        `Instructions:\n${d.instructions.map((i) => `- ${i}`).join('\n')}`,
        d.expected_outputs.length ? `Expected outputs:\n${d.expected_outputs.map((o) => `- ${o}`).join('\n')}` : '',
        d.validation.length ? `Your output is automatically validated against: ${d.validation.map(describeRule).join('; ')}` : '',
      ].filter(Boolean).join('\n'))
      .join('\n\n');
  }

  validate(refs: string[], ctx: ValidationContext): ValidationResult[] {
    return refs.flatMap((r) => {
      const d = this.resolve(r);
      return d ? runValidations(refString(d), d.validation, ctx) : [];
    });
  }
}

export type { SkillRef };
