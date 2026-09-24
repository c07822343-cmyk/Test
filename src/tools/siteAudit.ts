// Deterministic audits over the generated site files. These are facts, not
// opinions: reviewers receive them as evidence and QA treats hard failures as
// release blockers regardless of what a model says.
import path from 'node:path';
import { parse, type HTMLElement } from 'node-html-parser';

export type SiteFiles = Record<string, string>;

export interface Finding {
  severity: 'critical' | 'major' | 'minor';
  rule: string;
  page: string | null;
  detail: string;
}

export interface StaticAudit {
  pages: Array<{
    page: string;
    title: string | null;
    meta_description: string | null;
    lang: string | null;
    has_viewport: boolean;
    h1_count: number;
    headings: string[];
    images: number;
    images_missing_alt: number;
    images_missing_dimensions: number;
    render_blocking_scripts: string[];
    unlabelled_controls: number;
    placeholders: number;
  }>;
  broken_links: Array<{ page: string; href: string }>;
  missing_assets: Array<{ page: string; ref: string }>;
  findings: Finding[];
  hard_failures: Finding[];
}

export function htmlPages(files: SiteFiles): string[] {
  return Object.keys(files).filter((f) => /\.html?$/i.test(f)).sort();
}

function resolveRef(fromPage: string, ref: string): string | null {
  if (!ref || /^(https?:|mailto:|tel:|sms:|data:|javascript:|#)/i.test(ref) || ref.startsWith('//')) return null;
  const clean = ref.split('#')[0].split('?')[0];
  if (!clean) return null;
  const base = clean.startsWith('/') ? clean.slice(1) : path.posix.join(path.posix.dirname(fromPage), clean);
  const norm = path.posix.normalize(base);
  return norm.endsWith('/') || norm === '.' ? path.posix.join(norm, 'index.html') : norm;
}

const PLACEHOLDER_RE = /\[\[PLACEHOLDER:[^\]]*\]\]/g;

export function staticAudit(files: SiteFiles): StaticAudit {
  const pages: StaticAudit['pages'] = [];
  const findings: Finding[] = [];
  const broken: StaticAudit['broken_links'] = [];
  const missing: StaticAudit['missing_assets'] = [];
  const pageList = htmlPages(files);
  if (pageList.length === 0) {
    findings.push({ severity: 'critical', rule: 'no_pages', page: null, detail: 'No HTML pages were produced' });
  }
  if (pageList.length > 0 && !files['index.html']) {
    findings.push({ severity: 'critical', rule: 'no_index', page: null, detail: 'index.html is missing' });
  }
  for (const page of pageList) {
    const root = parse(files[page], { comment: false });
    const html = root.querySelector('html');
    const title = root.querySelector('title')?.text.trim() || null;
    const desc = root.querySelector('meta[name="description"]')?.getAttribute('content')?.trim() || null;
    const lang = html?.getAttribute('lang') ?? null;
    const viewport = !!root.querySelector('meta[name="viewport"]');
    const h1s = root.querySelectorAll('h1');
    const headings = root.querySelectorAll('h1,h2,h3,h4,h5,h6');
    const imgs = root.querySelectorAll('img');
    const noAlt = imgs.filter((i) => i.getAttribute('alt') === undefined);
    const noDims = imgs.filter((i) => !i.getAttribute('width') || !i.getAttribute('height'));
    const headScripts = root.querySelectorAll('head script[src]').filter((s) => !s.hasAttribute('defer') && !s.hasAttribute('async') && s.getAttribute('type') !== 'module');
    const controls = root.querySelectorAll('input, select, textarea').filter((c) => !['hidden', 'submit', 'button'].includes(c.getAttribute('type') ?? ''));
    const unlabelled = controls.filter((c) => !isLabelled(root, c));
    const placeholders = (files[page].match(PLACEHOLDER_RE) ?? []).length;

    if (!html?.getAttribute('lang')) findings.push({ severity: 'major', rule: 'html_lang', page, detail: '<html> has no lang attribute' });
    if (!title) findings.push({ severity: 'critical', rule: 'title', page, detail: 'Missing <title>' });
    if (!desc) findings.push({ severity: 'major', rule: 'meta_description', page, detail: 'Missing meta description' });
    if (!viewport) findings.push({ severity: 'critical', rule: 'viewport', page, detail: 'Missing responsive viewport meta tag' });
    if (h1s.length !== 1) findings.push({ severity: 'major', rule: 'h1_count', page, detail: `Expected exactly one h1, found ${h1s.length}` });
    let prev = 0;
    for (const h of headings) {
      const level = Number(h.tagName.slice(1));
      if (prev && level > prev + 1) {
        findings.push({ severity: 'minor', rule: 'heading_order', page, detail: `Heading jumps from h${prev} to h${level}: "${h.text.trim().slice(0, 60)}"` });
      }
      prev = level;
    }
    if (noAlt.length) findings.push({ severity: 'major', rule: 'img_alt', page, detail: `${noAlt.length} image(s) without alt attribute` });
    if (noDims.length) findings.push({ severity: 'minor', rule: 'img_dimensions', page, detail: `${noDims.length} image(s) without width/height (layout shift risk)` });
    for (const s of headScripts) findings.push({ severity: 'major', rule: 'render_blocking_script', page, detail: `Render-blocking script in <head>: ${s.getAttribute('src')}` });
    if (unlabelled.length) findings.push({ severity: 'major', rule: 'form_labels', page, detail: `${unlabelled.length} form control(s) without an accessible label` });
    if (!root.querySelector('main')) findings.push({ severity: 'major', rule: 'landmark_main', page, detail: 'No <main> landmark' });

    // Links and asset references.
    for (const a of root.querySelectorAll('a[href]')) {
      const href = a.getAttribute('href')!;
      if (href.startsWith('#') && href.length > 1 && !root.querySelector(`[id="${href.slice(1).replace(/"/g, '')}"]`)) {
        broken.push({ page, href });
        continue;
      }
      const target = resolveRef(page, href);
      if (target && !files[target] && !files[`${target}.html`]) broken.push({ page, href });
    }
    const refs = [
      ...root.querySelectorAll('link[rel="stylesheet"][href]').map((l) => l.getAttribute('href')!),
      ...root.querySelectorAll('script[src]').map((s) => s.getAttribute('src')!),
      ...root.querySelectorAll('img[src]').map((i) => i.getAttribute('src')!),
    ];
    for (const ref of refs) {
      const target = resolveRef(page, ref);
      if (target && !files[target]) missing.push({ page, ref });
    }
    const ids = root.querySelectorAll('[id]').map((e) => e.getAttribute('id'));
    const dupes = ids.filter((id, i) => ids.indexOf(id) !== i);
    if (dupes.length) findings.push({ severity: 'minor', rule: 'duplicate_ids', page, detail: `Duplicate ids: ${[...new Set(dupes)].join(', ')}` });

    pages.push({
      page,
      title,
      meta_description: desc,
      lang,
      has_viewport: viewport,
      h1_count: h1s.length,
      headings: headings.map((h) => `${h.tagName.toLowerCase()}: ${h.text.replace(/\s+/g, ' ').trim().slice(0, 90)}`).slice(0, 40),
      images: imgs.length,
      images_missing_alt: noAlt.length,
      images_missing_dimensions: noDims.length,
      render_blocking_scripts: headScripts.map((s) => s.getAttribute('src') ?? ''),
      unlabelled_controls: unlabelled.length,
      placeholders,
    });
  }
  for (const b of broken) findings.push({ severity: 'critical', rule: 'broken_link', page: b.page, detail: `Broken internal link: ${b.href}` });
  for (const m of missing) findings.push({ severity: 'critical', rule: 'missing_asset', page: m.page, detail: `Referenced file does not exist: ${m.ref}` });
  return { pages, broken_links: broken, missing_assets: missing, findings, hard_failures: findings.filter((f) => f.severity === 'critical') };
}

function isLabelled(root: HTMLElement, el: HTMLElement): boolean {
  if (el.getAttribute('aria-label') || el.getAttribute('aria-labelledby') || el.getAttribute('title')) return true;
  const id = el.getAttribute('id');
  if (id && root.querySelector(`label[for="${id.replace(/"/g, '')}"]`)) return true;
  let p = el.parentNode as HTMLElement | null;
  while (p) {
    if (p.tagName === 'LABEL') return true;
    p = p.parentNode as HTMLElement | null;
  }
  return false;
}

// ------------------------------------------------------------------- SEO
export interface SeoAudit {
  pages: Array<{ page: string; title: string | null; title_length: number; description_length: number; canonical: string | null; og: string[]; jsonld_types: string[]; jsonld_errors: string[]; internal_links_out: number }>;
  has_robots: boolean;
  has_sitemap: boolean;
  duplicate_titles: string[];
  findings: Finding[];
  hard_failures: Finding[];
}

export function seoAudit(files: SiteFiles): SeoAudit {
  const findings: Finding[] = [];
  const pages: SeoAudit['pages'] = [];
  const titles = new Map<string, string[]>();
  for (const page of htmlPages(files)) {
    const root = parse(files[page], { comment: false });
    const title = root.querySelector('title')?.text.trim() || null;
    const desc = root.querySelector('meta[name="description"]')?.getAttribute('content')?.trim() ?? '';
    const canonical = root.querySelector('link[rel="canonical"]')?.getAttribute('href') ?? null;
    const og = root.querySelectorAll('meta[property^="og:"]').map((m) => m.getAttribute('property')!);
    const jsonldTypes: string[] = [];
    const jsonldErrors: string[] = [];
    for (const s of root.querySelectorAll('script[type="application/ld+json"]')) {
      try {
        const data = JSON.parse(s.text);
        const items = Array.isArray(data) ? data : data['@graph'] ?? [data];
        for (const it of items) if (it?.['@type']) jsonldTypes.push(String(it['@type']));
        const flat = JSON.stringify(data);
        if (/"aggregateRating"|"review"\s*:/i.test(flat)) jsonldErrors.push('Structured data contains ratings/reviews; these must come from real client data');
      } catch (e) {
        jsonldErrors.push(`Invalid JSON-LD: ${(e as Error).message.slice(0, 80)}`);
      }
    }
    const internal = root.querySelectorAll('a[href]').filter((a) => resolveRef(page, a.getAttribute('href')!) !== null).length;
    if (title) titles.set(title, [...(titles.get(title) ?? []), page]);
    if (!title) findings.push({ severity: 'critical', rule: 'seo_title', page, detail: 'Missing title' });
    else if (title.length < 20 || title.length > 65) findings.push({ severity: 'minor', rule: 'seo_title_length', page, detail: `Title is ${title.length} chars (aim for 30-60)` });
    if (!desc) findings.push({ severity: 'major', rule: 'seo_description', page, detail: 'Missing meta description' });
    else if (desc.length < 70 || desc.length > 170) findings.push({ severity: 'minor', rule: 'seo_description_length', page, detail: `Description is ${desc.length} chars (aim for 70-160)` });
    if (!canonical) findings.push({ severity: 'minor', rule: 'canonical', page, detail: 'No canonical link' });
    if (!og.includes('og:title')) findings.push({ severity: 'minor', rule: 'open_graph', page, detail: 'Missing og:title' });
    for (const e of jsonldErrors) findings.push({ severity: e.startsWith('Invalid') ? 'critical' : 'major', rule: 'jsonld', page, detail: e });
    if (page === 'index.html' && jsonldTypes.length === 0) findings.push({ severity: 'major', rule: 'jsonld_missing', page, detail: 'Home page has no JSON-LD structured data' });
    pages.push({ page, title, title_length: title?.length ?? 0, description_length: desc.length, canonical, og, jsonld_types: jsonldTypes, jsonld_errors: jsonldErrors, internal_links_out: internal });
  }
  const duplicateTitles = [...titles.entries()].filter(([, p]) => p.length > 1).map(([t]) => t);
  for (const t of duplicateTitles) findings.push({ severity: 'major', rule: 'duplicate_title', page: null, detail: `Title used on multiple pages: "${t}"` });
  const hasRobots = !!files['robots.txt'];
  const hasSitemap = !!files['sitemap.xml'];
  if (!hasSitemap && htmlPages(files).length > 1) findings.push({ severity: 'minor', rule: 'sitemap', page: null, detail: 'No sitemap.xml' });
  return { pages, has_robots: hasRobots, has_sitemap: hasSitemap, duplicate_titles: duplicateTitles, findings, hard_failures: findings.filter((f) => f.severity === 'critical') };
}

// ------------------------------------------------------------- ANTI-SLOP
export const BANNED_PHRASES = [
  'elevate', 'unlock', 'seamless', 'seamlessly', 'cutting-edge', 'cutting edge', "in today's fast-paced world", 'look no further',
  "we've got you covered", 'your trusted partner', 'take it to the next level', 'state-of-the-art', 'world-class', 'unparalleled',
  'second to none', 'one-stop shop', 'game-changer', 'revolutionize', 'revolutionise', 'supercharge', 'harness the power',
  'delve', 'tapestry', 'embark on', 'unleash', 'effortlessly', 'best-in-class', 'peace of mind is just', 'rest assured',
];
const GENERIC_HEADINGS = ['why choose us', 'our services', 'what we do', 'about us', 'get in touch', 'our mission', 'testimonials', 'what our clients say'];

export interface AntiSlopReport {
  banned_phrases: Array<{ phrase: string; count: number; pages: string[] }>;
  unsupported_claims: Array<{ page: string; text: string; reason: string }>;
  testimonial_markers: Array<{ page: string; text: string }>;
  generic_headings: Array<{ page: string; heading: string }>;
  repeated_sentences: Array<{ sentence: string; count: number }>;
  css: { gradients: number; backdrop_filters: number; keyframes: number; animations: number; font_families: string[]; distinct_font_sizes: number; box_shadows: number };
  score: number;
  findings: Finding[];
  hard_failures: Finding[];
}

function visibleText(html: string): string {
  const root = parse(html, { comment: false });
  root.querySelectorAll('script, style, noscript, svg').forEach((n) => n.remove());
  return root.text.replace(/\s+/g, ' ').trim();
}

/**
 * `knownFacts` holds strings from the brief/research the client actually
 * supplied; numeric claims that do not appear there are flagged as potentially
 * invented.
 */
export function antiSlopScan(files: SiteFiles, knownFacts: string[] = []): AntiSlopReport {
  const findings: Finding[] = [];
  const factsBlob = knownFacts.join(' ').toLowerCase();
  const banned = new Map<string, { count: number; pages: Set<string> }>();
  const claims: AntiSlopReport['unsupported_claims'] = [];
  const testimonials: AntiSlopReport['testimonial_markers'] = [];
  const generic: AntiSlopReport['generic_headings'] = [];
  const sentences = new Map<string, number>();

  for (const page of htmlPages(files)) {
    const text = visibleText(files[page]).replace(PLACEHOLDER_RE, ' ');
    const lower = text.toLowerCase();
    for (const phrase of BANNED_PHRASES) {
      const re = new RegExp(`\\b${phrase.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&')}\\b`, 'gi');
      const n = (lower.match(re) ?? []).length;
      if (n) {
        const e = banned.get(phrase) ?? { count: 0, pages: new Set<string>() };
        e.count += n;
        e.pages.add(page);
        banned.set(phrase, e);
      }
    }
    const claimRe = /(\d[\d,.]*\s*(\+|%|percent)|\d[\d,]*\+?\s*(years|yrs|customers|clients|homes|projects|reviews|jobs|technicians|five-star|5-star)|\b[1-5](\.\d)?\s*(\/\s*5|stars?|★)|#1\b|number one|award[- ]winning|\bguarantee(d)?\b)/gi;
    for (const m of text.matchAll(claimRe)) {
      const snippet = text.slice(Math.max(0, (m.index ?? 0) - 40), (m.index ?? 0) + m[0].length + 40).trim();
      const core = m[0].toLowerCase().replace(/\s+/g, ' ').trim();
      if (!factsBlob.includes(core)) claims.push({ page, text: snippet, reason: `"${m[0].trim()}" is not supported by supplied facts` });
    }
    const root = parse(files[page], { comment: false });
    for (const q of root.querySelectorAll('blockquote, [class*="testimonial"], [class*="review"], [id*="testimonial"]')) {
      const t = q.text.replace(/\s+/g, ' ').trim();
      if (t && !/\[\[PLACEHOLDER/.test(q.toString())) testimonials.push({ page, text: t.slice(0, 140) });
    }
    for (const h of root.querySelectorAll('h1, h2, h3')) {
      const t = h.text.replace(/\s+/g, ' ').trim().toLowerCase();
      if (GENERIC_HEADINGS.includes(t)) generic.push({ page, heading: h.text.trim() });
    }
    for (const s of text.split(/(?<=[.!?])\s+/)) {
      const n = s.trim().toLowerCase();
      if (n.length > 40) sentences.set(n, (sentences.get(n) ?? 0) + 1);
    }
  }

  const css = Object.entries(files).filter(([f]) => f.endsWith('.css')).map(([, c]) => c).join('\n') +
    htmlPages(files).map((p) => (files[p].match(/<style[^>]*>([\s\S]*?)<\/style>/gi) ?? []).join('\n')).join('\n');
  const families = new Set<string>();
  for (const m of css.matchAll(/font-family\s*:\s*([^;}{]+)/gi)) {
    const first = m[1].split(',')[0].trim().replace(/["']/g, '').toLowerCase();
    if (first && !first.startsWith('var(') && !['inherit', 'initial', 'system-ui', 'sans-serif', 'serif', 'monospace'].includes(first)) families.add(first);
  }
  const fontSizes = new Set([...css.matchAll(/font-size\s*:\s*([^;}{]+)/gi)].map((m) => m[1].trim()));
  const cssStats = {
    gradients: (css.match(/(linear|radial|conic)-gradient\(/gi) ?? []).length,
    backdrop_filters: (css.match(/backdrop-filter\s*:/gi) ?? []).length,
    keyframes: (css.match(/@keyframes/gi) ?? []).length,
    animations: (css.match(/(^|[\s;{])animation\s*:/gi) ?? []).length,
    font_families: [...families],
    distinct_font_sizes: fontSizes.size,
    box_shadows: (css.match(/box-shadow\s*:/gi) ?? []).length,
  };

  for (const [phrase, e] of banned) findings.push({ severity: 'major', rule: 'banned_phrase', page: [...e.pages].join(', '), detail: `Filler phrase "${phrase}" used ${e.count}x` });
  for (const c of claims) findings.push({ severity: 'critical', rule: 'unsupported_claim', page: c.page, detail: `${c.reason}: …${c.text}…` });
  for (const t of testimonials) findings.push({ severity: 'critical', rule: 'testimonial', page: t.page, detail: `Testimonial/review content not supplied by client: "${t.text}"` });
  for (const g of generic) findings.push({ severity: 'minor', rule: 'generic_heading', page: g.page, detail: `Generic template heading "${g.heading}"` });
  const repeated = [...sentences.entries()].filter(([, n]) => n > 1).map(([sentence, count]) => ({ sentence: sentence.slice(0, 120), count }));
  for (const r of repeated.slice(0, 10)) findings.push({ severity: 'minor', rule: 'repeated_sentence', page: null, detail: `Sentence repeated ${r.count}x: "${r.sentence}"` });
  if (cssStats.gradients > 4) findings.push({ severity: 'major', rule: 'gradient_overuse', page: null, detail: `${cssStats.gradients} gradients in CSS` });
  if (cssStats.backdrop_filters > 1) findings.push({ severity: 'major', rule: 'glassmorphism', page: null, detail: `${cssStats.backdrop_filters} backdrop-filter uses (glassmorphism overuse)` });
  if (cssStats.keyframes > 4) findings.push({ severity: 'major', rule: 'animation_overuse', page: null, detail: `${cssStats.keyframes} @keyframes animations` });
  if (families.size > 2) findings.push({ severity: 'major', rule: 'font_families', page: null, detail: `${families.size} font families: ${[...families].join(', ')}` });
  if (cssStats.distinct_font_sizes > 14) findings.push({ severity: 'minor', rule: 'type_scale', page: null, detail: `${cssStats.distinct_font_sizes} distinct font-size values (inconsistent type scale)` });

  const penalty = findings.reduce((s, f) => s + (f.severity === 'critical' ? 20 : f.severity === 'major' ? 8 : 2), 0);
  return {
    banned_phrases: [...banned.entries()].map(([phrase, e]) => ({ phrase, count: e.count, pages: [...e.pages] })),
    unsupported_claims: claims,
    testimonial_markers: testimonials,
    generic_headings: generic,
    repeated_sentences: repeated,
    css: cssStats,
    score: Math.max(0, 100 - penalty),
    findings,
    hard_failures: findings.filter((f) => f.severity === 'critical'),
  };
}
