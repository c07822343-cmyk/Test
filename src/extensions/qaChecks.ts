// QA check extensions: qa/*.json files add deterministic scorecard criteria
// (checklist items, not opinions). Each check runs against the final site
// files and reports passed/failed with evidence alongside the built-in criteria.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { errorMessage } from '../util/log.ts';

const CATEGORY = z.enum(['functionality', 'visual_quality', 'ux', 'responsiveness', 'accessibility', 'seo', 'performance', 'content_completeness', 'technical_quality', 'project_requirements']);

export const QaCheckSchema = z.object({
  id: z.string().regex(/^QA-[A-Z0-9-]{1,24}$/, 'ids start with QA- (uppercase letters, digits, dashes)'),
  category: CATEGORY,
  criterion: z.string().min(5).max(300),
  type: z.enum(['text_present', 'text_absent', 'regex_present', 'regex_absent', 'element_present', 'file_exists']),
  value: z.string().min(1).max(500),
  /** Which site files the check reads: a file name, or a suffix pattern like "*.html" / "*.css". */
  files: z.string().max(200).default('*.html'),
  /** "every" file must satisfy the check, or "any" one of them. */
  scope: z.enum(['every', 'any']).default('any'),
});
export type QaCheck = z.infer<typeof QaCheckSchema>;

const FileSchema = z.object({ checks: z.array(QaCheckSchema).min(1).max(100) });

const checks = new Map<string, QaCheck>();

export function qaChecks(): QaCheck[] {
  return [...checks.values()];
}

export function loadQaChecks(dirs: string[]): { loaded: string[]; errors: string[] } {
  const out = { loaded: [] as string[], errors: [] as string[] };
  for (const dir of dirs) {
    if (!existsSync(dir)) continue;
    for (const f of readdirSync(dir).filter((x) => x.endsWith('.json')).sort()) {
      try {
        const parsed = FileSchema.parse(JSON.parse(readFileSync(path.join(dir, f), 'utf8')));
        for (const c of parsed.checks) {
          if (c.type.startsWith('regex')) new RegExp(c.value, 'i'); // reject invalid patterns at load time
          checks.set(c.id, c);
          out.loaded.push(c.id);
        }
      } catch (err) {
        out.errors.push(`${f}: ${errorMessage(err)}`.slice(0, 500));
      }
    }
  }
  return out;
}

function matches(file: string, pattern: string): boolean {
  if (pattern === '*') return true;
  if (pattern.startsWith('*')) return file.endsWith(pattern.slice(1));
  return file === pattern;
}

/** Evaluates one check against the site files; null when there is nothing to evaluate. */
export function evaluateQaCheck(c: QaCheck, site: Record<string, string>): { passed: boolean | null; evidence: string } {
  if (c.type === 'file_exists') {
    const ok = c.value.replace(/^\//, '') in site;
    return { passed: ok, evidence: ok ? `${c.value} exists` : `${c.value} missing` };
  }
  const files = Object.keys(site).filter((f) => matches(f, c.files)).sort();
  if (!files.length) return { passed: null, evidence: `no files match ${c.files}` };
  const text = (f: string) => (c.files.endsWith('.html') && c.type.startsWith('text') ? site[f].replace(/<[^>]+>/g, ' ') : site[f]);
  const test = (f: string): boolean => {
    switch (c.type) {
      case 'text_present': return text(f).toLowerCase().includes(c.value.toLowerCase());
      case 'text_absent': return !text(f).toLowerCase().includes(c.value.toLowerCase());
      case 'regex_present': return new RegExp(c.value, 'i').test(site[f]);
      case 'regex_absent': return !new RegExp(c.value, 'i').test(site[f]);
      case 'element_present': return new RegExp(`<${c.value.toLowerCase()}[\\s>/]`, 'i').test(site[f]);
      default: return false;
    }
  };
  const failing = files.filter((f) => !test(f));
  const passed = c.scope === 'every' ? failing.length === 0 : failing.length < files.length;
  const evidence = passed
    ? `${files.length - failing.length}/${files.length} file(s) satisfy the check`
    : `failing: ${failing.slice(0, 8).join(', ')}${failing.length > 8 ? ` (+${failing.length - 8})` : ''}`;
  return { passed, evidence };
}
