import { z } from 'zod';

export const SKILL_CATEGORIES = ['website', 'visual', 'research', 'content', 'seo', 'code', 'client', 'files', 'devops', 'security', 'qa'] as const;

export const ValidationRuleSchema = z.object({ rule: z.string() }).passthrough();
export type ValidationRule = z.infer<typeof ValidationRuleSchema>;

export const SkillSchema = z.object({
  name: z.string().regex(/^[a-z0-9][a-z0-9-]{1,60}$/),
  version: z.string().regex(/^\d+\.\d+(\.\d+)?$/),
  title: z.string().min(3).max(80),
  category: z.enum(SKILL_CATEGORIES),
  description: z.string().min(10).max(600),
  when_to_use: z.string().min(10).max(600),
  /** Keywords that suggest this skill (Main Agent pre-selection). */
  triggers: z.array(z.string()).default([]),
  /** Project intents this skill naturally belongs to. */
  intents: z.array(z.string()).default([]),
  required_inputs: z.array(z.string()).default([]),
  /** Tools the skill uses; they only run if the executing agent's tool profile allows them. */
  tools: z.array(z.string()).default([]),
  instructions: z.array(z.string().min(5)).min(1),
  expected_outputs: z.array(z.string()).default([]),
  validation: z.array(ValidationRuleSchema).default([]),
  compatible_agents: z.array(z.string()).min(1),
  /** Composition: "name" (latest enabled) or "name@version". */
  sub_skills: z.array(z.string()).default([]),
  enabled: z.boolean().default(true),
  changes: z.string().default(''),
  created: z.string(),
});
export type SkillDefinition = z.infer<typeof SkillSchema>;

export interface SkillRef {
  name: string;
  version: string;
}

export function refString(r: SkillRef): string {
  return `${r.name}@${r.version}`;
}

export function parseRef(s: string): { name: string; version: string | null } {
  const [name, version] = s.split('@');
  return { name, version: version ?? null };
}

/** Numeric-aware version comparison ("1.10" > "1.9"). */
export function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}
