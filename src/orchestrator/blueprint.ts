// Project blueprint: generated once at project start by the Main Agent and
// stored as the project's source of truth (project row, project memory and
// docs/BLUEPRINT.json). Every agent receives it; the scorecard checks its
// requirements.
import { z } from 'zod';

const str = z.preprocess((v) => (v == null ? '' : typeof v === 'string' ? v : JSON.stringify(v)), z.string());
const nstr = z.preprocess((v) => (v === '' || v === undefined || v === 'null' ? null : typeof v === 'string' ? v : JSON.stringify(v)), z.string().nullable());
const arr = z.preprocess((v) => (Array.isArray(v) ? v.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))) : v == null ? [] : [String(v)]), z.array(z.string()));

export const BlueprintSchema = z.object({
  objective: str,
  business: z.object({
    name: nstr.default(null),
    type: str.default('unspecified'),
    location: nstr.default(null),
    service_area: nstr.default(null),
    contact: z.object({ phone: nstr.default(null), email: nstr.default(null), address: nstr.default(null) }).default({}),
  }).default({}),
  target_customer: z.object({ primary: str.default(''), segments: arr.default([]), needs: arr.default([]) }).default({}),
  pages: z.array(z.object({ path: z.string(), title: str, purpose: str, sections: arr.default([]) })).min(1).max(30),
  features: arr.default([]),
  visual_direction: z.object({ mood: str.default(''), palette_guidance: str.default(''), typography_guidance: str.default(''), imagery: str.default(''), avoid: arr.default([]) }).default({}),
  content_requirements: arr.default([]),
  asset_requirements: arr.default([]),
  technical_requirements: arr.default([]),
  seo_requirements: arr.default([]),
  qa_requirements: arr.default([]),
  deployment_requirements: arr.default([]),
  requirements: z.array(z.object({
    id: z.string(),
    text: str,
    category: str.default('general'),
    check: z.object({ type: z.enum(['page_exists', 'text_present', 'element_present', 'manual']).catch('manual'), value: z.string().optional() }).default({ type: 'manual' }),
  })).default([]),
  open_questions: arr.default([]),
});
export type Blueprint = z.infer<typeof BlueprintSchema>;

export const BLUEPRINT_PROMPT = [
  'You are the ApexWeb Main Agent writing the PROJECT BLUEPRINT: the single source of truth every specialist will follow.',
  'Reply with ONE JSON object:',
  '{"objective": string,',
  ' "business": {"name": string|null, "type": string, "location": string|null, "service_area": string|null, "contact": {"phone": null, "email": null, "address": null}},',
  ' "target_customer": {"primary": string, "segments": [string], "needs": [string]},',
  ' "pages": [{"path": "index.html", "title": string, "purpose": string, "sections": [string]}],',
  ' "features": [string], "visual_direction": {"mood": string, "palette_guidance": string, "typography_guidance": string, "imagery": string, "avoid": [string]},',
  ' "content_requirements": [string], "asset_requirements": [string], "technical_requirements": [string], "seo_requirements": [string],',
  ' "qa_requirements": [string], "deployment_requirements": [string],',
  ' "requirements": [{"id": "REQ-01", "text": string, "category": string, "check": {"type": "page_exists"|"text_present"|"element_present"|"manual", "value": string}}],',
  ' "open_questions": [string]}',
  'Rules:',
  '- Business facts (name, contact, address, service area, licences, years, reviews) come ONLY from the request; unknown values stay null and become open_questions. Never invent them.',
  '- Keep the page set proportionate: a demo or small local business usually needs 1-5 pages; do not pad.',
  '- 8-15 requirements, each testable. Use check types only when they can be verified mechanically (page_exists: "services.html"; text_present: a short phrase that must appear; element_present: an HTML tag like "form"); otherwise "manual".',
  '- Visual direction must be specific to this business and audience and must list patterns to avoid (generic templates, stock clichés, decorative effects).',
].join('\n');
