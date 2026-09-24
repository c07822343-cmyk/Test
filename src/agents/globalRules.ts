// ApexWeb-wide rules seeded into Global Memory at boot. Operators can edit them
// through the memory API; agents always receive the current stored version.

export const APEXWEB_GLOBAL_RULES = {
  quality_principles: [
    'Premium, intentional, human-directed design. Every section, effect and sentence must earn its place.',
    'Clarity beats decoration: strong typographic hierarchy, generous and consistent spacing, restrained colour.',
    'Motion and 3D only when they communicate something specific about the business; never as filler.',
    'Mobile first: every layout must work at 360px wide without horizontal scrolling.',
    'Performance is a feature: minimal JavaScript, no render-blocking assets, images sized and lazy-loaded.',
    'Accessibility is mandatory: semantic HTML, WCAG 2.2 AA contrast, labelled controls, visible focus states.',
  ],
  honesty_rules: [
    'Never invent facts about a real business: no fabricated statistics, awards, years in business, reviews, testimonials, certifications, prices, addresses or phone numbers.',
    'When a fact is unknown, use an explicit placeholder in the form [[PLACEHOLDER: description]] and list it in unresolved_issues.',
    'General industry knowledge may be stated as general knowledge, never as a claim about the specific client.',
    'Do not copy competitor copy or designs; describe patterns, then create original work.',
  ],
  anti_slop_rules: [
    'Banned filler phrases include: "elevate", "unlock", "seamless", "cutting-edge", "in today\'s fast-paced world", "look no further", "we\'ve got you covered", "your trusted partner", "take it to the next level", "state-of-the-art", "world-class".',
    'No generic template sections repeated across pages (e.g. three identical icon cards, "Why Choose Us" with vague claims).',
    'No meaningless gradients, stacked glassmorphism, glowing blobs or random particle/3D backgrounds.',
    'No stock-looking hero clichés; imagery must be specific to the business or clearly marked as a placeholder with an art-direction brief.',
    'Consistent type scale (max two families), consistent spacing scale, consistent radius and shadow tokens.',
  ],
  existing_site_rules: [
    'For an existing website, inspect first. Preserve valuable existing content, URLs, brand assets and SEO equity unless the brief says otherwise.',
    'Never replace an existing project wholesale with generic generated content.',
  ],
};

export type GlobalRules = typeof APEXWEB_GLOBAL_RULES;
