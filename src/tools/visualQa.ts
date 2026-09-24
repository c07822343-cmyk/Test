// Visual QA + Bug Scan: real Chromium rendering of the built site.
//
// visualQa(): desktop/tablet/mobile full screenshots plus region checks
// (navigation, hero, typography, spacing, CTAs, cards, forms, animations/3D,
// footer, overflow, overlap, broken images). With the previous pass's
// screenshots it computes a pixel diff and resolved/new issue sets so the
// refinement loop can require measurable progress.
//
// bugScan(): console errors, uncaught exceptions, failed requests, broken
// images and anchors, and interaction smoke tests (menu toggle, form).
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import pixelmatch from 'pixelmatch';
import { PNG } from 'pngjs';
import { contentTypeFor } from '../memory/artifacts.ts';
import type { Finding, SiteFiles } from './siteAudit.ts';
import { htmlPages } from './siteAudit.ts';

export const QA_VIEWPORTS = [
  { name: 'desktop', width: 1440, height: 900 },
  { name: 'tablet', width: 768, height: 1024 },
  { name: 'mobile', width: 375, height: 812 },
] as const;

export interface VisualIssue extends Finding {
  viewport: string;
  region: string;
  element: string | null;
  key: string;
}

export interface VisualQaReport {
  available: true;
  pages: string[];
  issues: VisualIssue[];
  score: number;
  screenshots: Array<{ page: string; viewport: string; png: Buffer }>;
  comparison: null | { diff_ratio_by_viewport: Record<string, number>; resolved: string[]; new_issues: string[]; previous_score: number | null };
  findings: Finding[];
  hard_failures: Finding[];
}

async function launch(): Promise<any | { available: false; reason: string }> {
  try {
    const { chromium } = await import('playwright-core');
    return await chromium.launch({ executablePath: process.env.CHROMIUM_EXECUTABLE_PATH || undefined, args: ['--no-sandbox', '--disable-dev-shm-usage', '--use-gl=swiftshader', '--enable-webgl'] });
  } catch (err) {
    return { available: false, reason: `Headless Chromium unavailable: ${(err as Error).message.split('\n')[0]}` };
  }
}

