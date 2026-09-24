// Runs an agent's declared pre-execution tools and records the results in
// task memory. The prompt builder then injects compact summaries (and, for
// vision agents, screenshots) as evidence.
import type { AgentDefinition, ToolName } from '../agents/types.ts';
import type { AppConfig } from '../config/env.ts';
import type { ArtifactStore } from '../memory/artifacts.ts';
import type { MemoryStore } from '../memory/memory.ts';
import type { TaskRow } from '../queue/types.ts';
import { wrapUntrusted } from '../security/untrusted.ts';
import { logger } from '../util/log.ts';
import { accessibilityAxe, performanceProbe, responsiveRender } from './browserChecks.ts';
import { antiSlopScan, seoAudit, staticAudit, type Finding } from './siteAudit.ts';
import { fetchPage } from './webFetch.ts';

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
}

export interface ToolDeps {
  config: AppConfig;
  artifacts: ArtifactStore;
  memory: MemoryStore;
  fetchImpl?: typeof fetch;
}

export async function projectFacts(memory: MemoryStore, projectId: string): Promise<string[]> {
  return ((await memory.get<string[]>('project', projectId, 'facts')) ?? []).map(String);
}

async function collectUrls(task: TaskRow, memory: MemoryStore): Promise<string[]> {
  const brief = (await memory.get<any>('project', task.project_id, 'brief')) ?? {};
  const urls = new Set<string>();
  for (const u of [...(task.inputs?.urls ?? []), ...(brief.urls ?? []), brief.existing_url].filter(Boolean)) {
    if (typeof u === 'string' && /^https?:\/\//i.test(u)) urls.add(u);
  }
  return [...urls].slice(0, 6);
}

export async function runTool(tool: ToolName, task: TaskRow, deps: ToolDeps): Promise<ToolResult> {
  const site = await deps.artifacts.latestText(task.project_id, 'site/');
  const base = { tool, ok: true, available: true, findings: [] as Finding[], hard_failures: [] as Finding[] };
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
      if (Object.keys(site).length === 0) return { ...base, ok: false, summary: 'no site files yet', error: 'no site files' };
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
      if (Object.keys(site).length === 0) return { ...base, ok: false, summary: 'no site files yet', error: 'no site files' };
      const r = await accessibilityAxe(site);
      if ('reason' in r) return { ...base, ok: false, available: false, summary: r.reason, error: r.reason };
      return { ...base, summary: { pages: r.pages }, findings: r.findings, hard_failures: r.hard_failures };
    }
    case 'performance_probe': {
      if (Object.keys(site).length === 0) return { ...base, ok: false, summary: 'no site files yet', error: 'no site files' };
      const r = await performanceProbe(site);
      if ('reason' in r) return { ...base, ok: false, available: false, summary: r.reason, error: r.reason };
      return { ...base, summary: { pages: r.pages, total_site_bytes: r.total_site_bytes }, findings: r.findings, hard_failures: r.hard_failures };
    }
    case 'web_fetch_sources':
    case 'site_snapshot': {
      const urls = await collectUrls(task, deps.memory);
      const blocks: string[] = [];
      const flags = new Set<string>();
      const fetched: Array<{ url: string; status: number | null; title?: string; error?: string }> = [];
      if (!deps.config.research.allowWebFetch) return { ...base, ok: true, summary: { note: 'web fetching disabled by configuration', urls }, untrusted_blocks: [] };
      for (const url of urls) {
        try {
          const page = await fetchPage(url, { timeoutMs: deps.config.research.fetchTimeoutMs, maxBytes: deps.config.research.maxFetchBytes, fetchImpl: deps.fetchImpl });
          const body = [`TITLE: ${page.title}`, `DESCRIPTION: ${page.description}`, `HEADINGS:\n${page.headings.join('\n')}`, `TEXT:\n${page.text}`].join('\n');
          const w = wrapUntrusted(page.finalUrl, body);
          w.flags.forEach((f) => flags.add(f));
          blocks.push(w.block);
          fetched.push({ url, status: page.status, title: page.title });
        } catch (err) {
          fetched.push({ url, status: null, error: (err as Error).message });
        }
      }
      const clientFiles = tool === 'site_snapshot' ? Object.keys(await deps.artifacts.latestText(task.project_id, 'client/')) : [];
      return { ...base, summary: { fetched, client_files: clientFiles, note: urls.length ? undefined : 'No URLs supplied; no external sources fetched.' }, untrusted_blocks: blocks, injection_flags: [...flags] };
    }
    default:
      return { ...base, ok: false, available: false, summary: `unknown tool ${tool}`, error: `unknown tool ${tool}` };
  }
}

export async function runAgentTools(agent: AgentDefinition, task: TaskRow, deps: ToolDeps): Promise<ToolResult[]> {
  const results: ToolResult[] = [];
  for (const tool of agent.tools ?? []) {
    const started = Date.now();
    let r: ToolResult;
    try {
      r = await runTool(tool, task, deps);
    } catch (err) {
      r = { tool, ok: false, available: true, summary: null, findings: [], hard_failures: [], error: (err as Error).message };
    }
    log.info('tool finished', { task: task.id, tool, ok: r.ok, available: r.available, findings: r.findings.length, ms: Date.now() - started });
    results.push(r);
  }
  await deps.memory.set('task', task.id, 'tool_results', results, 'tools');
  return results;
}
