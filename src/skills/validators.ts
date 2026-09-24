// Deterministic skill validation rules. A skill's `validation` list is executed
// against every output produced under that skill; "error" failures reject the
// output (the agent retries with the failure explained), "warning" failures are
// recorded for QA and the scorecard.
import type { Envelope } from '../agents/output.ts';
import { antiSlopScan, BANNED_PHRASES, seoAudit, staticAudit, type SiteFiles } from '../tools/siteAudit.ts';
import type { ValidationRule } from './types.ts';

export interface ValidationContext {
  agentType: string;
  envelope: Envelope;
  /** Files produced by this output (site-relative for site files, docs/... for docs). */
  producedFiles: Record<string, string>;
  /** Site as it will be after this output is applied. */
  siteAfter: SiteFiles;
  facts: string[];
  /** Research sources actually fetched for this project (id -> excerpt). */
  sources: Map<string, { url: string; excerpt: string }>;
}

export interface ValidationResult {
  skill: string;
  rule: string;
  passed: boolean;
  severity: 'error' | 'warning';
  detail: string;
}

type Check = (rule: ValidationRule, ctx: ValidationContext) => { passed: boolean; detail: string; applicable?: boolean };

function getPath(obj: any, p: string): any {
  return p.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
}

function producedText(ctx: ValidationContext): string {
  return [JSON.stringify(ctx.envelope.result ?? {}), ...Object.values(ctx.producedFiles)].join('\n');
}

function producedSite(ctx: ValidationContext): SiteFiles {
  const out: SiteFiles = {};
  for (const [p, c] of Object.entries(ctx.producedFiles)) if (!p.startsWith('docs/')) out[p] = c;
  return out;
}

const PHONE_RE = /(?<![\w\[])(\+?1[\s.-]?)?\(?\d{3}\)?[\s.-]\d{3}[\s.-]\d{4}(?![\w\]])/g;
const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;

