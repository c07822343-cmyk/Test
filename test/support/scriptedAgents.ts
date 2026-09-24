// TEST FIXTURE ONLY. Deterministic stand-in for model output so integration
// tests can drive the real orchestration end to end (queue, key pool,
// limiter, review gates, fix cycles, Chromium audits, packaging) without
// network access to NVIDIA. It inspects the prompt the system actually built
// and answers in the protocol the system actually parses. Never imported by src/.

export interface ScriptOptions {
  /** First build overflows on mobile: the Design Critic's rendered evidence must force a rejection. */
  rejectFirstBuild?: boolean;
  /** Final QA rejects its first run, forcing a fix cycle. */
  rejectFirstQa?: boolean;
  /** The triage fix still pushes the hero/CTA below the fold, so Visual QA's region checks must drive a refinement cycle. */
  visualDefectAfterTriage?: boolean;
  /** Workflow intent the Main Agent's interpretation returns (default local_business_website). */
  intent?: string;
}

const CSS = `:root{--ink:#14202b;--muted:#3d4b57;--paper:#fbfaf7;--accent:#0b5d7a;--accent-ink:#ffffff;--line:#d9dde0;--space-1:.5rem;--space-2:1rem;--space-3:1.5rem;--space-4:2.5rem;--space-5:4rem;--radius:6px;--font:"Source Sans 3",system-ui,sans-serif}
*{box-sizing:border-box}html{-webkit-text-size-adjust:100%}body{margin:0;font-family:var(--font);font-size:1.0625rem;line-height:1.6;color:var(--ink);background:var(--paper)}
a{color:var(--accent)}a:focus-visible,button:focus-visible,input:focus-visible,textarea:focus-visible{outline:3px solid var(--accent);outline-offset:2px}
.skip{position:absolute;left:-999px}.skip:focus{left:var(--space-2);top:var(--space-2);background:#fff;padding:var(--space-1)}
.wrap{max-width:68rem;margin:0 auto;padding:0 var(--space-2)}
header{border-bottom:1px solid var(--line);background:#fff}.bar{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:var(--space-1);padding:var(--space-1) 0}
.brand{font-weight:700;font-size:1.25rem;color:var(--ink);text-decoration:none;display:inline-flex;align-items:center;min-height:44px}
nav ul{list-style:none;margin:0;padding:0;display:flex;flex-wrap:wrap;gap:var(--space-1)}nav a{display:inline-flex;align-items:center;min-height:44px;min-width:44px;padding:0 var(--space-1);color:var(--ink);text-decoration:none}
.hero{padding:var(--space-5) 0 var(--space-4)}.hero h1{font-size:clamp(2rem,6vw,3.25rem);line-height:1.1;margin:0 0 var(--space-2)}.lead{font-size:1.25rem;color:var(--muted);max-width:40rem}
.btn{display:inline-flex;align-items:center;justify-content:center;min-height:48px;min-width:44px;padding:0 var(--space-3);border-radius:var(--radius);background:var(--accent);color:var(--accent-ink);font-weight:600;text-decoration:none;border:0;font-size:1rem;cursor:pointer}
.btn-secondary{background:transparent;color:var(--accent);border:2px solid var(--accent)}.actions{display:flex;flex-wrap:wrap;gap:var(--space-2);margin-top:var(--space-3)}
section{padding:var(--space-4) 0;border-top:1px solid var(--line)}h2{font-size:1.75rem;line-height:1.2;margin:0 0 var(--space-2)}h3{font-size:1.25rem;margin:0 0 var(--space-1)}
.grid{display:grid;gap:var(--space-3)}@media (min-width:48rem){.grid{grid-template-columns:repeat(3,1fr)}}
.card{background:#fff;border:1px solid var(--line);border-radius:var(--radius);padding:var(--space-3)}.card p{margin:0;color:var(--muted)}
form{display:grid;gap:var(--space-2);max-width:32rem}label{font-weight:600}input,textarea{width:100%;min-height:48px;padding:var(--space-1);border:1px solid #8a959e;border-radius:var(--radius);font:inherit}
footer{padding:var(--space-4) 0;border-top:1px solid var(--line);color:var(--muted)}footer a{display:inline-flex;align-items:center;min-height:44px}
@media (prefers-reduced-motion:reduce){*{transition:none!important;animation:none!important}}`;

type Variant = 'overflow' | 'lowcta' | 'clean';

