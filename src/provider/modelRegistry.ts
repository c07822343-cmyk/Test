import { readFileSync } from 'node:fs';
import { z } from 'zod';

export const CAPABILITIES = [
  'planning',
  'reasoning',
  'review',
  'qa',
  'copywriting',
  'research',
  'summarization',
  'code',
  'classification',
  'vision',
] as const;
export type Capability = (typeof CAPABILITIES)[number];

export const ModelSpecSchema = z.object({
  id: z.string().min(3),
  provider: z.literal('nvidia'),
  endpoint: z.string().url().nullable(),
  enabled: z.boolean(),
  discoverable: z.boolean().default(true),
  text: z.boolean(),
  vision: z.boolean(),
  tool_calling: z.boolean(),
  json_mode: z.boolean().default(false),
  context_window: z.number().int().positive(),
  max_output_tokens: z.number().int().positive(),
  speed_tier: z.enum(['fast', 'standard', 'slow']),
  quality_tier: z.number().int().min(1).max(5),
  preferred_tasks: z.array(z.enum(CAPABILITIES)),
  fallbacks: z.array(z.string()),
  system_prefix: z.string().nullable().default(null),
  default_params: z.object({ temperature: z.number().optional(), top_p: z.number().optional() }).default({}),
});
export type ModelSpec = z.infer<typeof ModelSpecSchema>;

const RegistryFileSchema = z.object({ models: z.array(ModelSpecSchema).min(1) });

export function loadModelRegistry(file: string): ModelSpec[] {
  const parsed = RegistryFileSchema.parse(JSON.parse(readFileSync(file, 'utf8')));
  const ids = new Set<string>();
  for (const m of parsed.models) {
    if (ids.has(m.id)) throw new Error(`Duplicate model id in registry: ${m.id}`);
    ids.add(m.id);
  }
  for (const m of parsed.models) {
    for (const f of m.fallbacks) if (!ids.has(f)) throw new Error(`Model ${m.id} lists unknown fallback ${f}`);
  }
  return parsed.models;
}
