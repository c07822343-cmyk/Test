// ApexWeb operating workflows expressed as dependency graphs. They are the
// Task Decomposer's starting point, not a fixed sequence: the Main Agent's
// planner adapts them to the request (adding/removing/re-scoping tasks), and
// the queue runs every task as soon as its own inputs are ready.

export type Intent =
  | 'new_website'
  | 'website_improvement'
  | 'new_demo'
  | 'seo_audit'
  | 'research_only'
  | 'content_only'
  | 'proposal';

export interface PlanTask {
  key: string;
  agent_type: string;
  title: string;
  mission: string;
  depends_on: string[];
  priority: number;
  optional?: boolean;
  /** Review gate: this task reviews `review_of` and may send it back for revision. */
  review_of?: string | null;
  /** QA gate: rejection starts a bounded fix cycle. */
  qa_gate?: boolean;
}

export interface WorkflowTemplate {
  intent: Intent;
  label: string;
  tasks: PlanTask[];
  /** Keys the planner may never drop. */
  required: string[];
}

const t = (key: string, agent_type: string, title: string, mission: string, depends_on: string[], priority: number, extra: Partial<PlanTask> = {}): PlanTask => ({
  key, agent_type, title, mission, depends_on, priority, ...extra,
});

/** Shared build → review → verification → QA → handoff tail used by site-producing workflows. */
function buildAndVerify(buildDeps: string[], opts: { improvement: boolean }): PlanTask[] {
  const buildMission = opts.improvement
    ? 'Improve the existing implementation (current site files are provided) according to the improvement architecture, design system and approved copy. Preserve valuable existing content, URLs and brand assets; change only what the plan calls for. Return every changed file in full.'
    : 'Implement the complete website as static files (index.html plus any pages in the architecture, one stylesheet, minimal deferred JS, robots.txt, sitemap.xml) using the architecture, design system, approved copy and SEO specification.';
  return [
    t('build', 'frontend_developer', opts.improvement ? 'Implement the website improvements' : 'Build the website', buildMission, buildDeps, 70),
    t('design_review', 'design_critic', 'Design critique of the implementation', 'Review the rendered implementation for hierarchy, spacing, typography, originality and polish against the design system and ApexWeb anti-slop rules. Reject with precise fixes if it looks generic, templated or over-decorated.', ['build'], 75, { review_of: 'build' }),
    t('responsive', 'responsive_design', 'Responsive verification', 'Verify behaviour at 360/768/1440px using the rendered measurements; report every defect with selector, viewport and CSS fix.', ['design_review'], 60),
    t('accessibility', 'accessibility_specialist', 'Accessibility audit', 'Audit the implementation against WCAG 2.2 AA using the axe results and a manual review of semantics, keyboard flow and focus states.', ['design_review'], 60),
    t('performance', 'performance_engineer', 'Performance audit', 'Audit loading performance using the measured mobile probe (LCP, CLS, bytes, render-blocking) and the files; give concrete fixes.', ['design_review'], 60),
    t('seo_audit', 'seo_specialist', 'On-page SEO audit of the implementation', 'Audit the built pages against the SEO strategy using the seo_audit tool output: metadata, headings, JSON-LD validity, internal links, sitemap/robots. Return a review with fixes.', ['design_review'], 60),
    t('fixes', 'website_debugger', 'Fix verified issues', 'Fix all critical and major issues reported by the responsive, accessibility, performance and SEO audits. If no audit reported fixable issues, make no changes and say so.', ['responsive', 'accessibility', 'performance', 'seo_audit'], 80),
    t('final_qa', 'final_qa_release', 'Final QA and release check', 'Run the final release checks on the fixed site. Approve only if there are no deterministic hard failures and no unresolved critical issues; otherwise reject with the exact fixes required.', ['fixes'], 85, { qa_gate: true }),
    t('handoff', 'project_documentation', 'Handoff package documentation', 'Write docs/HANDOFF.md (what was built, file structure, how to deploy and edit, every [[PLACEHOLDER]] the client must replace, open items) and docs/CHANGELOG.md, based strictly on the task log.', ['final_qa'], 50),
  ];
}

