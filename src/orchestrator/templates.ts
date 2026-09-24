// ApexWeb workflow templates, loaded from the workflows/ registry folder (and
// any extension folders). A template is only an initial task graph: the Main
// Agent's planner adapts it per request, and the queue runs each task as soon
// as its own dependencies are complete.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

export const INTENTS = [
  'local_business_website', 'new_demo', 'new_website', '3d_website', 'landing_page', 'website_redesign', 'website_improvement',
  'website_audit', 'seo_audit', 'emergency_bug_fix', 'client_revision', 'competitor_research', 'prelaunch_qa', 'quick_task',
  'research_only', 'content_only', 'proposal',
] as const;
export type Intent = (typeof INTENTS)[number];

export interface PlanTask {
  key: string;
  agent_type: string;
  title: string;
  mission: string;
  depends_on: string[];
  priority: number;
  optional?: boolean;
  /** Review gate: this task reviews `review_of` and may send it back for revision. */
  review_of?: string | null;
  /** Final QA gate: rejection starts a bounded fix cycle. */
  qa_gate?: boolean;
  /** Visual QA gate: render/compare loop with bounded refinement cycles. */
  visual_qa_gate?: boolean;
  /** Main Agent triage of independent review findings. */
  triage?: boolean;
  /** Human approval checkpoint (only kept when the gate is active for the project). */
  approval_gate?: string | null;
  priority_class?: 'CRITICAL' | 'HIGH' | 'NORMAL' | 'LOW' | 'BACKGROUND';
  stage?: string;
  /** Extra skills for this task beyond those the project chain assigns. */
  skills?: string[];
}

export interface WorkflowTemplate {
  intent: string;
  label: string;
  description: string;
  triggers: string[];
  tasks: PlanTask[];
  /** Keys the planner may never drop. */
  required: string[];
  source?: string;
}

const PlanTaskFile = z.object({
  key: z.string(), agent_type: z.string(), title: z.string(), mission: z.string(), depends_on: z.array(z.string()).default([]), priority: z.number(),
  optional: z.boolean().optional(), review_of: z.string().nullable().optional(), qa_gate: z.boolean().optional(), visual_qa_gate: z.boolean().optional(),
  triage: z.boolean().optional(), approval_gate: z.string().nullable().optional(), priority_class: z.enum(['CRITICAL', 'HIGH', 'NORMAL', 'LOW', 'BACKGROUND']).optional(),
  stage: z.string().optional(), skills: z.array(z.string()).optional(),
});
const TemplateFile = z.object({
  intent: z.string().regex(/^[a-z0-9_]+$/), label: z.string(), description: z.string(), triggers: z.array(z.string()).default([]),
  required: z.array(z.string()), tasks: z.array(PlanTaskFile).min(1),
});

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
let REGISTRY = new Map<string, WorkflowTemplate>();

export function loadTemplates(dirs: string[] = [path.join(ROOT, 'workflows')]): { loaded: number; errors: string[] } {
  const next = new Map<string, WorkflowTemplate>();
  const errors: string[] = [];
  for (const dir of dirs) {
    if (!existsSync(dir)) continue;
    for (const f of readdirSync(dir).filter((x) => x.endsWith('.json')).sort()) {
      try {
        const t = TemplateFile.parse(JSON.parse(readFileSync(path.join(dir, f), 'utf8')));
        const keys = new Set(t.tasks.map((x) => x.key));
        for (const x of t.tasks) for (const d of x.depends_on) if (!keys.has(d)) throw new Error(`${x.key} depends on unknown ${d}`);
        for (const r of t.required) if (!keys.has(r)) throw new Error(`required key ${r} not in template`);
        next.set(t.intent, { ...t, source: `${path.basename(dir)}/${f}` });
      } catch (err) {
        errors.push(`${f}: ${(err as Error).message}`);
      }
    }
  }
  REGISTRY = next;
  return { loaded: next.size, errors };
}

export function templates(): WorkflowTemplate[] {
  if (REGISTRY.size === 0) loadTemplates();
  return [...REGISTRY.values()];
}

export function templateFor(intent: string): WorkflowTemplate {
  if (REGISTRY.size === 0) loadTemplates();
  const tpl = REGISTRY.get(intent);
  if (!tpl) throw new Error(`No workflow template for intent ${intent}`);
  return tpl;
}

export function hasTemplate(intent: string): boolean {
  if (REGISTRY.size === 0) loadTemplates();
  return REGISTRY.has(intent);
}
