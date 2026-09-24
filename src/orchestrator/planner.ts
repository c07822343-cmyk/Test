// Plan validation and normalisation. Whatever the Task Decomposer model
// returns, only a valid DAG over registered specialists reaches the queue.
import { z } from 'zod';
import { getAgent, hasAgent } from '../agents/registry.ts';
import type { PlanTask, WorkflowTemplate } from './templates.ts';

export const PlanTaskSchema = z.object({
  key: z.string().regex(/^[a-z0-9_]{2,40}$/),
  agent_type: z.string(),
  title: z.string().min(3).max(160),
  mission: z.string().min(10).max(3000),
  depends_on: z.array(z.string()).default([]),
  priority: z.coerce.number().int().min(0).max(100).default(50),
  optional: z.boolean().optional(),
  review_of: z.string().nullable().optional(),
  qa_gate: z.boolean().optional(),
  visual_qa_gate: z.boolean().optional(),
  triage: z.boolean().optional(),
  approval_gate: z.string().nullable().optional(),
  priority_class: z.enum(['CRITICAL', 'HIGH', 'NORMAL', 'LOW', 'BACKGROUND']).optional(),
  stage: z.string().optional(),
  skills: z.array(z.string()).optional(),
});
export const PlanSchema = z.object({ tasks: z.array(PlanTaskSchema).min(1).max(40), rationale: z.string().max(4000).optional() });

export interface ValidatedPlan {
  tasks: PlanTask[];
  warnings: string[];
}

export class PlanValidationError extends Error {
  readonly errors: string[];
  constructor(errors: string[]) {
    super(`Invalid plan: ${errors.join('; ')}`);
    this.errors = errors;
  }
}

export function topoOrder(tasks: PlanTask[]): string[] | null {
  const indeg = new Map(tasks.map((t) => [t.key, 0]));
  for (const t of tasks) for (const d of t.depends_on) if (indeg.has(d)) indeg.set(t.key, (indeg.get(t.key) ?? 0) + 1);
  const queue = [...indeg.entries()].filter(([, n]) => n === 0).map(([k]) => k);
  const order: string[] = [];
  while (queue.length) {
    const k = queue.shift()!;
    order.push(k);
    for (const t of tasks) {
      if (t.depends_on.includes(k)) {
        const n = (indeg.get(t.key) ?? 0) - 1;
        indeg.set(t.key, n);
        if (n === 0) queue.push(t.key);
      }
    }
  }
  return order.length === tasks.length ? order : null;
}

/**
 * Validates a proposed plan against the registry and the template's required
 * stages, re-inserting required stages the model dropped, and rewrites
 * dependencies so work behind a review gate is consumed only after approval.
 */
export function validatePlan(proposed: PlanTask[], template: WorkflowTemplate): ValidatedPlan {
  const errors: string[] = [];
  const warnings: string[] = [];
  const tasks: PlanTask[] = proposed.map((t) => ({ ...t, depends_on: [...new Set(t.depends_on)] }));
  const keys = new Set<string>();
  for (const t of tasks) {
    if (keys.has(t.key)) errors.push(`duplicate key ${t.key}`);
    keys.add(t.key);
    if (!hasAgent(t.agent_type)) errors.push(`${t.key}: unknown agent type ${t.agent_type}`);
    else {
      const a = getAgent(t.agent_type);
      if (a.parent) errors.push(`${t.key}: ${t.agent_type} is a sub-agent and cannot be planned directly`);
      if (t.agent_type === 'task_decomposer') errors.push(`${t.key}: task_decomposer cannot be a queued task`);
      if (t.agent_type === 'main_orchestrator' && !t.triage && !t.approval_gate) errors.push(`${t.key}: the Main Agent only takes triage and approval tasks`);
      if (t.triage && t.agent_type !== 'main_orchestrator') errors.push(`${t.key}: triage is performed by the Main Agent`);
      if ((t.qa_gate || t.visual_qa_gate) && !a.reviewer) errors.push(`${t.key}: ${t.agent_type} is not a reviewer and cannot be a QA gate`);
      if (t.review_of && !a.reviewer) errors.push(`${t.key}: ${t.agent_type} is not a reviewer and cannot gate ${t.review_of}`);
    }
  }
  // Re-insert required stages the model dropped.
  for (const req of template.required) {
    if (!keys.has(req)) {
      const original = template.tasks.find((t) => t.key === req)!;
      tasks.push({ ...original, depends_on: original.depends_on.filter((d) => keys.has(d) || template.required.includes(d)) });
      keys.add(req);
      warnings.push(`required stage "${req}" was missing and has been restored`);
    }
  }
  for (const t of tasks) {
    const unknown = t.depends_on.filter((d) => !keys.has(d));
    if (unknown.length) {
      // Dependencies on removed optional tasks are dropped rather than failing the plan.
      const droppable = unknown.filter((d) => template.tasks.some((x) => x.key === d && x.optional) || !template.tasks.some((x) => x.key === d));
      t.depends_on = t.depends_on.filter((d) => keys.has(d));
      if (droppable.length !== unknown.length) errors.push(`${t.key}: depends on unknown tasks ${unknown.join(', ')}`);
      else warnings.push(`${t.key}: dropped dependencies on removed tasks ${unknown.join(', ')}`);
    }
    if (t.depends_on.includes(t.key)) errors.push(`${t.key}: depends on itself`);
    if (t.review_of && !keys.has(t.review_of)) errors.push(`${t.key}: reviews unknown task ${t.review_of}`);
    if (t.review_of && !t.depends_on.includes(t.review_of)) t.depends_on.push(t.review_of);
  }
  if (errors.length) throw new PlanValidationError(errors);
  // Gate rewrite: consumers of gated work depend on the gate instead.
  for (const gate of tasks.filter((t) => t.review_of)) {
    for (const t of tasks) {
      if (t.key === gate.key) continue;
      if (t.depends_on.includes(gate.review_of!)) {
        t.depends_on = [...new Set(t.depends_on.map((d) => (d === gate.review_of ? gate.key : d)))];
      }
    }
  }
  if (!topoOrder(tasks)) throw new PlanValidationError(['dependency cycle detected']);
  return { tasks, warnings };
}

/**
 * Removes approval checkpoints whose gate is not active for this project,
 * rewiring their dependents to the checkpoint's own dependencies.
 */
export function applyGates(tasks: PlanTask[], activeGates: string[]): PlanTask[] {
  const drop = new Map(tasks.filter((t) => t.approval_gate && !activeGates.includes(t.approval_gate)).map((t) => [t.key, t.depends_on]));
  return tasks
    .filter((t) => !drop.has(t.key))
    .map((t) => ({ ...t, depends_on: [...new Set(t.depends_on.flatMap((d) => drop.get(d) ?? [d]))] }));
}

/** Width of each dependency level - used to show how much parallelism the plan exposes. */
export function parallelLevels(tasks: PlanTask[]): string[][] {
  const level = new Map<string, number>();
  const order = topoOrder(tasks) ?? [];
  for (const k of order) {
    const t = tasks.find((x) => x.key === k)!;
    level.set(k, t.depends_on.length ? Math.max(...t.depends_on.map((d) => (level.get(d) ?? 0) + 1)) : 0);
  }
  const levels: string[][] = [];
  for (const [k, l] of level) (levels[l] ??= []).push(k);
  return levels;
}