const DISCOVERY = (subject: string): PlanTask[] => [
  t('intake', 'client_intake', 'Structure the client request', `Turn the request into a structured specification for ${subject}. Record only facts actually present; list unknowns.`, [], 95),
  t('requirements', 'requirements_analyst', 'Requirements gap analysis', 'Identify missing requirements, contradictions and risky assumptions; state safe defaults and what must be confirmed before launch.', ['intake'], 85),
  t('research', 'content_research', 'Audience and industry research', 'Research the audience, services, seasonal needs, common questions and decision criteria. Label every note as verified/general_knowledge/assumption.', ['intake'], 85),
  t('competitive', 'competitive_research', 'Competitive pattern research', 'Summarise structural, offer and trust-signal patterns typical in this sector and where to differentiate, without copying anyone.', ['intake'], 70, { optional: true }),
  t('assets', 'asset_research', 'Visual asset plan', 'Define art direction and an image/asset plan (subjects, composition, licensing, alt text); placeholders with art-direction briefs where real assets are unknown.', ['intake'], 65, { optional: true }),
  t('brand', 'brand_voice', 'Brand voice definition', 'Define voice attributes, vocabulary and before/after examples appropriate to this business and audience.', ['intake', 'research'], 75),
  t('seo_strategy', 'seo_specialist', 'SEO strategy', 'Create the SEO strategy: keyword targets by intent and page, titles/meta/h1 per page, JSON-LD (with placeholders for unknown business fields) and internal linking.', ['intake', 'research'], 75),
  t('local_seo', 'local_seo_specialist', 'Local SEO plan', 'Plan local SEO: service-area approach, NAP requirements, Google Business Profile alignment and local schema fields (placeholders for unknowns).', ['intake'], 70),
];

const DESIGN_AND_COPY: PlanTask[] = [
  t('architecture', 'website_architect', 'Site architecture', 'Define pages, section hierarchy with a purpose per section, navigation, URL structure, tech approach and non-functional requirements.', ['requirements', 'research', 'competitive', 'seo_strategy'], 80),
  t('ux', 'ui_ux_designer', 'Design system and layouts', 'Create the design tokens (AA-verified colour pairs, type scale, spacing, radius, elevation), grid, component inventory and mobile/tablet/desktop layouts for every section.', ['architecture', 'brand', 'assets'], 75),
  t('copy', 'website_copywriter', 'Website copy', 'Write all page copy per the architecture in the brand voice, including title tags and meta descriptions; placeholders for unknown facts.', ['architecture', 'brand', 'research', 'seo_strategy', 'local_seo'], 75),
  t('copy_review', 'conversion_optimization', 'Conversion review of copy', 'Review the copy and structure for clarity, CTA placement and conversion friction; reject with specific rewrites if needed.', ['copy'], 72, { review_of: 'copy' }),
  t('motion', 'animation_motion', 'Motion system', 'Define a restrained, purposeful motion system with reduced-motion fallbacks.', ['ux'], 55, { optional: true }),
];

