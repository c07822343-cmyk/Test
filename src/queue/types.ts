export const TASK_STATUSES = [
  'QUEUED',
  'PLANNING',
  'ASSIGNED',
  'RUNNING',
  'WAITING',
  'REVIEW',
  'RETRYING',
  'BLOCKED',
  'COMPLETED',
  'FAILED',
  'CANCELLED',
] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

export const TERMINAL: readonly TaskStatus[] = ['COMPLETED', 'FAILED', 'CANCELLED'];
export const ACTIVE: readonly TaskStatus[] = ['QUEUED', 'ASSIGNED', 'RUNNING', 'REVIEW', 'RETRYING', 'WAITING', 'PLANNING'];

/** Allowed transitions. Anything else is a bug and is rejected. (-> COMPLETED from idle states = human result override.) */
export const TRANSITIONS: Record<TaskStatus, readonly TaskStatus[]> = {
  PLANNING: ['WAITING', 'RUNNING', 'COMPLETED', 'FAILED', 'CANCELLED'],
  QUEUED: ['ASSIGNED', 'WAITING', 'BLOCKED', 'CANCELLED', 'COMPLETED'],
  WAITING: ['QUEUED', 'BLOCKED', 'CANCELLED', 'COMPLETED', 'FAILED'],
  ASSIGNED: ['RUNNING', 'QUEUED', 'RETRYING', 'FAILED', 'CANCELLED'],
  RUNNING: ['REVIEW', 'WAITING', 'RETRYING', 'FAILED', 'CANCELLED', 'COMPLETED', 'QUEUED'],
  REVIEW: ['COMPLETED', 'WAITING', 'RETRYING', 'FAILED', 'CANCELLED'],
  RETRYING: ['ASSIGNED', 'QUEUED', 'FAILED', 'CANCELLED', 'BLOCKED', 'COMPLETED'],
  BLOCKED: ['WAITING', 'QUEUED', 'CANCELLED', 'FAILED', 'COMPLETED'],
  COMPLETED: ['QUEUED', 'WAITING'],
  FAILED: ['QUEUED', 'WAITING', 'CANCELLED', 'COMPLETED'],
  CANCELLED: ['QUEUED', 'WAITING', 'COMPLETED'],
};

export const PRIORITY_CLASSES = ['CRITICAL', 'HIGH', 'NORMAL', 'LOW', 'BACKGROUND'] as const;
export type PriorityClass = (typeof PRIORITY_CLASSES)[number];
/** Base numeric priority per class; tasks keep a fine-grained priority inside their band. */
export const PRIORITY_BASE: Record<PriorityClass, number> = { CRITICAL: 100, HIGH: 80, NORMAL: 50, LOW: 30, BACKGROUND: 10 };
export function classForPriority(p: number): PriorityClass {
  return p >= 100 ? 'CRITICAL' : p >= 75 ? 'HIGH' : p >= 45 ? 'NORMAL' : p >= 20 ? 'LOW' : 'BACKGROUND';
}

export type ProjectStatus =
  | 'AWAITING_APPROVAL'
  | 'PLANNING'
  | 'RUNNING'
  | 'PAUSED'
  | 'NEEDS_ATTENTION'
  | 'ASSEMBLING'
  | 'COMPLETED'
  | 'APPROVED'
  | 'FAILED'
  | 'CANCELLED';

export interface TaskRow {
  id: string;
  project_id: string;
  parent_task_id: string | null;
  plan_key: string;
  agent_type: string;
  title: string;
  mission: string;
  kind: 'root' | 'work' | 'review' | 'subtask' | 'fix' | 'qa' | 'triage' | 'visual_qa' | 'approval';
  status: TaskStatus;
  optional: boolean;
  priority: number;
  dependencies: string[];
  inputs: Record<string, any>;
  outputs: Record<string, any> | null;
  phase: 'execute' | 'synthesize';
  review_target: string | null;
  capability: string | null;
  model_override: string | null;
  attempt: number;
  max_attempts: number;
  capacity_waits: number;
  revision: number;
  max_revisions: number;
  assigned_key: string | null;
  assigned_model: string | null;
  lease_owner: string | null;
  lease_expires_at: Date | null;
  not_before: Date | null;
  timeout_ms: number;
  idempotency_key: string | null;
  error: Record<string, any> | null;
  workflow_execution_id: string | null;
  skills: string[];
  stage: string | null;
  priority_class: PriorityClass;
  dedupe_key: string | null;
  heartbeat_at: Date | null;
  created_at: Date;
  updated_at: Date;
  started_at: Date | null;
  completed_at: Date | null;
}

export interface ProjectRow {
  id: string;
  name: string;
  kind: string;
  status: ProjectStatus;
  request: string;
  interpretation: Record<string, any> | null;
  plan: Record<string, any> | null;
  final_report: Record<string, any> | null;
  idempotency_key: string | null;
  paused: boolean;
  fix_cycles: number;
  approved_at: Date | null;
  approved_by: string | null;
  mode: 'assist' | 'semi' | 'autopilot';
  approval_gates: string[] | null;
  dry_run: boolean;
  stage: string;
  skill_chain: any[] | null;
  blueprint: Record<string, any> | null;
  scorecard: Record<string, any> | null;
  dry_run_report: Record<string, any> | null;
  max_refinement_cycles: number;
  created_at: Date;
  updated_at: Date;
  completed_at: Date | null;
}

export interface NewTaskSpec {
  id?: string;
  plan_key: string;
  agent_type: string;
  title: string;
  mission: string;
  kind?: TaskRow['kind'];
  priority?: number;
  optional?: boolean;
  dependencies?: string[];
  inputs?: Record<string, unknown>;
  parent_task_id?: string | null;
  review_target?: string | null;
  capability?: string | null;
  max_attempts?: number;
  max_revisions?: number;
  timeout_ms?: number;
  idempotency_key?: string | null;
  initial_status?: TaskStatus;
  skills?: string[];
  stage?: string | null;
  priority_class?: PriorityClass;
  /** Opt out of semantic duplicate detection (explicitly requested repeat work). */
  allow_duplicate?: boolean;
}

/** Task object in the canonical shape exposed to users, n8n and agents. */
export function toTaskObject(t: TaskRow) {
  return {
    task_id: t.id,
    project_id: t.project_id,
    parent_task_id: t.parent_task_id,
    plan_key: t.plan_key,
    agent_type: t.agent_type,
    title: t.title,
    kind: t.kind,
    status: t.status,
    priority: t.priority,
    optional: t.optional,
    dependencies: t.dependencies,
    inputs: t.inputs,
    outputs: t.outputs,
    phase: t.phase,
    started_at: t.started_at,
    completed_at: t.completed_at,
    attempt: t.attempt,
    max_attempts: t.max_attempts,
    revision: t.revision,
    assigned_key: t.assigned_key,
    assigned_model: t.assigned_model,
    skills: t.skills,
    stage: t.stage,
    priority_class: t.priority_class,
    heartbeat_at: t.heartbeat_at,
    workflow_execution_id: t.workflow_execution_id,
    error: t.error,
    created_at: t.created_at,
    updated_at: t.updated_at,
  };
}
