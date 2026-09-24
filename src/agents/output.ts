// Structured agent result protocol. Agents reply with one JSON envelope plus
// zero or more FILE blocks. Everything is validated before it touches state;
// malformed output is a retryable failure, never silently accepted.
import { z } from 'zod';
import { normaliseArtifactPath } from '../memory/artifacts.ts';

const toStringArray = z.preprocess(
  (v) => (v == null ? [] : Array.isArray(v) ? v.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))) : [String(v)]),
  z.array(z.string().max(4000)).max(100),
);

export const IssueSchema = z.object({
  severity: z.preprocess((v) => (typeof v === 'string' ? v.toLowerCase() : v), z.enum(['critical', 'major', 'minor'])).catch('minor'),
  area: z.string().max(200).catch('general'),
  description: z.string().max(2000),
  fix: z.string().max(2000).catch(''),
});
export type Issue = z.infer<typeof IssueSchema>;

export const ReviewSchema = z.object({
  verdict: z.preprocess((v) => (typeof v === 'string' ? v.toLowerCase().trim() : v), z.enum(['approve', 'reject'])),
  score: z.coerce.number().min(0).max(10).optional(),
  issues: z.array(IssueSchema).max(60).default([]),
  strengths: toStringArray.default([]),
  revision_instructions: z.string().max(6000).optional(),
});
export type Review = z.infer<typeof ReviewSchema>;

export const SubtaskRequestSchema = z.object({
  agent_type: z.string(),
  title: z.string().min(3).max(200),
  mission: z.string().min(10).max(4000),
  depends_on: z.array(z.coerce.number().int().min(0)).default([]),
  inputs: z.record(z.any()).default({}),
});
export type SubtaskRequest = z.infer<typeof SubtaskRequestSchema>;

export const EnvelopeSchema = z.object({
  status: z.preprocess((v) => (typeof v === 'string' ? v.toLowerCase() : v), z.enum(['completed', 'needs_revision', 'blocked'])).default('completed'),
  summary: z.string().min(1).max(6000),
  result: z.record(z.any()).default({}),
  confidence: z.coerce.number().min(0).max(1).catch(0.6).default(0.6),
  assumptions: toStringArray.default([]),
  unresolved_issues: toStringArray.default([]),
  recommended_next_action: z.string().max(2000).nullable().optional().default(null),
  subtasks: z.array(SubtaskRequestSchema).max(8).default([]),
  review: ReviewSchema.nullable().optional().default(null),
});
export type Envelope = z.infer<typeof EnvelopeSchema>;

export interface ParsedFile {
  path: string;
  content: string;
}

export interface ParsedOutput {
  envelope: Envelope;
  files: ParsedFile[];
}

export class OutputValidationError extends Error {
  readonly problems: string[];
  constructor(problems: string[]) {
    super(`Agent output failed validation: ${problems.join('; ')}`);
    this.problems = problems;
  }
}

const FILE_BLOCK = /<<<FILE\s+path="([^"]+)"\s*>>>\r?\n([\s\S]*?)\r?\n?<<<END FILE>>>/g;

/** Finds the first balanced top-level JSON object in text. */
export function extractJsonObject(text: string): string | null {
  const fenced = text.match(/```(?:json)?\s*\n(\{[\s\S]*?\})\s*\n```/);
  if (fenced) {
    try {
      JSON.parse(fenced[1]);
      return fenced[1];
    } catch {
      /* fall through to scanning */
    }
  }
  for (let start = text.indexOf('{'); start !== -1; start = text.indexOf('{', start + 1)) {
    let depth = 0;
    let inStr = false;
    let esc = false;
    for (let i = start; i < text.length; i++) {
      const ch = text[i];
      if (inStr) {
        if (esc) esc = false;
        else if (ch === '\\') esc = true;
        else if (ch === '"') inStr = false;
        continue;
      }
      if (ch === '"') inStr = true;
      else if (ch === '{') depth++;
      else if (ch === '}') {
        depth--;
        if (depth === 0) {
          const candidate = text.slice(start, i + 1);
          try {
            JSON.parse(candidate);
            return candidate;
          } catch {
            break;
          }
        }
      }
    }
  }
  return null;
}

export function parseAgentOutput(raw: string, opts: { allowFiles: boolean; reviewer: boolean }): ParsedOutput {
  const problems: string[] = [];
  const files: ParsedFile[] = [];
  const seen = new Set<string>();
  for (const m of raw.matchAll(FILE_BLOCK)) {
    try {
      const p = normaliseArtifactPath(m[1]);
      if (seen.has(p)) problems.push(`duplicate FILE block for ${p}`);
      seen.add(p);
      files.push({ path: p, content: m[2] });
    } catch (err) {
      problems.push((err as Error).message);
    }
  }
  if (files.length && !opts.allowFiles) problems.push('this agent may not write files');
  const withoutFiles = raw.replace(FILE_BLOCK, '');
  const json = extractJsonObject(withoutFiles);
  if (!json) throw new OutputValidationError([...problems, 'no JSON envelope found']);
  let data: any;
  try {
    data = JSON.parse(json);
  } catch (err) {
    throw new OutputValidationError([...problems, `invalid JSON: ${(err as Error).message}`]);
  }
  // Reviewers are told to put the verdict in `result`; lift it into `review`.
  if (opts.reviewer && !data.review && data.result && typeof data.result === 'object' && 'verdict' in data.result) {
    data.review = data.result;
  }
  const parsed = EnvelopeSchema.safeParse(data);
  if (!parsed.success) {
    throw new OutputValidationError([...problems, ...parsed.error.issues.slice(0, 8).map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)]);
  }
  if (opts.reviewer && !parsed.data.review) problems.push('reviewer output must include a verdict (approve|reject)');
  if (problems.length) throw new OutputValidationError(problems);
  if (/<<<FILE/.test(withoutFiles)) throw new OutputValidationError(['unterminated FILE block (output may have been truncated)']);
  return { envelope: parsed.data, files };
}
