// Project scorecard: an internal checklist of quality criteria, each passed or
// failed with evidence - not a subjective rating. Deterministic criteria are
// computed from fresh runs of the audits on the final site; review criteria
// come from the recorded verdicts; project requirements come from the
// blueprint (deterministic checks where possible, Final QA evidence otherwise).
import type { Db } from '../db/pool.ts';
import type { ArtifactStore } from '../memory/artifacts.ts';
import { accessibilityAxe, performanceProbe, responsiveRender } from '../tools/browserChecks.ts';
import { antiSlopScan, htmlPages, seoAudit, staticAudit } from '../tools/siteAudit.ts';
import { bugScan, visualQa } from '../tools/visualQa.ts';

export const CATEGORIES = ['functionality', 'visual_quality', 'ux', 'responsiveness', 'accessibility', 'seo', 'performance', 'content_completeness', 'technical_quality', 'project_requirements'] as const;
export type Category = (typeof CATEGORIES)[number];

export interface Criterion {
  id: string;
  category: Category;
  criterion: string;
  passed: boolean | null;
  evidence: string;
  source: string;
}

export interface Scorecard {
  generated_at: string;
  criteria: Criterion[];
  categories: Record<Category, { passed: number; failed: number; not_evaluated: number }>;
  totals: { passed: number; failed: number; not_evaluated: number };
}

type Req = { id: string; text: string; check?: { type: string; value?: string } };