function page(variant: Variant | boolean): string {
  const broken = variant === true || variant === 'overflow';
  const lowcta = variant === 'lowcta';
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Heating and Cooling Repair in [[PLACEHOLDER: city]] | Demo HVAC</title>
<meta name="description" content="Furnace repair, air conditioning service and heat pump installation for homes in [[PLACEHOLDER: service area]]. Book a visit online or by phone.">
<link rel="canonical" href="https://example.com/">
<meta property="og:title" content="Heating and Cooling Repair | Demo HVAC">
<meta property="og:description" content="Furnace repair, AC service and heat pump installation.">
<link rel="stylesheet" href="styles.css">
<script src="main.js" defer></script>
<script type="application/ld+json">{"@context":"https://schema.org","@type":"HVACBusiness","name":"[[PLACEHOLDER: business name]]","telephone":"[[PLACEHOLDER: phone]]","areaServed":"[[PLACEHOLDER: service area]]","url":"https://example.com/"}</script>
</head>
<body>
<a class="skip" href="#main">Skip to content</a>
<header><div class="wrap bar"><a class="brand" href="index.html">Demo HVAC</a>
<nav aria-label="Primary"><ul><li><a href="#services">Services</a></li><li><a href="#process">How it works</a></li><li><a href="#contact">Contact</a></li></ul></nav></div></header>
<main id="main">
<div class="hero"><div class="wrap">
${lowcta ? '<div class="intro-band" style="height:1100px" aria-hidden="true"></div>' : ''}
<h1>Heating and cooling repair you can schedule today</h1>
<p class="lead">Furnace repairs, air conditioning service and heat pump installs for homes in [[PLACEHOLDER: service area]]. A technician explains the problem and the price before any work starts.</p>
<div class="actions"><a class="btn" href="#contact">Book a service visit</a><a class="btn btn-secondary" href="tel:+10000000000">Call [[PLACEHOLDER: phone]]</a></div>
${broken ? '<div class="hero-art" style="width:520px;height:40px" aria-hidden="true"></div>' : ''}
</div></div>
<section id="services"><div class="wrap"><h2>Repairs and installs for every season</h2>
<div class="grid">
<article class="card"><h3>Furnace repair</h3><p>No heat, short cycling or strange noises: we diagnose the cause and repair the most common faults on the first visit when parts are on the van.</p></article>
<article class="card"><h3>Air conditioning service</h3><p>Warm air, ice on the lines or high bills: a tune-up and refrigerant check before the summer rush.</p></article>
<article class="card"><h3>Heat pump installation</h3><p>Sizing based on your home, a written quote, and a walkthrough of the thermostat before we leave.</p></article>
</div></div></section>
<section id="process"><div class="wrap"><h2>How a visit works</h2>
<ol><li>Pick a time online or by phone.</li><li>The technician inspects the system and explains the options with prices.</li><li>You approve the work before it starts.</li></ol></div></section>
<section id="contact"><div class="wrap"><h2>Request a visit</h2>
<form action="#" method="post"><label for="name">Name</label><input id="name" name="name" autocomplete="name" required>
<label for="phone">Phone</label><input id="phone" name="phone" type="tel" autocomplete="tel" required>
<label for="issue">What is happening with your system?</label><textarea id="issue" name="issue" rows="4"></textarea>
<button class="btn" type="submit">Send request</button></form></div></section>
</main>
<footer><div class="wrap"><p>[[PLACEHOLDER: business name]] · [[PLACEHOLDER: address]] · <a href="tel:+10000000000">[[PLACEHOLDER: phone]]</a></p></div></footer>
</body>
</html>`;
}

const JS = `document.documentElement.classList.add('js');`;
const ROBOTS = 'User-agent: *\nAllow: /\nSitemap: https://example.com/sitemap.xml\n';
const SITEMAP = '<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>https://example.com/</loc></url></urlset>\n';

function files(variant: Variant | boolean): string {
  return [
    ['index.html', page(variant)],
    ['styles.css', CSS],
    ['main.js', JS],
    ['robots.txt', ROBOTS],
    ['sitemap.xml', SITEMAP],
  ].map(([p, c]) => `<<<FILE path="${p}">>>\n${c}\n<<<END FILE>>>`).join('\n');
}

function envelope(summary: string, result: unknown, extra: Record<string, unknown> = {}): string {
  return '```json\n' + JSON.stringify({ status: 'completed', summary, result, confidence: 0.8, assumptions: [], unresolved_issues: [], recommended_next_action: null, ...extra }) + '\n```';
}

const approve = (area: string) => ({ verdict: 'approve', score: 8, issues: [], strengths: [`${area} is consistent`] });

const CLAIMS = [{ statement: 'Homeowners typically need urgent help when heating or cooling fails', classification: 'INFERENCE', source_ids: [], confidence: 0.6 }];

export function createScript(opts: ScriptOptions = {}) {
  const counts = new Map<string, number>();
  const seen = (k: string) => {
    const n = (counts.get(k) ?? 0) + 1;
    counts.set(k, n);
    return n;
  };

  return function reply(body: any): string {
    const system = String(body?.messages?.[0]?.content ?? '');
    const userMsg = body?.messages?.[1]?.content;
    const user = typeof userMsg === 'string' ? userMsg : Array.isArray(userMsg) ? userMsg.filter((p: any) => p.type === 'text').map((p: any) => p.text).join('\n') : '';

    if (system.includes('Classify the user message')) return JSON.stringify({ route: 'new_work', control_action: null });
    if (system.includes('Interpret the user request')) {
      return JSON.stringify({
        intent: opts.intent ?? 'local_business_website', project_name: 'Local HVAC company website', summary: 'A premium website for a local HVAC company.', complexity: 'complex',
        business: { name: null, type: 'HVAC contractor', location: null, existing_url: null }, audience: 'Homeowners needing heating/cooling service',
        goals: ['Generate service bookings and calls'], constraints: [], deliverables: ['Website'], urls: [], known_facts: ['The business is a local HVAC company'],
        needs_clarification: false, clarification_questions: [],
      });
    }
    if (system.includes('PROJECT BLUEPRINT')) {
      return JSON.stringify({
        objective: 'Turn local homeowners with heating or cooling problems into booked service visits.',
        business: { name: null, type: 'HVAC contractor', location: null, service_area: null, contact: { phone: '(555) 010-2030', email: null, address: null } },
        target_customer: { primary: 'Homeowners', segments: ['Emergency repair', 'Seasonal maintenance', 'Replacement'], needs: ['Fast response', 'Clear pricing'] },
        pages: [{ path: 'index.html', title: 'Home', purpose: 'Explain services and drive bookings', sections: ['hero', 'services', 'process', 'contact'] }],
        features: ['Booking request form', 'Click-to-call'], visual_direction: { mood: 'calm, competent', palette_guidance: 'deep teal accent on warm paper', typography_guidance: 'one humanist sans', imagery: 'real technicians at work (placeholders until supplied)', avoid: ['stock clichés', 'gradients', 'glassmorphism'] },
        content_requirements: ['Services: furnace repair, AC service, heat pumps'], asset_requirements: ['Logo', 'Team photos'], technical_requirements: ['Static HTML/CSS'], seo_requirements: ['HVACBusiness JSON-LD'],
        qa_requirements: ['No overflow on mobile'], deployment_requirements: ['robots.txt and sitemap.xml'],
        requirements: [
          { id: 'REQ-01', text: 'Home page exists', category: 'pages', check: { type: 'page_exists', value: 'index.html' } },
          { id: 'REQ-02', text: 'Booking request form is present', category: 'features', check: { type: 'element_present', value: 'form' } },
          { id: 'REQ-03', text: 'Primary CTA "Book a service visit" is present', category: 'conversion', check: { type: 'text_present', value: 'Book a service visit' } },
          { id: 'REQ-04', text: 'Visitors understand what happens on a visit', category: 'content', check: { type: 'manual' } },
        ],
        open_questions: ['Business name, phone and service area'],
      });
    }
    if (system.includes('choosing which skills this project needs')) {
      return JSON.stringify({ skills: ['local-business-website', 'premium-design', 'anti-ai-slop', 'local-business-research', 'technical-seo', 'visual-qa', 'second-set-of-eyes', 'copywriting', 'frontend-engineering', 'accessibility-engineering', 'performance-engineering', 'handoff', 'client-intake', 'design-critique', 'git-workflow', 'change-review', 'cta-optimization'].map((name) => ({ name, reason: 'needed for a premium local-business site' })) });
    }
    if (system.includes('Task Decomposer')) {
      const m = user.match(/TEMPLATE \([^)]*\):\n([\s\S]*)$/);
      const tasks = m ? JSON.parse(m[1]) : [];
      return JSON.stringify({ tasks: tasks.map((t: any) => ({ ...t, mission: `${t.mission} (Tailored for a local HVAC company.)` })), rationale: 'Template adapted for a local HVAC company.' });
    }
    if (system.includes('writing the completion report')) {
      return JSON.stringify({ completed: 'Built and verified a one-page HVAC site with booking form, service overview and structured data.', issues_summary: 'Business details are placeholders.', recommended_next_step: 'Replace placeholders with the client\u2019s real details.' });
    }
    if (system.includes('project retrospective')) {
      return JSON.stringify({
        what_worked: ['Parallel research'], what_failed: ['First build overflowed on mobile'], recurring_issues: ['layout overflow'], successful_patterns: ['Rendered evidence in reviews'],
        common_revisions: ['layout'], performance_lessons: [], qa_findings: ['footer link labelling'],
        candidate_knowledge: [
          { category: 'common_bugs', title: 'Decorative fixed-width bands overflow on mobile', content: 'Decorative elements with fixed pixel widths cause horizontal overflow at 375px; size them with max-width:100%.', tags: ['frontend_developer', 'css-debugging'] },
          { category: 'client_requirements', title: 'Client phone format', content: 'Use [[PLACEHOLDER: phone]] for the HVAC client phone.', tags: ['website_copywriter'] },
        ],
      });
    }
    const agent = (system.match(/You are the (.+?), a specialist worker/) ?? [])[1] ?? 'unknown';
    const n = seen(agent);
    switch (agent) {
      case 'Frontend Developer': {
        const variant: Variant = opts.rejectFirstBuild && n === 1 ? 'overflow' : 'clean';
        return envelope(variant === 'overflow' ? 'Built the first version of the site.' : 'Rebuilt the site addressing the design review.', { files_written: ['index.html', 'styles.css', 'main.js', 'robots.txt', 'sitemap.xml'], implementation_notes: [], known_limitations: [], commit_message: 'feat: build site' }) + '\n' + files(variant);
      }
      case 'Design Critic':
        // Always "approves": the rendered overflow on the first build must force a rejection by itself.
        return envelope('Reviewed the implementation.', approve('Type scale'));
      case 'Visual QA Specialist': {
        if (/"rule": "(cta_below_fold|hero_below_fold)"/.test(user)) {
          return envelope('Hero and primary CTA are pushed below the fold on mobile.', { verdict: 'reject', score: 5, issues: [{ severity: 'major', area: 'hero', description: 'An empty decorative band pushes the h1 and CTA below the first viewport', fix: 'Remove the .intro-band element from the hero' }], strengths: [], resolved_since_last_pass: [], regressions: [] });
        }
        return envelope('All viewports pass visual QA.', { ...approve('Visual'), resolved_since_last_pass: ['hero above the fold'], regressions: [] });
      }
      case 'ApexWeb Main Agent':
        return envelope('Triaged the independent reviews.', { accepted: [{ finding: 'Footer phone link should have an accessible name', from: 'ux_reviewer', severity: 'major', assign_to: 'website_debugger', fix: 'Add aria-label="Call us" to the footer phone link' }], rejected: [{ finding: 'Make the logo bigger', from: 'design_critic', reason: 'subjective; not evidenced' }], summary: '1 accepted, 1 rejected' });
      case 'Final QA / Release Agent':
        if (opts.rejectFirstQa && n === 1) {
          return envelope('Release blocked: footer contact link lacks a descriptive label.', { verdict: 'reject', score: 6, issues: [{ severity: 'major', area: 'footer', description: 'Footer phone link text is only a placeholder', fix: 'Add aria-label "Call us" to the footer phone link' }], strengths: [], revision_instructions: 'Label the footer phone link.', requirement_checks: [] });
        }
        return envelope('All release checks pass.', { ...approve('Release'), requirement_checks: [{ id: 'REQ-04', passed: true, evidence: 'The "How a visit works" section lists the three steps.' }] });
      case 'Website Debugger': {
        // 1st call = triage fix (still leaves the hero defect if configured), later calls = clean.
        const variant: Variant = opts.visualDefectAfterTriage && n === 1 ? 'lowcta' : 'clean';
        return envelope('Applied the requested fixes.', { fixes: [{ issue: 'requested fixes', status: 'fixed', change: 'updated index.html' }], files_written: ['index.html'], commit_message: 'fix: apply review findings' }) + '\n' + files(variant).split('<<<FILE path="styles.css">>>')[0].trim();
      }
      case 'Project Documentation Agent':
        return envelope('Wrote handoff docs.', { files_written: ['docs/HANDOFF.md', 'docs/CHANGELOG.md'], open_items: ['Replace placeholders'] }) +
          '\n<<<FILE path="docs/HANDOFF.md">>>\n# Handoff\n\nStatic site in site/. Replace every [[PLACEHOLDER]].\n<<<END FILE>>>\n<<<FILE path="docs/CHANGELOG.md">>>\n# Changelog\n\n- Initial build\n<<<END FILE>>>';
      default:
        if (system.includes('You are a reviewer')) return envelope(`${agent} review complete.`, approve(agent));
        return envelope(`${agent} completed its analysis.`, { notes: [`${agent} output`], claims: CLAIMS, goals: ['Generate bookings'], unknowns: ['Business name'], known_facts: agent === 'Client Intake Agent' ? ['The business is a local HVAC company'] : undefined, acceptance_criteria: ['a', 'b', 'c'] });
    }
  };
}
