// Tool runner. Runs an agent's tools (its own + those required by its loaded
// skills) subject to its permission profile, records results in task memory,
// screens all external content, and records research sources for provenance.
import type { AgentDefinition, ToolName } from '../agents/types.ts';
import { CacheStore, TTL } from '../cache/cache.ts';
import type { AppConfig } from '../config/env.ts';
import type { Db } from '../db/pool.ts';
import type { ProjectRepos } from '../devops/git.ts';
import { analyzeFile, analyzeProject, checkAssetQuality, organizeAssets, type FileAnalysis } from '../files/intelligence.ts';
import type { ArtifactStore } from '../memory/artifacts.ts';
import type { MemoryStore } from '../memory/memory.ts';
import type { TaskRow } from '../queue/types.ts';
import { recordSource } from '../research/provenance.ts';
import { classifySource, type SearchProvider } from '../research/search.ts';
import { recordScreen, screenText } from '../security/screen.ts';
import { wrapUntrusted } from '../security/untrusted.ts';
import { logger } from '../util/log.ts';
import { accessibilityAxe, performanceProbe, responsiveRender } from './browserChecks.ts';
import { allowed, toolInfo } from './catalog.ts';
import { antiSlopScan, seoAudit, staticAudit, type Finding } from './siteAudit.ts';
import { bugScan, visualQa } from './visualQa.ts';
import { fetchPage, type FetchedPage } from './webFetch.ts';

const log = logger('tools');

export interface ToolResult {
  tool: ToolName;
  ok: boolean;
  available: boolean;
  summary: unknown;
  findings: Finding[];
  hard_failures: Finding[];
  untrusted_blocks?: string[];
  injection_flags?: string[];
  images?: Array<{ label: string; artifact_path: string }>;
  error?: string;
  requested_by?: string;
}

export interface ToolDeps {
  config: AppConfig;
  db: Db;
  artifacts: ArtifactStore;
  memory: MemoryStore;
  cache: CacheStore;
  search: SearchProvider;
  repos: ProjectRepos;
  fetchImpl?: typeof fetch;
  onEvent?: (type: string, detail: Record<string, unknown>) => Promise<void>;
}

export async function projectFacts(memory: MemoryStore, projectId: string): Promise<string[]> {
  return ((await memory.get<string[]>('project', projectId, 'facts')) ?? []).map(String);
}

async function brief(task: TaskRow, memory: MemoryStore): Promise<any> {
  return (await memory.get<any>('project', task.project_id, 'brief')) ?? {};
}

