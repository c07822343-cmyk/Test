// Real browser measurements with headless Chromium (playwright-core):
// responsive overflow/tap-target/text-size checks, axe-core WCAG audit,
// performance probe (LCP/CLS/bytes) and screenshots for vision agents.
// If Chromium is unavailable the tools say so explicitly - they never fake
// a pass.
import { createRequire } from 'node:module';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { contentTypeFor } from '../memory/artifacts.ts';
import { htmlPages, type Finding, type SiteFiles } from './siteAudit.ts';

const require = createRequire(import.meta.url);

export const VIEWPORTS = [
  { name: 'mobile', width: 360, height: 800 },
  { name: 'tablet', width: 768, height: 1024 },
  { name: 'desktop', width: 1440, height: 900 },
] as const;

export interface BrowserUnavailable {
  available: false;
  reason: string;
}

async function loadChromium(): Promise<any | BrowserUnavailable> {
  try {
    const { chromium } = await import('playwright-core');
    const executablePath = process.env.CHROMIUM_EXECUTABLE_PATH || undefined;
    return await chromium.launch({ executablePath, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  } catch (err) {
    return { available: false, reason: `Headless Chromium unavailable: ${(err as Error).message.split('\n')[0]}` };
  }
}

/** Serves the site files over HTTP on an ephemeral loopback port (so resource timing and relative URLs behave as in production). */
async function serve(files: SiteFiles & Record<string, string | Buffer>): Promise<{ url: string; close: () => Promise<void> }> {
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
  return { url: `http://127.0.0.1:${port}`, close: () => new Promise((r) => server.close(() => r())) };
}

async function withSite<T>(files: SiteFiles, fn: (browser: any, baseUrl: string) => Promise<T>): Promise<T | BrowserUnavailable> {
  const browser = await loadChromium();
  if ('available' in browser) return browser;
  const site = await serve(files);
  try {
    return await fn(browser, site.url);
  } finally {
    await browser.close().catch(() => undefined);
    await site.close();
  }
}

// ----------------------------------------------------------- RESPONSIVE
export interface ResponsiveReport {
  available: true;
  results: Array<{
    page: string;
    viewport: string;
    width: number;
    scroll_width: number;
    horizontal_overflow: boolean;
    overflowing_elements: string[];
    small_tap_targets: string[];
    small_text_nodes: number;
    page_height: number;
  }>;
  screenshots: Array<{ page: string; viewport: string; png_base64: string }>;
  findings: Finding[];
  hard_failures: Finding[];
}

export async function responsiveRender(files: SiteFiles, opts: { screenshots?: boolean; maxPages?: number } = {}): Promise<ResponsiveReport | BrowserUnavailable> {
  return withSite(files, async (browser, base) => {
    const results: ResponsiveReport['results'] = [];
    const shots: ResponsiveReport['screenshots'] = [];
    const findings: Finding[] = [];
    for (const page of htmlPages(files).slice(0, opts.maxPages ?? 6)) {
      for (const vp of VIEWPORTS) {
        const ctx = await browser.newContext({ viewport: { width: vp.width, height: vp.height }, deviceScaleFactor: 1, reducedMotion: 'reduce' });
        const p = await ctx.newPage();
        await p.goto(`${base}/${page}`, { waitUntil: 'load', timeout: 30_000 });
        await p.waitForTimeout(300);
        const m = await p.evaluate(() => {
          const vw = document.documentElement.clientWidth;
          const describe = (el: Element) => {
            const id = el.id ? `#${el.id}` : '';
            const cls = typeof el.className === 'string' && el.className.trim() ? `.${el.className.trim().split(/\s+/).slice(0, 2).join('.')}` : '';
            return `${el.tagName.toLowerCase()}${id}${cls}`;
          };
          const overflowing: string[] = [];
          for (const el of Array.from(document.body.querySelectorAll('*'))) {
            const r = el.getBoundingClientRect();
            if (r.width > 0 && r.right > vw + 1 && getComputedStyle(el).position !== 'fixed') {
              let hiddenByAncestor = false;
              for (let a = el.parentElement; a; a = a.parentElement) {
                const ov = getComputedStyle(a).overflowX;
                if ((ov === 'hidden' || ov === 'auto' || ov === 'scroll' || ov === 'clip') && a.getBoundingClientRect().right <= vw + 1) {
                  hiddenByAncestor = true;
                  break;
                }
              }
              if (!hiddenByAncestor) overflowing.push(describe(el));
            }
          }
          const small: string[] = [];
          for (const el of Array.from(document.querySelectorAll('a, button, [role="button"], input[type="submit"]'))) {
            const r = el.getBoundingClientRect();
            const st = getComputedStyle(el);
            if (r.width === 0 || st.visibility === 'hidden' || st.display === 'none') continue;
            // Off-screen until focused (e.g. skip links) is not a tap target.
            if (r.right <= 0 || r.bottom <= 0 || r.left >= vw) continue;
            const inline = st.display === 'inline' && el.closest('p, li');
            if (!inline && (r.height < 44 || r.width < 44)) small.push(`${describe(el)} (${Math.round(r.width)}x${Math.round(r.height)})`);
          }
          let smallText = 0;
          const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
          for (let n = walker.nextNode(); n; n = walker.nextNode()) {
            if (!n.textContent?.trim() || !n.parentElement) continue;
            const st = getComputedStyle(n.parentElement);
            if (st.display !== 'none' && parseFloat(st.fontSize) < 14) smallText++;
          }
          return { vw, sw: document.documentElement.scrollWidth, overflowing: overflowing.slice(0, 12), small: small.slice(0, 15), smallText, h: document.documentElement.scrollHeight };
        });
        const overflow = m.sw > m.vw + 1;
        results.push({ page, viewport: vp.name, width: vp.width, scroll_width: m.sw, horizontal_overflow: overflow, overflowing_elements: m.overflowing, small_tap_targets: m.small, small_text_nodes: m.smallText, page_height: m.h });
        if (overflow) findings.push({ severity: 'critical', rule: 'horizontal_overflow', page, detail: `${vp.name} (${vp.width}px): content is ${m.sw}px wide; overflowing: ${m.overflowing.slice(0, 5).join(', ')}` });
        if (vp.name === 'mobile' && m.small.length) findings.push({ severity: 'major', rule: 'tap_targets', page, detail: `${m.small.length} tap target(s) under 44px: ${m.small.slice(0, 5).join(', ')}` });
        if (vp.name === 'mobile' && m.smallText > 5) findings.push({ severity: 'minor', rule: 'small_text', page, detail: `${m.smallText} text node(s) under 14px on mobile` });
        if (opts.screenshots && page === 'index.html' && vp.name !== 'tablet') {
          const png: Buffer = await p.screenshot({ fullPage: false, type: 'png' });
          shots.push({ page, viewport: vp.name, png_base64: png.toString('base64') });
        }
        await ctx.close();
      }
    }
    return { available: true as const, results, screenshots: shots, findings, hard_failures: findings.filter((f) => f.severity === 'critical') };
  });
}

// --------------------------------------------------------- ACCESSIBILITY
export interface AxeReport {
  available: true;
  pages: Array<{ page: string; violations: Array<{ id: string; impact: string | null; help: string; nodes: number; targets: string[] }> }>;
  findings: Finding[];
  hard_failures: Finding[];
}

export async function accessibilityAxe(files: SiteFiles): Promise<AxeReport | BrowserUnavailable> {
  let axeSource: string;
  try {
    axeSource = (await import('node:fs')).readFileSync(require.resolve('axe-core/axe.min.js'), 'utf8');
  } catch {
    return { available: false, reason: 'axe-core is not installed' };
  }
  return withSite(files, async (browser, base) => {
    const pages: AxeReport['pages'] = [];
    const findings: Finding[] = [];
    for (const page of htmlPages(files).slice(0, 8)) {
      const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
      const p = await ctx.newPage();
      await p.goto(`${base}/${page}`, { waitUntil: 'load', timeout: 30_000 });
      await p.addScriptTag({ content: axeSource });
      const res = await p.evaluate(async () => {
        // @ts-ignore axe is injected above
        const r = await window.axe.run(document, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice'] } });
        return r.violations.map((v: any) => ({ id: v.id, impact: v.impact, help: v.help, nodes: v.nodes.length, targets: v.nodes.slice(0, 4).map((n: any) => String(n.target)) }));
      });
      pages.push({ page, violations: res });
      for (const v of res) {
        const severity = v.impact === 'critical' || v.impact === 'serious' ? 'critical' : v.impact === 'moderate' ? 'major' : 'minor';
        findings.push({ severity, rule: `axe:${v.id}`, page, detail: `${v.help} (${v.nodes} node(s): ${v.targets.join(' | ')})` });
      }
      await ctx.close();
    }
    return { available: true as const, pages, findings, hard_failures: findings.filter((f) => f.severity === 'critical') };
  });
}

// ------------------------------------------------------------ PERFORMANCE
export interface PerformanceReport {
  available: true;
  pages: Array<{ page: string; lcp_ms: number | null; cls: number; dom_content_loaded_ms: number; load_ms: number; requests: number; transfer_bytes: number; by_type: Record<string, number>; render_blocking: string[] }>;
  total_site_bytes: number;
  findings: Finding[];
  hard_failures: Finding[];
}

export async function performanceProbe(files: SiteFiles): Promise<PerformanceReport | BrowserUnavailable> {
  return withSite(files, async (browser, base) => {
    const pages: PerformanceReport['pages'] = [];
    const findings: Finding[] = [];
    for (const page of htmlPages(files).slice(0, 6)) {
      const ctx = await browser.newContext({ viewport: { width: 360, height: 800 } });
      const p = await ctx.newPage();
      // Emulate a mid-range mobile connection (Slow 4G-ish) and 4x CPU slowdown.
      const cdp = await ctx.newCDPSession(p);
      await cdp.send('Network.enable');
      await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 150, downloadThroughput: (1.6 * 1024 * 1024) / 8, uploadThroughput: (750 * 1024) / 8 });
      await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
      await p.addInitScript(() => {
        (window as any).__lcp = null;
        (window as any).__cls = 0;
        new PerformanceObserver((l) => {
          for (const e of l.getEntries()) (window as any).__lcp = e.startTime;
        }).observe({ type: 'largest-contentful-paint', buffered: true });
        new PerformanceObserver((l) => {
          for (const e of l.getEntries() as any[]) if (!e.hadRecentInput) (window as any).__cls += e.value;
        }).observe({ type: 'layout-shift', buffered: true });
      });
      await p.goto(`${base}/${page}`, { waitUntil: 'load', timeout: 60_000 });
      await p.waitForTimeout(800);
      const m = await p.evaluate(() => {
        const nav = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming;
        const res = performance.getEntriesByType('resource') as PerformanceResourceTiming[];
        const byType: Record<string, number> = {};
        let bytes = nav?.transferSize ?? 0;
        for (const r of res) {
          byType[r.initiatorType] = (byType[r.initiatorType] ?? 0) + (r.transferSize || r.encodedBodySize || 0);
          bytes += r.transferSize || r.encodedBodySize || 0;
        }
        const blocking = res.filter((r: any) => r.renderBlockingStatus === 'blocking').map((r) => r.name.replace(location.origin, ''));
        return { lcp: (window as any).__lcp, cls: (window as any).__cls, dcl: nav?.domContentLoadedEventEnd ?? 0, load: nav?.loadEventEnd ?? 0, requests: res.length + 1, bytes, byType, blocking };
      });
      pages.push({ page, lcp_ms: m.lcp == null ? null : Math.round(m.lcp), cls: Number(m.cls.toFixed(3)), dom_content_loaded_ms: Math.round(m.dcl), load_ms: Math.round(m.load), requests: m.requests, transfer_bytes: m.bytes, by_type: m.byType, render_blocking: m.blocking });
      if (m.lcp != null && m.lcp > 2500) findings.push({ severity: m.lcp > 4000 ? 'critical' : 'major', rule: 'lcp', page, detail: `LCP ${Math.round(m.lcp)}ms on emulated mobile (target <= 2500ms)` });
      if (m.cls > 0.1) findings.push({ severity: m.cls > 0.25 ? 'critical' : 'major', rule: 'cls', page, detail: `CLS ${m.cls.toFixed(3)} (target <= 0.1)` });
      if (m.blocking.length > 2) findings.push({ severity: 'minor', rule: 'render_blocking', page, detail: `Render-blocking resources: ${m.blocking.join(', ')}` });
      await ctx.close();
    }
    const total = Object.values(files).reduce((s, c) => s + Buffer.byteLength(c), 0);
    if (total > 1_500_000) findings.push({ severity: 'major', rule: 'site_weight', page: null, detail: `Total site weight ${Math.round(total / 1024)}KB` });
    return { available: true as const, pages, total_site_bytes: total, findings, hard_failures: findings.filter((f) => f.severity === 'critical') };
  });
}
