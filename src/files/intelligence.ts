// File intelligence layer: understands what the client supplied - documents,
// PDFs, images, screenshots, code, ZIP projects, fonts, brand files - and
// produces factual analyses. File contents are untrusted input and pass
// through security screening before any agent sees extracted text.
import path from 'node:path';
import { unzipSync } from 'fflate';
import { sha256 } from '../util/common.ts';

export type FileKind = 'pdf' | 'image' | 'svg' | 'archive' | 'html' | 'css' | 'script' | 'code' | 'json' | 'text' | 'font' | 'document' | 'unknown';

export interface FileAnalysis {
  path: string;
  kind: FileKind;
  mime: string;
  bytes: number;
  sha256: string;
  dimensions?: { width: number; height: number; aspect: number } | null;
  pages?: number;
  text_excerpt?: string;
  lines?: number;
  language?: string;
  entries?: number;
  notes: string[];
}

const TEXT_EXT: Record<string, [FileKind, string]> = {
  '.html': ['html', 'html'], '.htm': ['html', 'html'], '.css': ['css', 'css'], '.scss': ['css', 'scss'], '.js': ['script', 'javascript'], '.mjs': ['script', 'javascript'],
  '.jsx': ['code', 'jsx'], '.ts': ['code', 'typescript'], '.tsx': ['code', 'tsx'], '.vue': ['code', 'vue'], '.svelte': ['code', 'svelte'], '.astro': ['code', 'astro'],
  '.json': ['json', 'json'], '.md': ['text', 'markdown'], '.txt': ['text', 'text'], '.csv': ['text', 'csv'], '.xml': ['text', 'xml'], '.yml': ['text', 'yaml'], '.yaml': ['text', 'yaml'], '.php': ['code', 'php'], '.py': ['code', 'python'],
};

export function imageDimensions(buf: Buffer): { width: number; height: number; format: string } | null {
  if (buf.length > 24 && buf.readUInt32BE(0) === 0x89504e47) return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20), format: 'png' };
  if (buf.length > 10 && buf.toString('ascii', 0, 3) === 'GIF') return { width: buf.readUInt16LE(6), height: buf.readUInt16LE(8), format: 'gif' };
  if (buf.length > 30 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') {
    const chunk = buf.toString('ascii', 12, 16);
    if (chunk === 'VP8X') return { width: 1 + buf.readUIntLE(24, 3), height: 1 + buf.readUIntLE(27, 3), format: 'webp' };
    if (chunk === 'VP8 ') return { width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff, format: 'webp' };
    if (chunk === 'VP8L') {
      const b = buf.readUInt32LE(21);
      return { width: (b & 0x3fff) + 1, height: ((b >> 14) & 0x3fff) + 1, format: 'webp' };
    }
  }
  if (buf.length > 4 && buf[0] === 0xff && buf[1] === 0xd8) {
    let i = 2;
    while (i < buf.length - 9) {
      if (buf[i] !== 0xff) {
        i++;
        continue;
      }
      const marker = buf[i + 1];
      const len = buf.readUInt16BE(i + 2);
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
        return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7), format: 'jpeg' };
      }
      i += 2 + len;
    }
  }
  return null;
}