async function collectUrls(task: TaskRow, memory: MemoryStore): Promise<string[]> {
  const b = await brief(task, memory);
  const urls = new Set<string>();
  for (const u of [...(task.inputs?.urls ?? []), ...(b.urls ?? []), b.existing_url].filter(Boolean)) {
    if (typeof u === 'string' && /^https?:\/\//i.test(u)) urls.add(u);
  }
  return [...urls].slice(0, 6);
}

function domainOf(url: string | null | undefined): string | null {
  try {
    return url ? new URL(url).hostname.replace(/^www\./, '') : null;
  } catch {
    return null;
  }
}

/** Fetch (cached), screen, record as a research source, and wrap as untrusted content. */
async function ingestPage(url: string, task: TaskRow, deps: ToolDeps, businessDomain: string | null): Promise<{ block: string; flags: string[]; sourceId: string; title: string } | { error: string }> {
  const key = deps.cache.key('web_page', 'global', 'public', url);
  let page = (await deps.cache.get<FetchedPage>(key))?.result ?? null;
  const cached = !!page;
  if (!page) {
    try {
      page = await fetchPage(url, { timeoutMs: deps.config.research.fetchTimeoutMs, maxBytes: deps.config.research.maxFetchBytes, fetchImpl: deps.fetchImpl });
      await deps.cache.set({ key, scope: 'global', scopeId: 'public', kind: 'web_page', query: url, result: page, sources: [{ url: page.finalUrl, retrieved_at: new Date().toISOString() }], ttlMs: TTL.webPage });
    } catch (err) {
      return { error: (err as Error).message };
    }
  } else {
    await deps.db.query(`INSERT INTO usage_savings (project_id, task_id, kind, detail) VALUES ($1, $2, 'cache_hit:web_page', $3)`, [task.project_id, task.id, JSON.stringify({ url })]);
  }
  const body = [`TITLE: ${page.title}`, `DESCRIPTION: ${page.description}`, `HEADINGS:\n${page.headings.join('\n')}`, `TEXT:\n${page.text}`].join('\n');
  const screen = screenText(body, page.finalUrl);
  await recordScreen(deps.db, screen, { projectId: task.project_id, taskId: task.id, kind: 'web_page' });
  const source = await recordSource(deps.db, { projectId: task.project_id, taskId: task.id, url, finalUrl: page.finalUrl, title: page.title, sourceType: classifySource(page.finalUrl, businessDomain), text: screen.sanitized, flags: screen.flags });
  const w = wrapUntrusted(`${page.finalUrl}" source_id="${source.id}" type="${source.source_type}" retrieved_at="${new Date(source.retrieved_at).toISOString()}${cached ? '" cached="true' : ''}`, screen.sanitized);
  return { block: w.block, flags: [...new Set([...w.flags, ...screen.flags])], sourceId: source.id, title: page.title };
}

async function clientFiles(task: TaskRow, deps: ToolDeps): Promise<Record<string, Buffer>> {
  const out: Record<string, Buffer> = {};
  for (const a of await deps.artifacts.latest(task.project_id, 'client/')) out[a.path.slice('client/'.length)] = a.content;
  return out;
}

async function analyzeClientFiles(task: TaskRow, deps: ToolDeps): Promise<FileAnalysis[]> {
  const files = await clientFiles(task, deps);
  const out: FileAnalysis[] = [];
  for (const [p, buf] of Object.entries(files)) {
    const a = await analyzeFile(p, buf);
    if (a.text_excerpt) {
      const screen = screenText(a.text_excerpt, `client file ${p}`);
      await recordScreen(deps.db, screen, { projectId: task.project_id, taskId: task.id, kind: 'client_file' });
      a.text_excerpt = screen.sanitized;
      if (screen.flags.length) a.notes.push(`security screening flagged: ${screen.flags.join(', ')}`);
    }
    await deps.db.query(
      `INSERT INTO file_analyses (id, project_id, path, kind, analysis) VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (project_id, path) DO UPDATE SET kind = EXCLUDED.kind, analysis = EXCLUDED.analysis, created_at = now()`,
      [`fa_${a.sha256.slice(0, 16)}_${p.length}`, task.project_id, p, a.kind, JSON.stringify(a)],
    );
    out.push(a);
  }
  return out;
}

export async function runTool(tool: ToolName, task: TaskRow, deps: ToolDeps): Promise<ToolResult> {
  const site = await deps.artifacts.latestText(task.project_id, 'site/');
  const base = { tool, ok: true, available: true, findings: [] as Finding[], hard_failures: [] as Finding[] };
  const noSite = (): ToolResult => ({ ...base, ok: false, summary: 'no site files yet', error: 'no site files' });
  switch (tool) {
    case 'static_site_audit': {
      const r = staticAudit(site);
      return { ...base, summary: { pages: r.pages, broken_links: r.broken_links, missing_assets: r.missing_assets }, findings: r.findings, hard_failures: r.hard_failures };
    }
    case 'seo_audit': {
      const r = seoAudit(site);
      return { ...base, summary: { pages: r.pages, has_robots: r.has_robots, has_sitemap: r.has_sitemap, duplicate_titles: r.duplicate_titles }, findings: r.findings, hard_failures: r.hard_failures };
    }
    case 'anti_slop_scan': {
      const r = antiSlopScan(site, await projectFacts(deps.memory, task.project_id));
      const { findings, hard_failures, ...summary } = r;
      return { ...base, summary, findings, hard_failures };
    }
    case 'responsive_render':
    case 'visual_screenshots': {
      if (!Object.keys(site).length) return noSite();
      const r = await responsiveRender(site, { screenshots: tool === 'visual_screenshots' });
      if ('reason' in r) return { ...base, ok: false, available: false, summary: r.reason, error: r.reason };
      const images: ToolResult['images'] = [];
      for (const s of r.screenshots) {
        const artifactPath = `screenshots/${task.id}/${s.page.replace(/\.html?$/, '')}-${s.viewport}.png`;
        await deps.artifacts.save({ projectId: task.project_id, taskId: task.id, path: artifactPath, content: Buffer.from(s.png_base64, 'base64'), kind: 'screenshot', createdBy: `tool:${tool}` });
        images.push({ label: `${s.page} @ ${s.viewport}`, artifact_path: artifactPath });
      }
      return { ...base, summary: { results: r.results }, findings: r.findings, hard_failures: r.hard_failures, images };
    }
    case 'accessibility_axe': {
      if (!Object.keys(site).length) return noSite();
      const r = await accessibilityAxe(site);
      if ('reason' in r) return { ...base, ok: false, available: false, summary: r.reason, error: r.reason };
      return { ...base, summary: { pages: r.pages }, findings: r.findings, hard_failures: r.hard_failures };
    }
    case 'performance_probe': {
      if (!Object.keys(site).length) return noSite();
      const r = await performanceProbe(site);
      if ('reason' in r) return { ...base, ok: false, available: false, summary: r.reason, error: r.reason };
      return { ...base, summary: { pages: r.pages, total_site_bytes: r.total_site_bytes }, findings: r.findings, hard_failures: r.hard_failures };
    }
    case 'visual_qa': {
      if (!Object.keys(site).length) return noSite();
      // Passes are compared per reviewing agent so one reviewer's renders never become another's baseline.
      const memKey = `visual_qa:last:${task.agent_type}`;
      const last = await deps.memory.get<{ pass: number; issueKeys: string[]; score: number; shots: Record<string, string> }>('project', task.project_id, memKey);
      const prevShots = new Map<string, Buffer>();
      for (const [vp, p] of Object.entries(last?.shots ?? {})) {
        const a = await deps.artifacts.get(task.project_id, p);
        if (a) prevShots.set(vp, a.content);
      }
      const r = await visualQa(site, last ? { screenshots: prevShots, issueKeys: last.issueKeys, score: last.score } : undefined);
      if ('reason' in r) return { ...base, ok: false, available: false, summary: r.reason, error: r.reason };
      const pass = (last?.pass ?? 0) + 1;
      const shots: Record<string, string> = {};
      const images: ToolResult['images'] = [];
      for (const s of r.screenshots) {
        const p = `screenshots/visual-qa/${task.agent_type}/pass-${pass}/${s.viewport}.png`;
        await deps.artifacts.save({ projectId: task.project_id, taskId: task.id, path: p, content: s.png, kind: 'screenshot', createdBy: 'tool:visual_qa' });
        shots[s.viewport] = p;
        images.push({ label: `pass ${pass} @ ${s.viewport}`, artifact_path: p });
      }
      await deps.memory.set('project', task.project_id, memKey, { pass, issueKeys: r.issues.map((i) => i.key), score: r.score, shots }, 'tool:visual_qa');
      await deps.memory.append('project', task.project_id, `visual_qa:history:${task.agent_type}`, { pass, score: r.score, issues: r.issues.length, at: new Date().toISOString(), comparison: r.comparison }, 'tool:visual_qa', 20);
      return {
        ...base,
        summary: { pass, score: r.score, issues_by_region: r.issues.reduce((m: Record<string, number>, i) => ((m[i.region] = (m[i.region] ?? 0) + 1), m), {}), issues: r.issues.slice(0, 60), comparison: r.comparison },
        findings: r.findings,
        hard_failures: r.hard_failures,
        images: images.filter((i) => !i.label.includes('tablet')),
      };
    }
    case 'bug_scan': {
      if (!Object.keys(site).length) return noSite();
      const r = await bugScan(site);
      if ('reason' in r) return { ...base, ok: false, available: false, summary: r.reason, error: r.reason };
      const { findings, hard_failures, available, ...summary } = r;
      return { ...base, summary, findings, hard_failures };
    }
    case 'web_research': {
      const b = await brief(task, deps.memory);
      const loc = b.business?.location ?? '';
      const type = b.business?.type ?? '';
      const queries: string[] = task.inputs?.queries ?? [
        b.business?.name ? `${b.business.name} ${loc}`.trim() : null,
        type ? `${type} ${loc} services`.trim() : null,
        task.agent_type === 'competitive_research' && type ? `best ${type} ${loc}`.trim() : null,
      ].filter(Boolean);
      const blocks: string[] = [];
      const flags = new Set<string>();
      const fetched: Array<{ url: string; source_id?: string; title?: string; error?: string }> = [];
      const businessDomain = domainOf(b.existing_url);
      const urls = new Set(await collectUrls(task, deps.memory));
      const searched: Array<{ query: string; results: number }> = [];
      if (deps.search.configured && deps.config.research.allowWebFetch) {
        for (const q of queries.slice(0, 3)) {
          const key = deps.cache.key('search', 'global', 'public', `${deps.search.name}:${q}`);
          let results = (await deps.cache.get<any[]>(key))?.result ?? null;
          if (!results) {
            try {
              results = await deps.search.search(q, { limit: 6 });
              await deps.cache.set({ key, scope: 'global', scopeId: 'public', kind: 'search', query: q, result: results, ttlMs: TTL.search });
            } catch (err) {
              searched.push({ query: q, results: -1 });
              continue;
            }
          }
          searched.push({ query: q, results: results.length });
          for (const r of results.slice(0, 3)) urls.add(r.url);
        }
      }
      if (deps.config.research.allowWebFetch) {
        for (const url of [...urls].slice(0, 8)) {
          const r = await ingestPage(url, task, deps, businessDomain);
          if ('error' in r) fetched.push({ url, error: r.error });
          else {
            blocks.push(r.block);
            r.flags.forEach((f) => flags.add(f));
            fetched.push({ url, source_id: r.sourceId, title: r.title });
          }
        }
      }
      const note = !deps.search.configured ? 'No search provider configured (set SEARXNG_URL or BRAVE_API_KEY); only supplied URLs were fetched.' : undefined;
      return { ...base, summary: { provider: deps.search.name, searched, fetched, note: urls.size === 0 && !deps.search.configured ? `${note} No URLs were supplied, so no external facts are available: classify claims as INFERENCE or UNVERIFIED.` : note }, untrusted_blocks: blocks, injection_flags: [...flags] };
    }
    case 'web_fetch_sources':
    case 'site_snapshot': {
      const urls = await collectUrls(task, deps.memory);
      const blocks: string[] = [];
      const flags = new Set<string>();
      const fetched: Array<{ url: string; source_id?: string; title?: string; error?: string }> = [];
      if (!deps.config.research.allowWebFetch) return { ...base, summary: { note: 'web fetching disabled by configuration', urls }, untrusted_blocks: [] };
      const b = await brief(task, deps.memory);
      for (const url of urls) {
        const r = await ingestPage(url, task, deps, domainOf(b.existing_url));
        if ('error' in r) fetched.push({ url, error: r.error });
        else {
          blocks.push(r.block);
          r.flags.forEach((f) => flags.add(f));
          fetched.push({ url, source_id: r.sourceId, title: r.title });
        }
      }
      const clientList = tool === 'site_snapshot' ? Object.keys(await clientFiles(task, deps)) : [];
      return { ...base, summary: { fetched, client_files: clientList, note: urls.length ? undefined : 'No URLs supplied; no external sources fetched.' }, untrusted_blocks: blocks, injection_flags: [...flags] };
    }
    case 'security_screen': {
      const results: Array<{ source: string; verdict: string; flags: string[] }> = [];
      const project = await deps.db.query('SELECT request FROM projects WHERE id = $1', [task.project_id]);
      const inputs: Array<[string, string]> = [['client request', project.rows[0]?.request ?? '']];
      for (const [p, buf] of Object.entries(await clientFiles(task, deps))) {
        const a = await analyzeFile(p, buf);
        if (a.text_excerpt) inputs.push([`client file ${p}`, a.text_excerpt]);
      }
      const { rows: sources } = await deps.db.query('SELECT final_url, excerpt FROM research_sources WHERE project_id = $1', [task.project_id]);
      for (const s of sources) inputs.push([s.final_url, s.excerpt ?? '']);
      const findings: Finding[] = [];
      for (const [src, text] of inputs) {
        const r = screenText(text, src);
        await recordScreen(deps.db, r, { projectId: task.project_id, taskId: task.id, kind: 'screen' });
        results.push({ source: src, verdict: r.verdict, flags: r.flags });
        for (const f of r.findings) findings.push({ severity: r.verdict === 'hostile' ? 'critical' : 'major', rule: `security:${f.kind}`, page: src, detail: f.excerpt });
      }
      return { ...base, summary: { screened: results.length, results }, findings, hard_failures: [] };
    }
    case 'file_analyzer': {
      const analyses = await analyzeClientFiles(task, deps);
      return { ...base, summary: { files: analyses.map((a) => ({ path: a.path, kind: a.kind, bytes: a.bytes, dimensions: a.dimensions, pages: a.pages, lines: a.lines, entries: a.entries, notes: a.notes, text_excerpt: a.text_excerpt?.slice(0, 1500) })), note: analyses.length ? undefined : 'No client files supplied.' } };
    }
    case 'project_analyzer': {
      const files = await clientFiles(task, deps);
      const useSite = Object.keys(files).length === 0;
      const input = useSite ? Object.fromEntries(Object.entries(site).map(([p, c]) => [p, Buffer.from(c)])) : files;
      const r = analyzeProject(input);
      return { ...base, summary: { analysed: useSite ? 'current site files' : 'client files', ...r }, findings: r.issues.map((i) => ({ severity: 'minor', rule: 'project_structure', page: null, detail: i })) };
    }
    case 'asset_organizer':
    case 'asset_quality': {
      const analyses = await analyzeClientFiles(task, deps);
      const entries = organizeAssets(analyses);
      if (tool === 'asset_organizer') return { ...base, summary: { assets: entries.map((e) => ({ path: e.path, role: e.role, target: e.target, dimensions: e.analysis.dimensions })) } };
      const refs = [...new Set(Object.entries(site).flatMap(([f, c]) => (f.endsWith('.html') ? [...c.matchAll(/(?:src|href)="(?!https?:|data:|#|mailto:|tel:)([^"]+\.(?:png|jpe?g|webp|svg|gif))"/gi)].map((m) => m[1]) : [])))];
      const missingRefs = refs.filter((r) => !(r in site) && !(r.replace(/^\.?\//, '') in site));
      const issues = checkAssetQuality(entries, missingRefs);
      return { ...base, summary: { checked: entries.length, issues }, findings: issues.map((i) => ({ severity: i.issue === 'missing' || i.issue === 'unsafe' ? 'major' : 'minor', rule: `asset:${i.issue}`, page: i.path, detail: `${i.detail} — ${i.recommendation}` })) };
    }
    case 'repo_inspect': {
      const [history, snapshots] = await Promise.all([deps.repos.history(task.project_id, 30), deps.repos.list(task.project_id)]);
      return { ...base, summary: { commits: history, snapshots: snapshots.slice(0, 20).map((s) => ({ id: s.id, label: s.label, commit: s.commit_sha, stable: s.stable, files: Object.keys(s.files).length, at: s.created_at })), current_files: Object.keys(site) } };
    }
    case 'change_diff': {
      const d = await deps.repos.diff(task.project_id);
      return { ...base, summary: { from: d.from, to: d.to, changed: d.changed, diff: d.diff.slice(0, 60_000) } };
    }
    default:
      return { ...base, ok: false, available: false, summary: `unknown tool ${tool}`, error: `unknown tool ${tool}` };
  }
}

/** Tools for this task: the agent's own plus those its loaded skills require, filtered by permission. */
export function plannedTools(agent: AgentDefinition, skillTools: string[]): { run: string[]; denied: string[] } {
  const wanted = [...new Set([...(agent.tools ?? []), ...skillTools])];
  return { run: wanted.filter((t) => allowed(agent.toolProfile, t)), denied: wanted.filter((t) => !allowed(agent.toolProfile, t)) };
}

export async function runAgentTools(agent: AgentDefinition, task: TaskRow, deps: ToolDeps, skillTools: string[] = []): Promise<ToolResult[]> {
  const results: ToolResult[] = [];
  const { run, denied } = plannedTools(agent, skillTools);
  for (const tool of denied) {
    // Permission model: a skill cannot widen what an agent may do.
    await deps.db.query(
      `INSERT INTO security_events (project_id, task_id, source, kind, flags, excerpt, action) VALUES ($1, $2, $3, 'permission_denied', $4, $5, 'tool_not_run')`,
      [task.project_id, task.id, `agent:${agent.type}`, [toolInfo(tool)?.permission ?? 'unknown'], `profile ${agent.toolProfile} lacks ${toolInfo(tool)?.permission} for ${tool}`],
    );
  }
  for (const tool of run) {
    const started = Date.now();
    await deps.onEvent?.('tool_started', { tool });
    let r: ToolResult;
    try {
      r = await runTool(tool, task, deps);
    } catch (err) {
      r = { tool, ok: false, available: true, summary: null, findings: [], hard_failures: [], error: (err as Error).message };
    }
    r.requested_by = (agent.tools ?? []).includes(tool) ? 'agent' : 'skill';
    log.info('tool finished', { task: task.id, tool, ok: r.ok, available: r.available, findings: r.findings.length, ms: Date.now() - started });
    await deps.onEvent?.('tool_finished', { tool, ok: r.ok, available: r.available, findings: r.findings.length, hard_failures: r.hard_failures.length, ms: Date.now() - started });
    results.push(r);
  }
  await deps.memory.set('task', task.id, 'tool_results', results, 'tools');
  return results;
}
