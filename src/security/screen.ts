// Security Screening: inspects external inputs (web pages, client files,
// client-provided text) for manipulation attempts before any agent sees them.
// External content never gains instruction priority - flagged spans are
// neutralised, the event is recorded, and agents are told what was found.
import type { Db } from '../db/pool.ts';
import { redactString } from './redact.ts';

export type ThreatKind =
  | 'instruction_override'
  | 'role_manipulation'
  | 'secret_exfiltration'
  | 'command_execution'
  | 'priority_manipulation'
  | 'permission_bypass'
  | 'delimiter_spoofing'
  | 'credential_present'
  | 'hidden_text';

const RULES: Array<{ kind: ThreatKind; re: RegExp }> = [
  { kind: 'instruction_override', re: /\b(ignore|disregard|forget|override)\b[^.\n]{0,40}\b(previous|prior|above|earlier|system|all)\b[^.\n]{0,30}\b(instructions?|prompts?|rules?|directions?)/i },
  { kind: 'instruction_override', re: /\bnew (system )?instructions?\s*:/i },
  { kind: 'role_manipulation', re: /\b(you are now|act as|pretend to be|from now on you)\b[^.\n]{0,60}/i },
  { kind: 'role_manipulation', re: /^\s*(system|assistant|developer)\s*:/im },
  { kind: 'secret_exfiltration', re: /\b(reveal|print|show|output|leak|send|repeat)\b[^.\n]{0,40}\b(system prompt|api[ _-]?keys?|secrets?|credentials?|tokens?|environment variables?|\.env)\b/i },
  { kind: 'secret_exfiltration', re: /\b(send|post|upload|exfiltrate)\b[^.\n]{0,50}\bhttps?:\/\//i },
  { kind: 'command_execution', re: /\b(run|execute|eval)\b[^.\n]{0,30}\b(command|shell|script|bash|terminal|code)\b/i },
  { kind: 'command_execution', re: /(rm\s+-rf\s+\/|curl\s+[^|\n]+\|\s*(ba)?sh|;\s*shutdown\b|DROP\s+TABLE)/i },
  { kind: 'priority_manipulation', re: /\b(mark|set|make|change)\b[^.\n]{0,30}\b(priority|critical|urgent)\b[^.\n]{0,40}\b(task|this|job)\b/i },
  { kind: 'priority_manipulation', re: /\b(skip|bypass|disable)\b[^.\n]{0,30}\b(qa|review|approval|validation|rate limit)\b/i },
  { kind: 'permission_bypass', re: /\b(use|call|invoke)\b[^.\n]{0,30}\b(git|terminal|filesystem|file system|tool)\b[^.\n]{0,40}\b(to|and)\b/i },
  { kind: 'permission_bypass', re: /\byou (now )?have (full |unrestricted |admin )?(access|permission)/i },
  { kind: 'delimiter_spoofing', re: /<\/?(system|instructions|untrusted_content|assistant)[^>]*>/i },
  { kind: 'credential_present', re: /nvapi-[A-Za-z0-9_\-]{8,}|sk-[A-Za-z0-9]{20,}|ghp_[A-Za-z0-9]{20,}/ },
  { kind: 'hidden_text', re: /[​-‏⁠-⁤﻿]{3,}/ },
];

export interface ScreenResult {
  source: string;
  flags: ThreatKind[];
  findings: Array<{ kind: ThreatKind; excerpt: string }>;
  sanitized: string;
  verdict: 'clean' | 'suspicious' | 'hostile';
}

export function screenText(text: string, source: string): ScreenResult {
  const findings: ScreenResult['findings'] = [];
  let sanitized = text;
  for (const { kind, re } of RULES) {
    const g = new RegExp(re.source, re.flags.includes('g') ? re.flags : `${re.flags}g`);
    for (const m of sanitized.matchAll(g)) findings.push({ kind, excerpt: redactString(m[0]).slice(0, 160) });
    sanitized = sanitized.replace(g, `[neutralised:${kind}]`);
  }
  const flags = [...new Set(findings.map((f) => f.kind))];
  const hostile = flags.some((f) => ['secret_exfiltration', 'command_execution', 'permission_bypass', 'credential_present'].includes(f));
  return { source, flags, findings: findings.slice(0, 30), sanitized: redactString(sanitized), verdict: flags.length === 0 ? 'clean' : hostile || findings.length >= 3 ? 'hostile' : 'suspicious' };
}

export async function recordScreen(db: Db, r: ScreenResult, ctx: { projectId?: string | null; taskId?: string | null; kind: string }): Promise<void> {
  if (r.verdict === 'clean') return;
  await db.query(
    `INSERT INTO security_events (project_id, task_id, source, kind, flags, excerpt, action) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [ctx.projectId ?? null, ctx.taskId ?? null, r.source.slice(0, 500), ctx.kind, r.flags, r.findings.map((f) => `${f.kind}: ${f.excerpt}`).join('\n').slice(0, 2000), r.verdict === 'hostile' ? 'quarantined_spans_neutralised' : 'neutralised'],
  );
}