async function serve(files: Record<string, string | Buffer>) {
  const server = http.createServer((req, res) => {
    let p = decodeURIComponent((req.url ?? '/').split('?')[0]).replace(/^\/+/, '');
    if (!p || p.endsWith('/')) p += 'index.html';
    p = path.posix.normalize(p);
    const body = files[p];
    if (body === undefined) {
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('not found');
      return;
    }
    res.writeHead(200, { 'content-type': contentTypeFor(p), 'cache-control': 'no-store' });
    res.end(body);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const { port } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${port}`, close: () => new Promise<void>((r) => server.close(() => r())) };
}

const WEIGHT = { critical: 10, major: 4, minor: 1 } as const;
export const issueScore = (issues: Array<{ severity: keyof typeof WEIGHT }>) => issues.reduce((s, i) => s + WEIGHT[i.severity], 0);

/** Region checks run inside the page. Returns raw observations; severity is assigned in Node. */
const REGION_PROBE = () => {
  const vw = document.documentElement.clientWidth;
  const vh = window.innerHeight;
  const desc = (el: Element | null) => {
    if (!el) return null;
    const id = el.id ? `#${el.id}` : '';
    const cls = typeof (el as HTMLElement).className === 'string' && (el as HTMLElement).className.trim() ? `.${(el as HTMLElement).className.trim().split(/\s+/).slice(0, 2).join('.')}` : '';
    return `${el.tagName.toLowerCase()}${id}${cls}`;
  };
  const visible = (el: Element) => {
    const r = el.getBoundingClientRect();
    const st = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && st.visibility !== 'hidden' && st.display !== 'none' && Number(st.opacity) > 0.05;
  };
  const obs: Array<{ region: string; rule: string; element: string | null; detail: string; sev: 'critical' | 'major' | 'minor' }> = [];
  // Overflow.
  if (document.documentElement.scrollWidth > vw + 1) obs.push({ region: 'layout', rule: 'horizontal_overflow', element: null, detail: `page is ${document.documentElement.scrollWidth}px wide in a ${vw}px viewport`, sev: 'critical' });
  // Navigation.
  const nav = document.querySelector('nav, header [role="navigation"]');
  if (!nav) obs.push({ region: 'navigation', rule: 'nav_missing', element: null, detail: 'no <nav> element', sev: 'major' });
  else {
    const links = Array.from(nav.querySelectorAll('a')).filter(visible);
    const toggle = document.querySelector('button[aria-controls], button[aria-expanded], .menu-toggle, .nav-toggle, [data-menu-toggle]');
    if (links.length === 0 && !toggle) obs.push({ region: 'navigation', rule: 'nav_unreachable', element: desc(nav), detail: 'navigation links hidden with no visible menu toggle', sev: 'critical' });
    const navRect = nav.getBoundingClientRect();
    if (navRect.right > vw + 1) obs.push({ region: 'navigation', rule: 'nav_overflow', element: desc(nav), detail: 'navigation extends past the viewport', sev: 'major' });
  }
  // Hero + primary CTA above the fold.
  const h1 = document.querySelector('h1');
  if (!h1 || !visible(h1)) obs.push({ region: 'hero', rule: 'hero_heading_missing', element: null, detail: 'no visible h1', sev: 'critical' });
  else {
    const r = h1.getBoundingClientRect();
    if (r.top > vh) obs.push({ region: 'hero', rule: 'hero_below_fold', element: desc(h1), detail: `h1 starts ${Math.round(r.top)}px down (viewport ${vh}px)`, sev: 'major' });
    const size = parseFloat(getComputedStyle(h1).fontSize);
    if (size < (vw < 500 ? 26 : 34)) obs.push({ region: 'typography', rule: 'weak_hero_heading', element: desc(h1), detail: `h1 is ${size}px`, sev: 'minor' });
  }
  const ctas = Array.from(document.querySelectorAll('a.btn, a.button, button, a[class*="cta"], a[href^="tel:"], input[type="submit"]')).filter(visible);
  const aboveFold = ctas.filter((c) => c.getBoundingClientRect().top < vh);
  if (ctas.length === 0) obs.push({ region: 'cta', rule: 'no_cta', element: null, detail: 'no call-to-action found', sev: 'critical' });
  else if (aboveFold.length === 0) obs.push({ region: 'cta', rule: 'cta_below_fold', element: desc(ctas[0]), detail: 'no call-to-action visible in the first viewport', sev: 'major' });
  for (const c of ctas.slice(0, 20)) {
    const r = c.getBoundingClientRect();
    if (vw < 500 && (r.height < 44 || r.width < 44)) obs.push({ region: 'cta', rule: 'small_tap_target', element: desc(c), detail: `${Math.round(r.width)}x${Math.round(r.height)}px`, sev: 'major' });
  }
  // Typography.
  const body = getComputedStyle(document.body);
  if (parseFloat(body.fontSize) < 16) obs.push({ region: 'typography', rule: 'small_body_text', element: 'body', detail: `body text ${body.fontSize}`, sev: 'major' });
  const lh = parseFloat(body.lineHeight);
  if (!Number.isNaN(lh) && lh / parseFloat(body.fontSize) < 1.3) obs.push({ region: 'typography', rule: 'tight_line_height', element: 'body', detail: `line-height ${body.lineHeight}`, sev: 'minor' });
  for (const p of Array.from(document.querySelectorAll('p')).filter(visible).slice(0, 40)) {
    const fs = parseFloat(getComputedStyle(p).fontSize);
    const chars = p.getBoundingClientRect().width / (fs * 0.5);
    if (chars > 95) {
      obs.push({ region: 'typography', rule: 'long_measure', element: desc(p), detail: `~${Math.round(chars)} characters per line`, sev: 'minor' });
      break;
    }
  }
  // Clipped text / cards.
  for (const el of Array.from(document.querySelectorAll('h1,h2,h3,p,a,button,li,.card,[class*="card"]')).filter(visible).slice(0, 300)) {
    const st = getComputedStyle(el);
    if ((st.overflow === 'hidden' || st.overflowX === 'hidden' || st.textOverflow === 'ellipsis') && (el.scrollWidth > el.clientWidth + 2 || el.scrollHeight > el.clientHeight + 4)) {
      obs.push({ region: /card/.test(desc(el) ?? '') ? 'cards' : 'content', rule: 'clipped_content', element: desc(el), detail: 'content is clipped by its container', sev: 'major' });
    }
  }
  // Overlapping text blocks (not nested).
  const blocks = Array.from(document.querySelectorAll('h1,h2,h3,p,a.btn,button,label,input,img')).filter(visible).slice(0, 200);
  let overlaps = 0;
  for (let i = 0; i < blocks.length && overlaps < 5; i++) {
    for (let j = i + 1; j < blocks.length && overlaps < 5; j++) {
      const a = blocks[i];
      const b = blocks[j];
      if (a.contains(b) || b.contains(a)) continue;
      const ra = a.getBoundingClientRect();
      const rb = b.getBoundingClientRect();
      const ix = Math.max(0, Math.min(ra.right, rb.right) - Math.max(ra.left, rb.left));
      const iy = Math.max(0, Math.min(ra.bottom, rb.bottom) - Math.max(ra.top, rb.top));
      if (ix * iy > 0.25 * Math.min(ra.width * ra.height, rb.width * rb.height) && ix * iy > 40) {
        overlaps++;
        obs.push({ region: 'layout', rule: 'overlapping_elements', element: `${desc(a)} / ${desc(b)}`, detail: 'elements overlap', sev: 'major' });
      }
    }
  }
  // Spacing: sections with almost no vertical padding.
  for (const s of Array.from(document.querySelectorAll('main > section, main > div, section')).filter(visible).slice(0, 30)) {
    const st = getComputedStyle(s);
    if (parseFloat(st.paddingTop) + parseFloat(st.paddingBottom) < 16 && s.getBoundingClientRect().height > 120 && !s.querySelector('section')) {
      obs.push({ region: 'spacing', rule: 'cramped_section', element: desc(s), detail: `vertical padding ${st.paddingTop} / ${st.paddingBottom}`, sev: 'minor' });
    }
  }
  // Forms.
  for (const f of Array.from(document.querySelectorAll('form')).filter(visible)) {
    for (const input of Array.from(f.querySelectorAll('input:not([type=hidden]),textarea,select')).filter(visible)) {
      if (input.getBoundingClientRect().right > vw + 1) obs.push({ region: 'forms', rule: 'form_field_overflow', element: desc(input), detail: 'form field wider than the viewport', sev: 'major' });
    }
    if (!f.querySelector('button, input[type=submit]')) obs.push({ region: 'forms', rule: 'form_without_submit', element: desc(f), detail: 'form has no submit control', sev: 'major' });
  }
  // Images.
  for (const img of Array.from(document.images)) {
    if (img.complete && img.naturalWidth === 0 && img.getAttribute('src')) obs.push({ region: 'images', rule: 'broken_image', element: desc(img), detail: `failed to load ${img.getAttribute('src')}`, sev: 'major' });
  }
  // Animation / reveal leaving content invisible.
  const hidden = Array.from(document.querySelectorAll('main h1, main h2, main p')).filter((el) => {
    const r = el.getBoundingClientRect();
    return r.top < vh && r.bottom > 0 && Number(getComputedStyle(el).opacity) < 0.1;
  });
  if (hidden.length) obs.push({ region: 'animation', rule: 'content_hidden_by_animation', element: desc(hidden[0]), detail: `${hidden.length} above-the-fold element(s) still invisible after load`, sev: 'major' });
  const running = (document as any).getAnimations ? (document as any).getAnimations().filter((a: any) => a.playState === 'running' && a.effect?.getTiming?.().iterations === Infinity).length : 0;
  // 3D / canvas.
  const canvases = Array.from(document.querySelectorAll('canvas')).filter(visible);
  for (const c of canvases) {
    const r = c.getBoundingClientRect();
    if (h1 && visible(h1)) {
      const hr = h1.getBoundingClientRect();
      const ix = Math.max(0, Math.min(r.right, hr.right) - Math.max(r.left, hr.left));
      const iy = Math.max(0, Math.min(r.bottom, hr.bottom) - Math.max(r.top, hr.top));
      if (ix * iy > 0 && getComputedStyle(c).zIndex !== 'auto' && Number(getComputedStyle(c).zIndex) > Number(getComputedStyle(h1).zIndex || 0)) {
        obs.push({ region: '3d', rule: 'canvas_covers_heading', element: desc(c), detail: '3D canvas renders above the main heading', sev: 'major' });
      }
    }
  }
  // Footer.
  const footer = document.querySelector('footer');
  if (!footer) obs.push({ region: 'footer', rule: 'footer_missing', element: null, detail: 'no <footer>', sev: 'minor' });
  return { obs, infinite_animations: running, canvases: canvases.length };
};

export async function visualQa(files: SiteFiles, previous?: { screenshots: Map<string, Buffer>; issueKeys: string[]; score: number | null }): Promise<VisualQaReport | { available: false; reason: string }> {
  const browser = await launch();
  if ('available' in browser) return browser;
  const site = await serve(files);
  const issues: VisualIssue[] = [];
  const screenshots: VisualQaReport['screenshots'] = [];
  const pages = htmlPages(files).slice(0, 5);
  try {
    for (const page of pages) {
      for (const vp of QA_VIEWPORTS) {
        const ctx = await browser.newContext({ viewport: { width: vp.width, height: vp.height }, deviceScaleFactor: 1 });
        const p = await ctx.newPage();
        await p.goto(`${site.url}/${page}`, { waitUntil: 'load', timeout: 30_000 });
        await p.waitForTimeout(900);
        const res = await p.evaluate(REGION_PROBE);
        for (const o of res.obs) {
          issues.push({ severity: o.sev, rule: o.rule, page, detail: `${vp.name}: ${o.detail}`, viewport: vp.name, region: o.region, element: o.element, key: `${page}|${vp.name}|${o.rule}|${o.element ?? ''}` });
        }
        if (res.infinite_animations > 3) issues.push({ severity: 'minor', rule: 'perpetual_animation', page, detail: `${vp.name}: ${res.infinite_animations} infinite animations running`, viewport: vp.name, region: 'animation', element: null, key: `${page}|${vp.name}|perpetual_animation|` });
        // Mobile navigation interaction: the toggle must reveal links.
        if (vp.name === 'mobile') {
          const toggle = await p.$('button[aria-controls], button[aria-expanded], .menu-toggle, .nav-toggle, [data-menu-toggle]');
          if (toggle && (await toggle.isVisible())) {
            await toggle.click().catch(() => undefined);
            await p.waitForTimeout(300);
            const shown = await p.evaluate(() => Array.from(document.querySelectorAll('nav a')).some((a) => {
              const r = a.getBoundingClientRect();
              return r.width > 0 && r.height > 0 && getComputedStyle(a).visibility !== 'hidden';
            }));
            if (!shown) issues.push({ severity: 'critical', rule: 'menu_toggle_broken', page, detail: 'mobile: menu toggle does not reveal navigation links', viewport: vp.name, region: 'navigation', element: 'menu toggle', key: `${page}|mobile|menu_toggle_broken|` });
          }
        }
        if (page === pages[0]) {
          const png: Buffer = await p.screenshot({ fullPage: true, type: 'png', timeout: 30_000 }).catch(() => p.screenshot({ type: 'png' }));
          screenshots.push({ page, viewport: vp.name, png });
        }
        await ctx.close();
      }
    }
  } finally {
    await browser.close().catch(() => undefined);
    await site.close();
  }
  const score = issueScore(issues);
  let comparison: VisualQaReport['comparison'] = null;
  if (previous) {
    const ratios: Record<string, number> = {};
    for (const s of screenshots) {
      const prev = previous.screenshots.get(s.viewport);
      if (prev) ratios[s.viewport] = pixelDiffRatio(prev, s.png);
    }
    const now = new Set(issues.map((i) => i.key));
    comparison = {
      diff_ratio_by_viewport: ratios,
      resolved: previous.issueKeys.filter((k) => !now.has(k)),
      new_issues: [...now].filter((k) => !previous.issueKeys.includes(k)),
      previous_score: previous.score,
    };
  }
  const findings: Finding[] = issues.map((i) => ({ severity: i.severity, rule: i.rule, page: i.page, detail: `[${i.region}${i.element ? ` ${i.element}` : ''}] ${i.detail}` }));
  return { available: true, pages, issues, score, screenshots, comparison, findings, hard_failures: findings.filter((f) => f.severity === 'critical') };
}

/** Fraction of differing pixels over the overlapping area of two PNGs. */
export function pixelDiffRatio(a: Buffer, b: Buffer): number {
  const pa = PNG.sync.read(a);
  const pb = PNG.sync.read(b);
  const w = Math.min(pa.width, pb.width);
  const h = Math.min(pa.height, pb.height, 4000);
  if (w === 0 || h === 0) return 1;
  const crop = (p: PNG) => {
    const out = new PNG({ width: w, height: h });
    for (let y = 0; y < h; y++) p.data.copy(out.data, y * w * 4, y * p.width * 4, y * p.width * 4 + w * 4);
    return out;
  };
  const ca = crop(pa);
  const cb = crop(pb);
  const diff = pixelmatch(ca.data, cb.data, undefined, w, h, { threshold: 0.1 });
  const heightPenalty = Math.abs(pa.height - pb.height) / Math.max(pa.height, pb.height);
  return Number(Math.min(1, diff / (w * h) + heightPenalty).toFixed(4));
}

// ----------------------------------------------------------------- BUG SCAN
export interface BugScanReport {
  available: true;
  console_errors: Array<{ page: string; viewport: string; text: string }>;
  page_errors: Array<{ page: string; viewport: string; text: string }>;
  failed_requests: Array<{ page: string; url: string; status: number | string }>;
  broken_anchors: Array<{ page: string; href: string }>;
  interaction_checks: Array<{ page: string; check: string; passed: boolean; detail: string }>;
  findings: Finding[];
  hard_failures: Finding[];
}

export async function bugScan(files: SiteFiles): Promise<BugScanReport | { available: false; reason: string }> {
  const browser = await launch();
  if ('available' in browser) return browser;
  const site = await serve(files);
  const report: Omit<BugScanReport, 'available' | 'findings' | 'hard_failures'> = { console_errors: [], page_errors: [], failed_requests: [], broken_anchors: [], interaction_checks: [] };
  try {
    for (const page of htmlPages(files).slice(0, 8)) {
      for (const vp of [QA_VIEWPORTS[0], QA_VIEWPORTS[2]]) {
        const ctx = await browser.newContext({ viewport: { width: vp.width, height: vp.height } });
        const p = await ctx.newPage();
        p.on('console', (m: any) => {
          if (m.type() === 'error') report.console_errors.push({ page, viewport: vp.name, text: String(m.text()).slice(0, 300) });
        });
        p.on('pageerror', (e: any) => report.page_errors.push({ page, viewport: vp.name, text: String(e?.message ?? e).slice(0, 300) }));
        p.on('response', (r: any) => {
          if (r.url().startsWith(site.url) && r.status() >= 400) report.failed_requests.push({ page, url: r.url().replace(site.url, ''), status: r.status() });
        });
        p.on('requestfailed', (r: any) => {
          if (r.url().startsWith(site.url)) report.failed_requests.push({ page, url: r.url().replace(site.url, ''), status: r.failure()?.errorText ?? 'failed' });
        });
        await p.goto(`${site.url}/${page}`, { waitUntil: 'load', timeout: 30_000 });
        await p.waitForTimeout(500);
        if (vp.name === 'desktop') {
          const anchors = await p.evaluate(() => Array.from(document.querySelectorAll('a[href^="#"]')).map((a) => a.getAttribute('href')!).filter((h) => h.length > 1 && !document.getElementById(h.slice(1))));
          for (const href of anchors) report.broken_anchors.push({ page, href });
          const forms = await p.evaluate(() => Array.from(document.forms).map((f) => ({ action: f.getAttribute('action'), hasSubmit: !!f.querySelector('button, input[type=submit]'), required: f.querySelectorAll('[required]').length })));
          for (const f of forms) report.interaction_checks.push({ page, check: 'form', passed: f.hasSubmit, detail: f.hasSubmit ? `form (action=${f.action ?? 'none'}, ${f.required} required fields)` : 'form has no submit control' });
          const telLinks = await p.evaluate(() => Array.from(document.querySelectorAll('a[href^="tel:"]')).map((a) => a.getAttribute('href')!));
          for (const t of telLinks) {
            const ok = /^tel:\+?[\d\-().\s]{7,}$/.test(t);
            report.interaction_checks.push({ page, check: 'tel_link', passed: ok, detail: ok ? t : `malformed telephone link ${t}` });
          }
        } else {
          const toggle = await p.$('button[aria-controls], button[aria-expanded], .menu-toggle, .nav-toggle');
          if (toggle && (await toggle.isVisible())) {
            const before = await toggle.getAttribute('aria-expanded');
            await toggle.click().catch(() => undefined);
            await p.waitForTimeout(250);
            const after = await toggle.getAttribute('aria-expanded');
            const passed = before !== after || before === null;
            report.interaction_checks.push({ page, check: 'menu_toggle', passed, detail: passed ? 'menu toggle responds' : 'aria-expanded does not change when the menu toggle is clicked' });
          }
        }
        await ctx.close();
      }
    }
  } finally {
    await browser.close().catch(() => undefined);
    await site.close();
  }
  const findings: Finding[] = [
    ...report.page_errors.map((e): Finding => ({ severity: 'critical', rule: 'uncaught_exception', page: e.page, detail: `${e.viewport}: ${e.text}` })),
    ...report.console_errors.map((e): Finding => ({ severity: 'major', rule: 'console_error', page: e.page, detail: `${e.viewport}: ${e.text}` })),
    ...report.failed_requests.map((r): Finding => ({ severity: 'critical', rule: 'failed_request', page: r.page, detail: `${r.url} -> ${r.status}` })),
    ...report.broken_anchors.map((a): Finding => ({ severity: 'major', rule: 'broken_anchor', page: a.page, detail: `${a.href} has no target` })),
    ...report.interaction_checks.filter((c) => !c.passed).map((c): Finding => ({ severity: 'major', rule: `interaction:${c.check}`, page: c.page, detail: c.detail })),
  ];
  return { available: true, ...report, findings, hard_failures: findings.filter((f) => f.severity === 'critical') };
}