function svgDimensions(text: string): { width: number; height: number } | null {
  const vb = text.match(/viewBox="\s*[-\d.]+[\s,]+[-\d.]+[\s,]+([\d.]+)[\s,]+([\d.]+)"/i);
  const w = text.match(/<svg[^>]*\swidth="([\d.]+)/i);
  const h = text.match(/<svg[^>]*\sheight="([\d.]+)/i);
  if (w && h) return { width: Number(w[1]), height: Number(h[1]) };
  if (vb) return { width: Number(vb[1]), height: Number(vb[2]) };
  return null;
}

async function pdfText(buf: Buffer): Promise<{ text: string; pages: number } | null> {
  try {
    const { extractText, getDocumentProxy } = await import('unpdf');
    const doc = await getDocumentProxy(new Uint8Array(buf));
    const { totalPages, text } = await extractText(doc, { mergePages: true });
    return { text: String(text), pages: totalPages };
  } catch {
    return null;
  }
}

export async function analyzeFile(filePath: string, buf: Buffer): Promise<FileAnalysis> {
  const ext = path.extname(filePath).toLowerCase();
  const base = { path: filePath, bytes: buf.length, sha256: sha256(buf), notes: [] as string[] };
  const head = buf.subarray(0, 8).toString('latin1');
  if (head.startsWith('%PDF')) {
    const t = await pdfText(buf);
    return { ...base, kind: 'pdf', mime: 'application/pdf', pages: t?.pages, text_excerpt: t?.text.replace(/\s+/g, ' ').trim().slice(0, 4000), notes: t ? [] : ['PDF text could not be extracted (scanned or encrypted?)'] };
  }
  if (head.startsWith('PK\u0003\u0004')) {
    let entries: string[] = [];
    try {
      entries = Object.keys(unzipSync(new Uint8Array(buf), { filter: () => false }));
    } catch {
      /* listing only */
    }
    const kind: FileKind = /\.(docx|xlsx|pptx)$/i.test(filePath) ? 'document' : 'archive';
    return { ...base, kind, mime: kind === 'archive' ? 'application/zip' : 'application/vnd.openxmlformats', entries: entries.length, notes: [] };
  }
  const dims = imageDimensions(buf);
  if (dims) {
    const notes: string[] = [];
    if (dims.width < 400 && dims.height < 400) notes.push('small raster image (icon/thumbnail size)');
    return { ...base, kind: 'image', mime: `image/${dims.format}`, dimensions: { width: dims.width, height: dims.height, aspect: Number((dims.width / Math.max(1, dims.height)).toFixed(3)) }, notes };
  }
  if (['.woff', '.woff2', '.ttf', '.otf'].includes(ext)) return { ...base, kind: 'font', mime: `font/${ext.slice(1)}`, notes: [] };
  const text = buf.toString('utf8');
  if (ext === '.svg' || /^\s*(<\?xml[^>]*>\s*)?<svg\b/i.test(text)) {
    const d = svgDimensions(text);
    return { ...base, kind: 'svg', mime: 'image/svg+xml', dimensions: d ? { ...d, aspect: Number((d.width / Math.max(1, d.height)).toFixed(3)) } : null, notes: /<script/i.test(text) ? ['SVG contains script (unsafe to inline)'] : [] };
  }
  const mapped = TEXT_EXT[ext];
  const printable = text.length > 0 && !/[\u0000-\u0008\u000e-\u001f]/.test(text.slice(0, 2000));
  if (mapped || printable) {
    const [kind, language] = mapped ?? ['text', 'text'];
    return { ...base, kind, mime: 'text/plain', lines: text.split('\n').length, language, text_excerpt: text.slice(0, 4000), notes: [] };
  }
  return { ...base, kind: 'unknown', mime: 'application/octet-stream', notes: ['unrecognised binary format'] };
}

export const MAX_ZIP_ENTRIES = 2_000;
export const MAX_ZIP_BYTES = 80 * 1024 * 1024;

/** Safe ZIP extraction: path traversal, entry-count and decompressed-size (zip bomb) limits. */
export function extractZip(buf: Buffer): Array<{ path: string; data: Buffer }> {
  let total = 0;
  let count = 0;
  const files = unzipSync(new Uint8Array(buf), {
    filter: (f) => {
      count++;
      total += f.originalSize;
      if (count > MAX_ZIP_ENTRIES) throw new Error(`archive has more than ${MAX_ZIP_ENTRIES} entries`);
      if (total > MAX_ZIP_BYTES) throw new Error('archive expands beyond the size limit');
      return !f.name.endsWith('/') && !/(^|\/)(__MACOSX|\.git|node_modules)\//.test(f.name);
    },
  });
  return Object.entries(files)
    .map(([p, data]) => ({ path: path.posix.normalize(p.replace(/\\/g, '/')).replace(/^\/+/, ''), data: Buffer.from(data) }))
    .filter((f) => !f.path.startsWith('..') && /^[A-Za-z0-9._\-/ ]+$/.test(f.path));
}

// ------------------------------------------------------- PROJECT ANALYZER
export interface ProjectAnalysis {
  framework: string;
  build_tool: string | null;
  styling: string[];
  pages: string[];
  entry_points: string[];
  scripts: Record<string, string>;
  dependencies: string[];
  counts: Record<string, number>;
  total_bytes: number;
  issues: string[];
}

export function analyzeProject(files: Record<string, Buffer>): ProjectAnalysis {
  const names = Object.keys(files);
  const pkgPath = names.filter((n) => n.endsWith('package.json')).sort((a, b) => a.length - b.length)[0];
  let pkg: any = null;
  try {
    pkg = pkgPath ? JSON.parse(files[pkgPath].toString('utf8')) : null;
  } catch {
    /* invalid package.json reported below */
  }
  const deps = { ...(pkg?.dependencies ?? {}), ...(pkg?.devDependencies ?? {}) };
  const has = (d: string) => d in deps;
  const framework = has('next') ? 'Next.js' : has('nuxt') ? 'Nuxt' : has('astro') ? 'Astro' : has('@sveltejs/kit') ? 'SvelteKit' : has('gatsby') ? 'Gatsby' : has('react') ? 'React' : has('vue') ? 'Vue' : has('svelte') ? 'Svelte' : names.some((n) => n.endsWith('.php')) ? 'PHP' : names.some((n) => /\.html?$/.test(n)) ? 'Static HTML' : 'Unknown';
  const buildTool = has('vite') ? 'Vite' : has('webpack') ? 'webpack' : has('parcel') ? 'Parcel' : pkg?.scripts?.build ? 'npm script' : null;
  const styling = [has('tailwindcss') && 'Tailwind', has('sass') && 'Sass', has('styled-components') && 'styled-components', names.some((n) => n.endsWith('.css')) && 'CSS'].filter(Boolean) as string[];
  const pages = names.filter((n) => /\.html?$/.test(n) || /(^|\/)(pages|app|routes)\/.+\.(jsx?|tsx?|vue|svelte|astro|mdx?)$/.test(n)).slice(0, 200);
  const counts: Record<string, number> = {};
  for (const n of names) {
    const e = path.extname(n).toLowerCase() || '(none)';
    counts[e] = (counts[e] ?? 0) + 1;
  }
  const total = Object.values(files).reduce((s, b) => s + b.length, 0);
  const issues: string[] = [];
  if (pkgPath && !pkg) issues.push('package.json is not valid JSON');
  if (!names.some((n) => /(^|\/)index\.html?$/.test(n)) && framework === 'Static HTML') issues.push('no index.html');
  for (const [n, b] of Object.entries(files)) if (/\.(png|jpe?g|webp|gif)$/i.test(n) && b.length > 800_000) issues.push(`large image ${n} (${Math.round(b.length / 1024)}KB)`);
  if (names.some((n) => /\.env($|\.)/.test(path.basename(n)))) issues.push('an .env file is present in the project files (possible secret exposure)');
  return {
    framework,
    build_tool: buildTool,
    styling,
    pages,
    entry_points: names.filter((n) => /(^|\/)(index\.html?|main\.[jt]sx?|src\/main\.[jt]sx?|src\/index\.[jt]sx?|app\/layout\.[jt]sx?)$/.test(n)),
    scripts: pkg?.scripts ?? {},
    dependencies: Object.keys(deps).slice(0, 80),
    counts,
    total_bytes: total,
    issues,
  };
}

// ------------------------------------------------------ ASSET INTELLIGENCE
export type AssetRole = 'logo' | 'icon' | 'photo' | 'background' | 'illustration' | 'font' | 'document' | 'screenshot' | 'other';

export interface AssetEntry {
  path: string;
  role: AssetRole;
  target: string;
  analysis: FileAnalysis;
}

export function classifyAsset(a: FileAnalysis): AssetRole {
  const n = a.path.toLowerCase();
  if (a.kind === 'font') return 'font';
  if (a.kind === 'pdf' || a.kind === 'document') return 'document';
  if (/logo|brandmark|wordmark/.test(n)) return 'logo';
  if (/screenshot|screen[-_ ]shot|capture/.test(n)) return 'screenshot';
  if (/icon|favicon|sprite/.test(n) || (a.dimensions && a.dimensions.width <= 128 && a.dimensions.height <= 128)) return 'icon';
  if (/bg|background|hero|banner/.test(n)) return 'background';
  if (a.kind === 'svg') return 'illustration';
  if (a.kind === 'image') return 'photo';
  return 'other';
}

export function organizeAssets(analyses: FileAnalysis[]): AssetEntry[] {
  const folder: Record<AssetRole, string> = { logo: 'assets/logos', icon: 'assets/icons', photo: 'assets/photos', background: 'assets/backgrounds', illustration: 'assets/illustrations', font: 'assets/fonts', document: 'docs/client', screenshot: 'docs/references', other: 'assets/misc' };
  return analyses
    .filter((a) => ['image', 'svg', 'font', 'pdf', 'document'].includes(a.kind))
    .map((a) => {
      const role = classifyAsset(a);
      return { path: a.path, role, target: `${folder[role]}/${path.posix.basename(a.path).toLowerCase().replace(/[^a-z0-9._-]+/g, '-')}`, analysis: a };
    });
}

export interface AssetIssue {
  path: string;
  issue: 'low_resolution' | 'wrong_aspect_ratio' | 'duplicate' | 'oversized' | 'irrelevant' | 'missing' | 'unsafe';
  detail: string;
  recommendation: string;
}

export function checkAssetQuality(entries: AssetEntry[], referenced: string[] = []): AssetIssue[] {
  const issues: AssetIssue[] = [];
  const byHash = new Map<string, string>();
  for (const e of entries) {
    const a = e.analysis;
    const d = a.dimensions;
    const prior = byHash.get(a.sha256);
    if (prior) issues.push({ path: a.path, issue: 'duplicate', detail: `identical to ${prior}`, recommendation: 'Keep one copy and reference it everywhere.' });
    else byHash.set(a.sha256, a.path);
    if (a.kind === 'image' && d) {
      if ((e.role === 'photo' || e.role === 'background') && d.width < 1200) issues.push({ path: a.path, issue: 'low_resolution', detail: `${d.width}x${d.height}px`, recommendation: 'Supply at least 1600px wide for full-width photography (2x for retina).' });
      if (e.role === 'logo' && Math.max(d.width, d.height) < 300) issues.push({ path: a.path, issue: 'low_resolution', detail: `${d.width}x${d.height}px raster logo`, recommendation: 'Request an SVG or a raster logo at least 600px wide.' });
      if (e.role === 'background' && d.aspect < 1.2) issues.push({ path: a.path, issue: 'wrong_aspect_ratio', detail: `aspect ${d.aspect}`, recommendation: 'Hero/background images should be landscape (about 16:9 or wider).' });
      if (e.role === 'icon' && Math.abs(d.aspect - 1) > 0.2) issues.push({ path: a.path, issue: 'wrong_aspect_ratio', detail: `aspect ${d.aspect}`, recommendation: 'Icons should be square.' });
      if (d.width <= 2 && d.height <= 2) issues.push({ path: a.path, issue: 'irrelevant', detail: 'tracking-pixel sized image', recommendation: 'Discard.' });
    }
    if (a.kind === 'image' && a.bytes > 1_500_000) issues.push({ path: a.path, issue: 'oversized', detail: `${Math.round(a.bytes / 1024)}KB`, recommendation: 'Compress/convert to WebP/AVIF under ~300KB.' });
    if (a.kind === 'svg' && a.notes.some((n) => n.includes('script'))) issues.push({ path: a.path, issue: 'unsafe', detail: 'SVG with embedded script', recommendation: 'Sanitise before use.' });
  }
  const have = new Set(entries.map((e) => path.posix.basename(e.path).toLowerCase()));
  for (const ref of referenced) if (!have.has(path.posix.basename(ref).toLowerCase())) issues.push({ path: ref, issue: 'missing', detail: 'referenced but not supplied', recommendation: 'Request the asset from the client or replace with a marked placeholder.' });
  return issues;
}
