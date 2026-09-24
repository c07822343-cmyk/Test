// Imports an existing website as the project's baseline (version 1 of every
// file) so improvement work starts from what is actually there: agents inspect
// and edit the real pages instead of generating a replacement from scratch.
import path from 'node:path';
import { parse } from 'node-html-parser';
import type { ArtifactStore } from '../memory/artifacts.ts';
import { fetchRaw } from './webFetch.ts';

export interface ImportResult {
  origin: string;
  pages: string[];
  assets: string[];
  errors: string[];
}

function localPathFor(u: URL, kind: 'page' | 'asset'): string | null {
  let p = decodeURIComponent(u.pathname).replace(/^\/+/, '');
  if (kind === 'page') {
    if (!p || p.endsWith('/')) p += 'index.html';
    else if (!/\.html?$/i.test(p)) p += '.html';
  }
  p = path.posix.normalize(p);
  if (p.startsWith('..') || !/^[A-Za-z0-9._\-/]+$/.test(p)) return null;
  if (kind === 'asset' && !/\.(css|js|mjs)$/i.test(p)) return null;
  return p;
}

function relative(fromPage: string, target: string): string {
  const rel = path.posix.relative(path.posix.dirname(fromPage), target);
  return rel || path.posix.basename(target);
}

export async function importExistingSite(
  startUrl: string,
  opts: { projectId: string; artifacts: ArtifactStore; timeoutMs: number; maxBytes: number; maxPages?: number; fetchImpl?: typeof fetch; allowPrivate?: boolean },
): Promise<ImportResult> {
  const errors: string[] = [];
  const home = await fetchRaw(startUrl, opts);
  if (home.status >= 400) throw new Error(`Existing site returned HTTP ${home.status}`);
  const origin = new URL(home.finalUrl).origin;
  const pageUrls = new Map<string, URL>([[localPathFor(new URL(home.finalUrl), 'page') ?? 'index.html', new URL(home.finalUrl)]]);
  const bodies = new Map<string, string>([[[...pageUrls.keys()][0], home.body.toString('utf8')]]);

  // Discover same-origin pages linked from the home page (navigation first).
  const homeRoot = parse(bodies.values().next().value!);
  const links = [...homeRoot.querySelectorAll('nav a[href], header a[href]'), ...homeRoot.querySelectorAll('a[href]')];
  for (const a of links) {
    if (pageUrls.size >= (opts.maxPages ?? 6)) break;
    try {
      const u = new URL(a.getAttribute('href')!, home.finalUrl);
      u.hash = '';
      u.search = '';
      if (u.origin !== origin) continue;
      const local = localPathFor(u, 'page');
      if (!local || pageUrls.has(local) || /\.(pdf|jpg|jpeg|png|gif|webp|svg|zip)$/i.test(u.pathname)) continue;
      pageUrls.set(local, u);
    } catch {
      /* ignore malformed hrefs */
    }
  }
  for (const [local, u] of pageUrls) {
    if (bodies.has(local)) continue;
    try {
      const r = await fetchRaw(u.toString(), opts);
      if (r.status < 400 && /html/i.test(r.contentType)) bodies.set(local, r.body.toString('utf8'));
      else pageUrls.delete(local);
    } catch (err) {
      errors.push(`${u}: ${(err as Error).message}`);
      pageUrls.delete(local);
    }
  }

  const assets = new Map<string, URL>();
  const pages: string[] = [];
  for (const [local, html] of bodies) {
    const root = parse(html, { comment: true });
    const base = pageUrls.get(local)!;
    for (const a of root.querySelectorAll('a[href]')) {
      try {
        const u = new URL(a.getAttribute('href')!, base);
        const hash = u.hash;
        u.hash = '';
        u.search = '';
        const target = u.origin === origin ? localPathFor(u, 'page') : null;
        if (target && pageUrls.has(target)) a.setAttribute('href', relative(local, target) + hash);
        else if (!/^(mailto:|tel:|#)/i.test(a.getAttribute('href')!)) a.setAttribute('href', u.toString() + hash);
      } catch {
        /* keep original */
      }
    }
    for (const el of [...root.querySelectorAll('link[rel="stylesheet"][href]'), ...root.querySelectorAll('script[src]')]) {
      const attr = el.tagName === 'LINK' ? 'href' : 'src';
      try {
        const u = new URL(el.getAttribute(attr)!, base);
        const target = u.origin === origin ? localPathFor(u, 'asset') : null;
        if (target && assets.size < 12) {
          assets.set(target, u);
          el.setAttribute(attr, relative(local, target));
        } else el.setAttribute(attr, u.toString());
      } catch {
        /* keep original */
      }
    }
    // Images and other media stay on the live origin (absolute URLs).
    for (const img of root.querySelectorAll('img[src], source[src]')) {
      try {
        img.setAttribute('src', new URL(img.getAttribute('src')!, base).toString());
      } catch {
        /* keep original */
      }
    }
    await opts.artifacts.save({ projectId: opts.projectId, taskId: null, path: `site/${local}`, content: root.toString(), kind: 'client_file', createdBy: 'import:existing_site' });
    pages.push(local);
  }
  const savedAssets: string[] = [];
  for (const [local, u] of assets) {
    try {
      const r = await fetchRaw(u.toString(), opts);
      if (r.status < 400) {
        await opts.artifacts.save({ projectId: opts.projectId, taskId: null, path: `site/${local}`, content: r.body, kind: 'client_file', createdBy: 'import:existing_site' });
        savedAssets.push(local);
      }
    } catch (err) {
      errors.push(`${u}: ${(err as Error).message}`);
    }
  }
  return { origin, pages, assets: savedAssets, errors };
}
