import type { Capability } from '../provider/modelRegistry.ts';

export type Department = 'command' | 'development' | 'content' | 'operations' | 'research' | 'quality';

/** n8n pipeline that renders this agent's execution (Workflow 8-13). */
export type Pipeline = 'website_development' | 'research' | 'content' | 'seo' | 'design_review' | 'qa' | 'visual_qa';

/** Tool names are defined in src/tools/catalog.ts (validated at registry load). */
export type ToolName = string;

export interface AgentDefinition {
  type: string;
  name: string;
  department: Department;
  pipeline: Pipeline;
  capability: Capability;
  /** Role statement: what this specialist is responsible for. */
  mission: string;
  /** Specific working rules for this specialist. */
  instructions: string[];
  /** Human-readable shape of the `result` object this agent must return. */
  resultShape: string;
  /** Agent produces files via FILE blocks. */
  producesFiles?: boolean;
  /** Agent returns a review verdict and may reject another agent's work. */
  reviewer?: boolean;
  /** Deterministic tools run before the model call; results are injected as context. */
  tools?: ToolName[];
  /** Sub-agents this specialist may spawn when complexity warrants it. */
  subAgents?: string[];
  /** Set on sub-agents. */
  parent?: string;
  /** Which project artifacts the context builder should include. */
  artifacts?: 'none' | 'site' | 'docs' | 'all';
  maxTokens: number;
  temperature?: number;
  /** Per-agent concurrency cap (defaults to unlimited within the global cap). */
  maxConcurrent?: number;
  /** Tool permission profile (src/tools/catalog.ts TOOL_PROFILES). */
  toolProfile: string;
  /** Lifecycle stage this agent's work normally belongs to. */
  stage?: string;
  /** Safe to reuse an identical earlier model response (no side effects, no files, not a reviewer). */
  cacheable?: boolean;
  /** Loaded from the agents/ extension folder rather than built in. */
  extension?: boolean;
}
