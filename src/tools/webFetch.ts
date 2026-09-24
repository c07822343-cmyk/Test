// Research fetcher with SSRF protection: only http(s), public addresses only
// (DNS is resolved and private/loopback/link-local ranges rejected), size and
// time capped, redirects re-validated hop by hop.
import { lookup } from 'node:dns/promises';
import net from 'node:net';
import { parse } from 'node-html-parser';
import { redactString } from '../security/redact.ts';

export interface FetchedPage {
  url: string;
  finalUrl: string;
  status: number;
  title: string;
  description: string;
  headings: string[];
  text: string;
  links: string[];
}

function isPrivateAddress(ip: string): boolean {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
  }
  const v6 = ip.toLowerCase();
  return v6 === '::1' || v6 === '::' || v6.startsWith('fc') || v6.startsWith('fd') || v6.startsWith('fe80') || v6.startsWith('::ffff:127.') || v6.startsWith('::ffff:10.') || v6.startsWith('::ffff:192.168.');
}

export async function assertPublicUrl(raw: string): Promise<URL> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`Invalid URL: ${raw}`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error(`Blocked protocol: ${url.protocol}`);
  if (url.username || url.password) throw new Error('URLs with credentials are not fetched');
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const addrs = net.isIP(host) ? [{ address: host }] : await lookup(host, { all: true });
  if (addrs.length === 0 || addrs.some((a) => isPrivateAddress(a.address))) throw new Error(`Blocked non-public address for ${host}`);
  return url;
}

export interface RawFetch {
  finalUrl: string;
  status: number;
  contentType: string;
  body: Buffer;
}

/** SSRF-safe raw fetch (public addresses only, redirects re-validated, size capped). */
export async function fetchRaw(raw: string, opts: { timeoutMs: number; maxBytes: number; fetchImpl?: typeof fetch; allowPrivate?: boolean }): Promise<RawFetch> {
  const doFetch = opts.fetchImpl ?? fetch;
  const check = opts.allowPrivate ? async (u: string) => new URL(u) : assertPublicUrl;
  let url = await check(raw);
  let res: Response | null = null;
  for (let hop = 0; hop < 5; hop++) {
    res = await doFetch(url, { redirect: 'manual', signal: AbortSignal.timeout(opts.timeoutMs), headers: { 'User-Agent': 'ApexWebResearchBot/1.0' } });
    if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
      url = await check(new URL(res.headers.get('location')!, url).toString());
      continue;
    }
    break;
  }
  if (!res) throw new Error('No response');
  const reader = res.body?.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  if (reader) {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > opts.maxBytes) {
        await reader.cancel();
        break;
      }
      chunks.push(value);
    }
  }
  return { finalUrl: url.toString(), status: res.status, contentType: res.headers.get('content-type') ?? '', body: Buffer.concat(chunks) };
}

export async function fetchPage(raw: string, opts: { timeoutMs: number; maxBytes: number; fetchImpl?: typeof fetch }): Promise<FetchedPage> {
  const doFetch = opts.fetchImpl ?? fetch;
  let url = await assertPublicUrl(raw);
  let res: Response | null = null;
  for (let hop = 0; hop < 5; hop++) {
    res = await doFetch(url, {
      redirect: 'manual',
      signal: AbortSignal.timeout(opts.timeoutMs),
      headers: { 'User-Agent': 'ApexWebResearchBot/1.0 (+research; respects robots)', Accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.5' },
    });
    if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
      url = await assertPublicUrl(new URL(res.headers.get('location')!, url).toString());
      continue;
    }
    break;
  }
  if (!res) throw new Error('No response');
  const reader = res.body?.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  if (reader) {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > opts.maxBytes) {
        await reader.cancel();
        break;
      }
      chunks.push(value);
    }
  }
  const html = Buffer.concat(chunks).toString('utf8');
  const root = parse(html, { comment: false, blockTextElements: { script: false, style: false, noscript: false } });
  const title = root.querySelector('title')?.text.trim() ?? '';
  const description = root.querySelector('meta[name="description"]')?.getAttribute('content')?.trim() ?? '';
  const headings = root.querySelectorAll('h1, h2, h3').map((h) => `${h.tagName}: ${h.text.replace(/\s+/g, ' ').trim()}`).filter((h) => h.length > 4).slice(0, 60);
  const links = root.querySelectorAll('a[href]').map((a) => a.getAttribute('href') ?? '').filter((h) => h && !h.startsWith('#') && !h.startsWith('javascript:')).slice(0, 100);
  root.querySelectorAll('nav, footer, svg, form, iframe').forEach((n) => n.remove());
  const text = (root.querySelector('main') ?? root.querySelector('body') ?? root).text.replace(/[ \t]+/g, ' ').replace(/\n\s*\n+/g, '\n').trim();
  return { url: raw, finalUrl: url.toString(), status: res.status, title, description, headings, text: redactString(text).slice(0, 20_000), links };
}