export const CHECKS: Record<string, Check> = {
  required_result_fields: (r, ctx) => {
    const fields = (r.fields as string[]) ?? [];
    const missing = fields.filter((f) => {
      const v = getPath(ctx.envelope.result, f);
      return v === undefined || v === null || (Array.isArray(v) && v.length === 0) || v === '';
    });
    return { passed: missing.length === 0, detail: missing.length ? `result is missing: ${missing.join(', ')}` : 'all required fields present' };
  },
  min_items: (r, ctx) => {
    const v = getPath(ctx.envelope.result, String(r.field));
    const n = Array.isArray(v) ? v.length : 0;
    return { passed: n >= Number(r.min ?? 1), detail: `${r.field} has ${n} item(s); minimum ${r.min}` };
  },
  files_required: (r, ctx) => {
    const paths = (r.paths as string[]) ?? [];
    const missing = paths.filter((p) => !(p in ctx.siteAfter) && !(p in ctx.producedFiles));
    return { passed: missing.length === 0, detail: missing.length ? `missing files: ${missing.join(', ')}` : 'required files present' };
  },
  no_banned_phrases: (_r, ctx) => {
    const text = producedText(ctx).toLowerCase();
    const found = BANNED_PHRASES.filter((p) => new RegExp(`\\b${p.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&')}\\b`, 'i').test(text));
    return { passed: found.length === 0, detail: found.length ? `generic AI phrasing used: ${found.slice(0, 8).join(', ')}` : 'no banned phrasing' };
  },
  no_unsupported_claims: (_r, ctx) => {
    const site = producedSite(ctx);
    if (!Object.keys(site).some((f) => f.endsWith('.html'))) {
      // Copy-only output: scan the result text as a pseudo page.
      site['__copy.html'] = `<html><body>${JSON.stringify(ctx.envelope.result ?? {}).replace(/[<>]/g, ' ')}</body></html>`;
    }
    const scan = antiSlopScan(site, ctx.facts);
    const bad = [...scan.unsupported_claims.map((c) => c.reason), ...scan.testimonial_markers.map((t) => `testimonial: ${t.text.slice(0, 60)}`)];
    return { passed: bad.length === 0, detail: bad.length ? bad.slice(0, 6).join('; ') : 'no unsupported claims or fabricated testimonials' };
  },
  anti_slop_min_score: (r, ctx) => {
    if (!Object.keys(producedSite(ctx)).length) return { passed: true, detail: 'no site files produced', applicable: false };
    const scan = antiSlopScan(ctx.siteAfter, ctx.facts);
    return { passed: scan.score >= Number(r.value ?? 80), detail: `anti-slop score ${scan.score} (minimum ${r.value ?? 80})` };
  },
  max_font_families: (r, ctx) => {
    if (!Object.keys(producedSite(ctx)).length) return { passed: true, detail: 'no site files produced', applicable: false };
    const fam = antiSlopScan(ctx.siteAfter).css.font_families;
    return { passed: fam.length <= Number(r.value ?? 2), detail: `${fam.length} font families (${fam.join(', ') || 'system'})` };
  },
  max_gradients: (r, ctx) => {
    const g = antiSlopScan(ctx.siteAfter).css.gradients;
    return { passed: g <= Number(r.value ?? 3), detail: `${g} CSS gradients (max ${r.value ?? 3})` };
  },
  max_backdrop_filters: (r, ctx) => {
    const g = antiSlopScan(ctx.siteAfter).css.backdrop_filters;
    return { passed: g <= Number(r.value ?? 1), detail: `${g} backdrop-filter uses (max ${r.value ?? 1})` };
  },
  html_hard_failures_zero: (_r, ctx) => {
    if (!Object.keys(producedSite(ctx)).some((f) => f.endsWith('.html'))) return { passed: true, detail: 'no HTML produced', applicable: false };
    const a = staticAudit(ctx.siteAfter);
    return { passed: a.hard_failures.length === 0, detail: a.hard_failures.length ? a.hard_failures.slice(0, 6).map((f) => `${f.page ?? ''} ${f.detail}`).join('; ') : 'no structural hard failures' };
  },
  seo_hard_failures_zero: (_r, ctx) => {
    if (!Object.keys(producedSite(ctx)).some((f) => f.endsWith('.html'))) return { passed: true, detail: 'no HTML produced', applicable: false };
    const a = seoAudit(ctx.siteAfter);
    return { passed: a.hard_failures.length === 0, detail: a.hard_failures.length ? a.hard_failures.map((f) => f.detail).join('; ') : 'no SEO hard failures' };
  },
  reduced_motion_supported: (_r, ctx) => {
    const css = Object.entries(ctx.siteAfter).filter(([f]) => f.endsWith('.css') || f.endsWith('.html')).map(([, c]) => c).join('\n');
    const animates = /@keyframes|transition\s*:|animation\s*:|requestAnimationFrame/.test(css + Object.entries(ctx.siteAfter).filter(([f]) => f.endsWith('.js')).map(([, c]) => c).join('\n'));
    if (!animates) return { passed: true, detail: 'no motion present', applicable: false };
    return { passed: /prefers-reduced-motion/.test(css + Object.values(ctx.siteAfter).join('\n')), detail: 'motion must honour prefers-reduced-motion' };
  },
  placeholders_for_unknown_contact: (_r, ctx) => {
    const text = producedText(ctx).replace(/\[\[PLACEHOLDER:[^\]]*\]\]/g, '');
    const facts = ctx.facts.join(' ');
    const phones = [...text.matchAll(PHONE_RE)].map((m) => m[0]).filter((p) => !facts.includes(p) && !/^(\+?1[\s.-]?)?\(?0{3}\)?[\s.-]?0{3}[\s.-]?0{4}$/.test(p));
    const emails = [...text.matchAll(EMAIL_RE)].map((m) => m[0]).filter((e) => !facts.includes(e) && !/@example\.(com|org)$/i.test(e));
    const bad = [...new Set([...phones, ...emails])];
    return { passed: bad.length === 0, detail: bad.length ? `contact details not in confirmed facts (use placeholders): ${bad.slice(0, 5).join(', ')}` : 'no invented contact details' };
  },
  claims_classified: (_r, ctx) => {
    const claims = ctx.envelope.result?.claims;
    if (!Array.isArray(claims)) return { passed: false, detail: 'research output must include result.claims with a classification for every claim' };
    const bad = claims.filter((c: any) => !['VERIFIED_FACT', 'SOURCE_DERIVED', 'INFERENCE', 'UNVERIFIED'].includes(c?.classification));
    return { passed: bad.length === 0, detail: bad.length ? `${bad.length} claim(s) lack a valid classification` : `${claims.length} classified claims` };
  },
  review_has_actionable_fixes: (_r, ctx) => {
    const review = ctx.envelope.review;
    if (!review || review.verdict !== 'reject') return { passed: true, detail: 'not a rejection', applicable: false };
    const vague = review.issues.filter((i) => !i.fix || i.fix.trim().length < 8);
    return { passed: review.issues.length > 0 && vague.length === 0, detail: review.issues.length === 0 ? 'rejection without issues' : vague.length ? `${vague.length} issue(s) without a concrete fix` : 'every issue has a fix' };
  },
  three_d_justified: (_r, ctx) => {
    const r = ctx.envelope.result ?? {};
    if (r.recommendation !== 'implement') return { passed: true, detail: 'no 3D implemented', applicable: false };
    const js = Object.entries(ctx.producedFiles).filter(([f]) => /\.m?js$/.test(f)).map(([, c]) => c).join('\n');
    const html = Object.entries(ctx.siteAfter).filter(([f]) => f.endsWith('.html')).map(([, c]) => c).join('\n');
    const problems: string[] = [];
    if (!r.rationale || String(r.rationale).length < 40) problems.push('no substantive rationale for 3D');
    if (!/prefers-reduced-motion/.test(js + html)) problems.push('3D must respect prefers-reduced-motion');
    if (!/IntersectionObserver|visibilitychange/.test(js)) problems.push('3D must pause when off-screen');
    return { passed: problems.length === 0, detail: problems.join('; ') || '3D justified with fallbacks' };
  },
  no_hotlinked_images: (_r, ctx) => {
    const html = Object.entries(producedSite(ctx)).filter(([f]) => f.endsWith('.html')).map(([, c]) => c).join('\n');
    const hot = [...html.matchAll(/<img[^>]+src="(https?:\/\/[^"]+)"/gi)].map((m) => m[1]).filter((u) => !/example\.com/.test(u));
    return { passed: hot.length === 0, detail: hot.length ? `hotlinked images: ${hot.slice(0, 3).join(', ')}` : 'no hotlinked images' };
  },
  lazy_offscreen_images: (_r, ctx) => {
    const html = Object.entries(producedSite(ctx)).filter(([f]) => f.endsWith('.html')).map(([, c]) => c).join('\n');
    const imgs = [...html.matchAll(/<img\b[^>]*>/gi)].map((m) => m[0]);
    const eager = imgs.slice(1).filter((t) => !/loading="lazy"/i.test(t));
    return { passed: eager.length === 0, detail: eager.length ? `${eager.length} below-the-fold image(s) without loading="lazy"` : 'images lazy-loaded' };
  },
};

export function describeRule(rule: ValidationRule): string {
  const params = Object.entries(rule).filter(([k]) => k !== 'rule' && k !== 'severity').map(([k, v]) => `${k}=${JSON.stringify(v)}`).join(', ');
  return `${rule.rule}${params ? ` (${params})` : ''}`;
}

export function runValidations(skill: string, rules: ValidationRule[], ctx: ValidationContext): ValidationResult[] {
  const out: ValidationResult[] = [];
  for (const rule of rules) {
    const check = CHECKS[rule.rule];
    const severity = (rule.severity === 'warning' ? 'warning' : 'error') as 'error' | 'warning';
    if (!check) {
      out.push({ skill, rule: rule.rule, passed: false, severity: 'warning', detail: `unknown validation rule ${rule.rule}` });
      continue;
    }
    const r = check(rule, ctx);
    if (r.applicable === false) continue;
    out.push({ skill, rule: rule.rule, passed: r.passed, severity, detail: r.detail });
  }
  return out;
}

export function knownRules(): string[] {
  return Object.keys(CHECKS);
}