export async function computeScorecard(db: Db, artifacts: ArtifactStore, projectId: string, facts: string[] = []): Promise<Scorecard> {
  const site = await artifacts.latestText(projectId, 'site/');
  const { rows: pRows } = await db.query('SELECT blueprint FROM projects WHERE id = $1', [projectId]);
  const blueprint = pRows[0]?.blueprint ?? null;
  const { rows: tasks } = await db.query(`SELECT agent_type, kind, status, outputs FROM tasks WHERE project_id = $1 AND kind <> 'root' ORDER BY updated_at DESC`, [projectId]);
  const verdictOf = (agent: string) => tasks.find((t) => t.agent_type === agent && t.status === 'COMPLETED' && t.outputs?.review)?.outputs.review ?? null;
  const c: Criterion[] = [];
  const add = (id: string, category: Category, criterion: string, passed: boolean | null, evidence: string, source: string) => c.push({ id, category, criterion, passed, evidence, source });

  const hasSite = htmlPages(site).length > 0;
  const stat = staticAudit(site);
  const seo = seoAudit(site);
  const slop = antiSlopScan(site, facts);
  const [resp, axe, perf, bugs, vqa] = hasSite
    ? await Promise.all([responsiveRender(site), accessibilityAxe(site), performanceProbe(site), bugScan(site), visualQa(site)])
    : [null, null, null, null, null];
  const na = (x: any) => !x || 'reason' in x;

  // Functionality
  add('F1', 'functionality', 'No broken internal links or missing referenced files', hasSite ? stat.broken_links.length + stat.missing_assets.length === 0 : null, `${stat.broken_links.length} broken link(s), ${stat.missing_assets.length} missing file(s)`, 'static_site_audit');
  if (!na(bugs)) {
    const b = bugs as Exclude<typeof bugs, null | { available: false; reason: string }>;
    add('F2', 'functionality', 'No uncaught JavaScript exceptions or failed requests', b.page_errors.length + b.failed_requests.length === 0, `${b.page_errors.length} exception(s), ${b.failed_requests.length} failed request(s), ${b.console_errors.length} console error(s)`, 'bug_scan');
    const forms = b.interaction_checks.filter((i) => i.check === 'form');
    add('F3', 'functionality', 'Forms have submit controls', forms.length ? forms.every((f) => f.passed) : null, forms.length ? `${forms.filter((f) => f.passed).length}/${forms.length} forms OK` : 'no forms', 'bug_scan');
  } else add('F2', 'functionality', 'No uncaught JavaScript exceptions or failed requests', null, 'browser unavailable', 'bug_scan');
  if (!na(vqa)) {
    const v = vqa as Exclude<typeof vqa, null | { available: false; reason: string }>;
    const navBad = v.issues.filter((i) => ['nav_unreachable', 'menu_toggle_broken', 'nav_missing'].includes(i.rule));
    add('F4', 'functionality', 'Navigation reachable on every viewport', navBad.length === 0, navBad.length ? navBad.map((i) => i.detail).join('; ') : 'navigation reachable', 'visual_qa');
    // Visual quality + UX from rendered checks
    const serious = v.issues.filter((i) => i.severity !== 'minor');
    add('V2', 'visual_quality', 'No critical/major visual issues at desktop, tablet and mobile', serious.length === 0, serious.length ? serious.slice(0, 5).map((i) => i.detail).join('; ') : `visual QA score ${v.score}`, 'visual_qa');
    const cta = v.issues.filter((i) => i.rule === 'cta_below_fold' || i.rule === 'no_cta');
    add('U1', 'ux', 'Primary call-to-action visible in the first viewport', cta.length === 0, cta.length ? cta.map((i) => i.detail).join('; ') : 'CTA above the fold on all viewports', 'visual_qa');
  }
  const critic = verdictOf('design_critic');
  add('V1', 'visual_quality', 'Design Critic approved the implementation', critic ? critic.verdict === 'approve' : null, critic ? `verdict ${critic.verdict}${critic.score != null ? `, ${critic.score}/10` : ''}` : 'no design review ran', 'design_critic');
  add('V3', 'visual_quality', 'Anti-AI-slop score at least 80', hasSite ? slop.score >= 80 : null, `score ${slop.score}`, 'anti_slop_scan');
  add('V4', 'visual_quality', 'Disciplined styling: <=2 font families, <=3 gradients, <=1 backdrop-filter', hasSite ? slop.css.font_families.length <= 2 && slop.css.gradients <= 3 && slop.css.backdrop_filters <= 1 : null, `${slop.css.font_families.length} families, ${slop.css.gradients} gradients, ${slop.css.backdrop_filters} backdrop filters`, 'anti_slop_scan');
  const ux = verdictOf('ux_reviewer');
  add('U2', 'ux', 'UX review found no critical friction', ux ? !ux.issues?.some((i: any) => i.severity === 'critical') : null, ux ? `${ux.issues?.length ?? 0} finding(s), verdict ${ux.verdict}` : 'no UX review ran', 'ux_reviewer');
  const conv = verdictOf('conversion_optimization');
  add('U3', 'ux', 'Conversion review approved the copy/structure', conv ? conv.verdict === 'approve' : null, conv ? `verdict ${conv.verdict}` : 'no conversion review ran', 'conversion_optimization');
  // Responsiveness
  if (!na(resp)) {
    const r = resp as Exclude<typeof resp, null | { available: false; reason: string }>;
    const over = r.results.filter((x) => x.horizontal_overflow);
    add('R1', 'responsiveness', 'No horizontal overflow at 360/768/1440px', over.length === 0, over.length ? over.map((o) => `${o.page}@${o.width}px`).join(', ') : 'no overflow', 'responsive_render');
    const taps = r.results.filter((x) => x.viewport === 'mobile' && x.small_tap_targets.length);
    add('R2', 'responsiveness', 'Tap targets at least 44px on mobile', taps.length === 0, taps.length ? taps.map((t) => `${t.page}: ${t.small_tap_targets.length}`).join(', ') : 'all tap targets OK', 'responsive_render');
  } else add('R1', 'responsiveness', 'No horizontal overflow at 360/768/1440px', null, 'browser unavailable', 'responsive_render');
  // Accessibility
  if (!na(axe)) {
    const a = axe as Exclude<typeof axe, null | { available: false; reason: string }>;
    const serious = a.pages.flatMap((p) => p.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical'));
    add('A1', 'accessibility', 'Zero serious/critical axe-core WCAG violations', serious.length === 0, serious.length ? serious.map((v) => v.id).join(', ') : 'none', 'accessibility_axe');
  } else add('A1', 'accessibility', 'Zero serious/critical axe-core WCAG violations', null, 'browser unavailable', 'accessibility_axe');
  const semantic = stat.findings.filter((f) => ['html_lang', 'landmark_main', 'form_labels', 'img_alt'].includes(f.rule));
  add('A2', 'accessibility', 'Language, landmarks, labels and alt text present', hasSite ? semantic.length === 0 : null, semantic.length ? semantic.map((f) => `${f.page}: ${f.detail}`).join('; ') : 'present', 'static_site_audit');
  const css = Object.entries(site).filter(([f]) => f.endsWith('.css') || f.endsWith('.html')).map(([, x]) => x).join('\n');
  const motion = /@keyframes|transition\s*:|animation\s*:/.test(css);
  add('A3', 'accessibility', 'Motion honours prefers-reduced-motion', motion ? /prefers-reduced-motion/.test(css) : true, motion ? (/prefers-reduced-motion/.test(css) ? 'reduced-motion rules present' : 'animations without reduced-motion handling') : 'no motion', 'static_site_audit');
  // SEO
  const noMeta = seo.pages.filter((p) => !p.title || !p.description_length);
  add('S1', 'seo', 'Every page has a title and meta description', hasSite ? noMeta.length === 0 : null, noMeta.length ? noMeta.map((p) => p.page).join(', ') : `${seo.pages.length} page(s) OK`, 'seo_audit');
  const home = seo.pages.find((p) => p.page === 'index.html');
  add('S2', 'seo', 'Valid structured data (JSON-LD) on the home page', home ? home.jsonld_types.length > 0 && home.jsonld_errors.length === 0 : null, home ? `${home.jsonld_types.join(', ') || 'none'}${home.jsonld_errors.length ? `; errors: ${home.jsonld_errors.join('; ')}` : ''}` : 'no home page', 'seo_audit');
  add('S3', 'seo', 'sitemap.xml and robots.txt present', hasSite ? seo.has_sitemap && seo.has_robots : null, `sitemap ${seo.has_sitemap ? 'yes' : 'no'}, robots ${seo.has_robots ? 'yes' : 'no'}`, 'seo_audit');
  // Performance
  if (!na(perf)) {
    const pf = perf as Exclude<typeof perf, null | { available: false; reason: string }>;
    const worstLcp = Math.max(0, ...pf.pages.map((p) => p.lcp_ms ?? 0));
    const worstCls = Math.max(0, ...pf.pages.map((p) => p.cls));
    add('P1', 'performance', 'LCP <= 2.5s on emulated mid-range mobile', worstLcp <= 2500, `worst LCP ${worstLcp}ms`, 'performance_probe');
    add('P2', 'performance', 'CLS <= 0.1', worstCls <= 0.1, `worst CLS ${worstCls}`, 'performance_probe');
  } else add('P1', 'performance', 'LCP <= 2.5s on emulated mid-range mobile', null, 'browser unavailable', 'performance_probe');
  const blocking = stat.pages.flatMap((p) => p.render_blocking_scripts);
  add('P3', 'performance', 'No render-blocking scripts', hasSite ? blocking.length === 0 : null, blocking.length ? blocking.join(', ') : 'none', 'static_site_audit');
  // Content completeness
  const pages: string[] = (blueprint?.pages ?? []).map((p: any) => String(p.path ?? '').replace(/^\//, '') || 'index.html').map((p: string) => (p.endsWith('/') ? `${p}index.html` : /\.html?$/.test(p) ? p : `${p}.html`));
  const missingPages = pages.filter((p) => !(p in site) && !(`${p.replace(/\.html$/, '')}/index.html` in site));
  add('C1', 'content_completeness', 'Every page in the blueprint exists', pages.length ? missingPages.length === 0 : null, pages.length ? (missingPages.length ? `missing: ${missingPages.join(', ')}` : `${pages.length} page(s) present`) : 'blueprint lists no pages', 'blueprint');
  add('C2', 'content_completeness', 'No unsupported claims or fabricated testimonials', hasSite ? slop.unsupported_claims.length + slop.testimonial_markers.length === 0 : null, `${slop.unsupported_claims.length} unsupported claim(s), ${slop.testimonial_markers.length} testimonial marker(s)`, 'anti_slop_scan');
  const placeholders = [...new Set(Object.values(site).flatMap((x) => x.match(/\[\[PLACEHOLDER:[^\]]*\]\]/g) ?? []))];
  add('C3', 'content_completeness', 'Unknown facts are marked as placeholders (and listed for the client)', true, `${placeholders.length} placeholder(s) listed in the report`, 'site files');
  // Technical quality
  const major = stat.findings.filter((f) => f.severity !== 'minor');
  add('T1', 'technical_quality', 'No critical/major structural findings', hasSite ? major.length === 0 : null, major.length ? major.slice(0, 5).map((f) => `${f.page ?? ''} ${f.detail}`).join('; ') : 'clean', 'static_site_audit');
  const bytes = Object.values(site).reduce((s, x) => s + Buffer.byteLength(x), 0);
  add('T2', 'technical_quality', 'Site weight within budget (<= 1.5 MB text assets)', hasSite ? bytes <= 1_500_000 : null, `${Math.round(bytes / 1024)} KB`, 'site files');
  // Project requirements
  const reqs: Req[] = blueprint?.requirements ?? [];
  const qaChecks: Array<{ id: string; passed: boolean; evidence: string }> = tasks.find((t) => t.agent_type === 'final_qa_release' && t.outputs?.result?.requirement_checks)?.outputs.result.requirement_checks ?? [];
  const allText = Object.entries(site).filter(([f]) => f.endsWith('.html')).map(([, x]) => x.replace(/<[^>]+>/g, ' ')).join(' ').toLowerCase();
  for (const r of reqs.slice(0, 40)) {
    const check = r.check ?? { type: 'manual' };
    let passed: boolean | null = null;
    let evidence = '';
    if (check.type === 'page_exists' && check.value) {
      const p = check.value.replace(/^\//, '') || 'index.html';
      passed = p in site || `${p}.html` in site || `${p.replace(/\/$/, '')}/index.html` in site;
      evidence = passed ? `${check.value} exists` : `${check.value} missing`;
    } else if (check.type === 'text_present' && check.value) {
      passed = allText.includes(check.value.toLowerCase());
      evidence = passed ? `"${check.value}" found` : `"${check.value}" not found in page text`;
    } else if (check.type === 'element_present' && check.value) {
      const tag = check.value.toLowerCase();
      passed = Object.values(site).some((x) => new RegExp(`<${tag}[\\s>]`, 'i').test(x));
      evidence = passed ? `<${tag}> present` : `no <${tag}> element`;
    } else {
      const q = qaChecks.find((x) => x.id === r.id);
      passed = q ? !!q.passed : null;
      evidence = q ? q.evidence : 'not evaluated by Final QA';
    }
    add(r.id, 'project_requirements', r.text, passed, evidence, check.type === 'manual' ? 'final_qa_release' : `blueprint check: ${check.type}`);
  }
  const categories = Object.fromEntries(CATEGORIES.map((k) => [k, { passed: 0, failed: 0, not_evaluated: 0 }])) as Scorecard['categories'];
  for (const x of c) categories[x.category][x.passed === null ? 'not_evaluated' : x.passed ? 'passed' : 'failed']++;
  const totals = { passed: c.filter((x) => x.passed === true).length, failed: c.filter((x) => x.passed === false).length, not_evaluated: c.filter((x) => x.passed === null).length };
  return { generated_at: new Date().toISOString(), criteria: c, categories, totals };
}