export const TEMPLATES: Record<Intent, WorkflowTemplate> = {
  new_demo: {
    intent: 'new_demo',
    label: 'New ApexWeb Demo',
    tasks: [...DISCOVERY('a premium ApexWeb demo website'), ...DESIGN_AND_COPY, ...buildAndVerify(['architecture', 'ux', 'copy', 'motion', 'seo_strategy', 'assets'], { improvement: false })],
    required: ['intake', 'architecture', 'ux', 'copy', 'build', 'design_review', 'final_qa', 'handoff'],
  },
  new_website: {
    intent: 'new_website',
    label: 'New Website Project',
    tasks: [
      ...DISCOVERY('a new client website'),
      t('project_plan', 'project_manager', 'Project plan', 'Create milestones, owners, dependencies, risks and acceptance criteria for this build.', ['requirements'], 60, { optional: true }),
      ...DESIGN_AND_COPY,
      t('webgl', 'webgl_specialist', '3D/WebGL assessment', 'Decide whether 3D/WebGL genuinely serves this business; if not, recommend no_3d. Only implement when clearly justified.', ['ux'], 40, { optional: true }),
      ...buildAndVerify(['architecture', 'ux', 'copy', 'motion', 'seo_strategy', 'assets', 'webgl'], { improvement: false }),
    ],
    required: ['intake', 'requirements', 'architecture', 'ux', 'copy', 'build', 'design_review', 'final_qa', 'handoff'],
  },
  website_improvement: {
    intent: 'website_improvement',
    label: 'Existing Website Improvement',
    tasks: [
      t('intake', 'client_intake', 'Inspect the request and existing site', 'Structure the improvement request and record what the existing site contains (the imported baseline and fetched pages are provided). Record facts only.', [], 95),
      t('baseline_seo', 'seo_specialist', 'Baseline SEO audit', 'Audit the existing site (imported baseline) for SEO problems using the seo_audit tool output. Identify SEO equity (URLs, rankings signals, content) that must be preserved.', ['intake'], 80),
      t('baseline_a11y', 'accessibility_specialist', 'Baseline accessibility audit', 'Audit the existing site (imported baseline) for accessibility problems.', ['intake'], 80),
      t('baseline_responsive', 'responsive_design', 'Baseline mobile audit', 'Audit the existing site (imported baseline) at 360/768/1440px.', ['intake'], 80),
      t('baseline_performance', 'performance_engineer', 'Baseline performance audit', 'Audit the existing site (imported baseline) performance.', ['intake'], 80),
      t('baseline_design', 'design_critic', 'Baseline design critique', 'Critique the existing site: what works and must be preserved, and what hurts hierarchy, UX and polish.', ['intake'], 80),
      t('inventory', 'content_research', 'Content inventory and preservation list', 'Inventory the existing content and list what is valuable and must be preserved verbatim or near-verbatim, and what is weak.', ['intake'], 85),
      t('requirements', 'requirements_analyst', 'Improvement requirements', 'Consolidate the audits into prioritised improvement requirements; flag anything that would lose existing value.', ['baseline_seo', 'baseline_a11y', 'baseline_responsive', 'baseline_performance', 'baseline_design', 'inventory'], 85),
      t('brand', 'brand_voice', 'Brand voice (from existing site)', 'Derive the voice from the existing site and brief; keep continuity unless the client asked for a change.', ['inventory'], 70),
      t('architecture', 'website_architect', 'Improvement architecture', 'Define the improved structure while preserving existing URLs and valuable content; list every change with its reason.', ['requirements'], 80),
      t('ux', 'ui_ux_designer', 'Improved design system', 'Evolve the existing visual language into a consistent, accessible design system; do not discard recognisable brand elements.', ['architecture', 'brand'], 75),
      t('copy', 'website_copywriter', 'Copy revisions', 'Revise copy only where the plan requires it, preserving valuable existing content; mark every changed section.', ['architecture', 'brand', 'inventory'], 75),
      t('copy_review', 'conversion_optimization', 'Conversion review of revised copy', 'Review revised copy and structure for clarity and conversion friction.', ['copy'], 72, { review_of: 'copy' }),
      ...buildAndVerify(['architecture', 'ux', 'copy', 'inventory', 'baseline_seo'], { improvement: true }),
    ],
    required: ['intake', 'inventory', 'requirements', 'architecture', 'build', 'design_review', 'final_qa', 'handoff'],
  },
  seo_audit: {
    intent: 'seo_audit',
    label: 'SEO Audit',
    tasks: [
      t('intake', 'client_intake', 'Structure the audit request', 'Structure the SEO audit request and record what was supplied.', [], 95),
      t('seo', 'seo_specialist', 'Technical and on-page SEO audit', 'Audit the supplied site thoroughly (delegate to metadata/schema/internal-link/local checkers where useful) and produce prioritised recommendations.', ['intake'], 80),
      t('local_seo', 'local_seo_specialist', 'Local SEO review', 'Review local SEO signals and opportunities.', ['intake'], 70),
      t('report', 'project_documentation', 'SEO audit report', 'Write docs/SEO-AUDIT.md summarising findings and a prioritised action plan, strictly from the task outputs.', ['seo', 'local_seo'], 50),
    ],
    required: ['intake', 'seo', 'report'],
  },
  research_only: {
    intent: 'research_only',
    label: 'Research Brief',
    tasks: [
      t('intake', 'client_intake', 'Structure the research request', 'Structure the research questions and scope.', [], 95),
      t('research', 'content_research', 'Primary research', 'Research the questions; label every note verified/general_knowledge/assumption.', ['intake'], 80),
      t('competitive', 'competitive_research', 'Competitive research', 'Summarise relevant competitor patterns and opportunities.', ['intake'], 75, { optional: true }),
      t('synthesis', 'research_coordinator', 'Research synthesis', 'Reconcile and merge all findings into one brief with confidence levels and open questions.', ['research', 'competitive'], 80),
      t('report', 'project_documentation', 'Research report', 'Write docs/RESEARCH.md from the synthesis.', ['synthesis'], 50),
    ],
    required: ['intake', 'research', 'synthesis', 'report'],
  },
  content_only: {
    intent: 'content_only',
    label: 'Content Production',
    tasks: [
      t('intake', 'client_intake', 'Structure the content request', 'Structure the content request.', [], 95),
      t('research', 'content_research', 'Content research', 'Research facts the content needs.', ['intake'], 80),
      t('brand', 'brand_voice', 'Voice guidelines', 'Define the voice for this content.', ['intake'], 75),
      t('copy', 'website_copywriter', 'Write the content', 'Write the requested content.', ['research', 'brand'], 75),
      t('copy_review', 'conversion_optimization', 'Content review', 'Review the content for clarity and conversion.', ['copy'], 72, { review_of: 'copy' }),
      t('report', 'project_documentation', 'Content deliverable', 'Write docs/CONTENT.md containing the approved content.', ['copy'], 50),
    ],
    required: ['intake', 'copy', 'report'],
  },
  proposal: {
    intent: 'proposal',
    label: 'Client Proposal',
    tasks: [
      t('intake', 'client_intake', 'Structure the client request', 'Structure the client requirements.', [], 95),
      t('requirements', 'requirements_analyst', 'Requirements analysis', 'Identify gaps and assumptions to state in the proposal.', ['intake'], 85),
      t('proposal', 'proposal_agent', 'Write the proposal', 'Write the scope and proposal as docs/PROPOSAL.md. Prices and dates are placeholders unless supplied.', ['requirements'], 80),
    ],
    required: ['intake', 'proposal'],
  },
};

export function templateFor(intent: string): WorkflowTemplate {
  const tpl = TEMPLATES[intent as Intent];
  if (!tpl) throw new Error(`No workflow template for intent ${intent}`);
  return tpl;
}
