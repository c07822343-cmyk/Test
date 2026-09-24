// Tool catalog + permission model. Every tool declares the permission it
// needs; every agent has a tool profile granting a set of permissions. A tool
// only runs for an agent whose profile grants its permission - requesting a
// tool through a skill does not bypass this.

export type Permission =
  | 'web_fetch'
  | 'web_search'
  | 'site_audit'
  | 'browser'
  | 'image_analysis'
  | 'file_read'
  | 'asset_tools'
  | 'git_read'
  | 'security_scan'
  | 'site_write'
  | 'docs_write'
  | 'orchestrate';

export interface ToolInfo {
  name: string;
  permission: Permission;
  description: string;
}

export const TOOLS: ToolInfo[] = [
  { name: 'site_snapshot', permission: 'web_fetch', description: 'Fetch the client\'s existing site pages (untrusted, injection-screened) and list client files.' },
  { name: 'web_fetch_sources', permission: 'web_fetch', description: 'Fetch supplied reference URLs as untrusted, injection-screened source material.' },
  { name: 'web_research', permission: 'web_search', description: 'Search the web via the configured search provider, fetch top results, record each source (URL, retrieval time, type) for claim provenance.' },
  { name: 'static_site_audit', permission: 'site_audit', description: 'Structural audit of site files: titles, landmarks, headings, alt text, labels, links, assets, render-blocking scripts.' },
  { name: 'seo_audit', permission: 'site_audit', description: 'Technical SEO audit: titles, descriptions, canonical, Open Graph, JSON-LD validity, sitemap/robots, duplicate titles.' },
  { name: 'anti_slop_scan', permission: 'site_audit', description: 'Detect generic AI patterns: filler phrases, unsupported claims, fabricated testimonials, gradient/glass/animation overuse, type-scale sprawl.' },
  { name: 'responsive_render', permission: 'browser', description: 'Render in Chromium at 360/768/1440px; measure overflow, tap targets and small text.' },
  { name: 'accessibility_axe', permission: 'browser', description: 'Run axe-core WCAG 2.2 AA audit in Chromium.' },
  { name: 'performance_probe', permission: 'browser', description: 'Measure LCP, CLS, bytes and render-blocking resources on emulated mid-range mobile.' },
  { name: 'visual_screenshots', permission: 'image_analysis', description: 'Capture mobile/desktop screenshots for vision-model analysis.' },
  { name: 'visual_qa', permission: 'browser', description: 'Visual QA: render desktop/tablet/mobile, capture full screenshots, check nav, hero, CTAs, cards, forms, footer, overflow, overlap, broken images, animations/3D; compare against the previous QA run.' },
  { name: 'bug_scan', permission: 'browser', description: 'Find runtime bugs: console errors, uncaught exceptions, failed requests, broken images/anchors, nav toggle and form smoke tests.' },
  { name: 'file_analyzer', permission: 'file_read', description: 'Identify and summarise supplied files (PDF text, image dimensions, archives, code, fonts, documents).' },
  { name: 'project_analyzer', permission: 'file_read', description: 'Understand an entire website codebase: framework, pages, assets, build scripts, structure problems.' },
  { name: 'asset_organizer', permission: 'asset_tools', description: 'Classify images, icons, logos, fonts and documents and propose an organised asset structure.' },
  { name: 'asset_quality', permission: 'asset_tools', description: 'Detect wrong aspect ratios, low resolution, duplicates, oversized/irrelevant files and missing referenced assets.' },
  { name: 'repo_inspect', permission: 'git_read', description: 'Inspect the project repository: history, snapshots, structure and uncommitted changes.' },
  { name: 'change_diff', permission: 'git_read', description: 'Unified diff between the latest snapshot and the previous stable snapshot, for change review.' },
  { name: 'security_screen', permission: 'security_scan', description: 'Screen external inputs (fetched pages, client files, client text) for prompt injection, secret exposure, command execution and priority/permission manipulation.' },
];

export const TOOL_NAMES = TOOLS.map((t) => t.name);

export const PERMISSIONS: Permission[] = ['web_fetch', 'web_search', 'site_audit', 'browser', 'image_analysis', 'file_read', 'asset_tools', 'git_read', 'security_scan', 'site_write', 'docs_write', 'orchestrate'];

/** Adds an extension tool to the catalog. It must declare an existing permission, so profiles still decide who may run it. */
export function registerTool(info: ToolInfo): void {
  if (!/^[a-z][a-z0-9_]{2,40}$/.test(info.name)) throw new Error(`invalid tool name ${info.name}`);
  if (TOOL_NAMES.includes(info.name)) throw new Error(`tool ${info.name} already exists`);
  if (!PERMISSIONS.includes(info.permission)) throw new Error(`tool ${info.name} declares unknown permission ${info.permission}`);
  TOOLS.push(info);
  TOOL_NAMES.push(info.name);
}

export function toolInfo(name: string): ToolInfo | undefined {
  return TOOLS.find((t) => t.name === name);
}

export const TOOL_PROFILES: Record<string, Permission[]> = {
  main: ['orchestrate', 'file_read', 'site_audit', 'git_read', 'security_scan'],
  research: ['web_fetch', 'web_search', 'file_read', 'security_scan'],
  developer: ['site_write', 'file_read', 'site_audit', 'browser', 'git_read', 'asset_tools'],
  design: ['image_analysis', 'browser', 'site_audit', 'file_read', 'asset_tools'],
  seo: ['web_fetch', 'site_audit', 'file_read'],
  content: ['file_read', 'site_audit', 'docs_write'],
  qa: ['browser', 'image_analysis', 'site_audit', 'file_read', 'git_read'],
  operations: ['web_fetch', 'file_read', 'git_read', 'docs_write', 'security_scan'],
  files: ['file_read', 'asset_tools', 'security_scan'],
};

export function allowed(profile: string, tool: string): boolean {
  const info = toolInfo(tool);
  if (!info) return false;
  return (TOOL_PROFILES[profile] ?? []).includes(info.permission);
}

export function profilePermissions(profile: string): Permission[] {
  return TOOL_PROFILES[profile] ?? [];
}
