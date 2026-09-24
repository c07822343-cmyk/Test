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

export function isNvidiaHost(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' && (u.hostname === 'nvidia.com' || u.hostname.endsWith('.nvidia.com'));
  } catch {
    return false;
  }
}

export const ModelSpecSchema = z.object({
  id: z.string().min(3),
  provider: z.literal('nvidia'),
  // A per-model endpoint receives the NVIDIA API key, so it must be an NVIDIA-hosted HTTPS URL.
  endpoint: z.string().url().nullable().refine((u) => u === null || isNvidiaHost(u), { message: 'endpoint must be an https URL on an nvidia.com host' }),
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

/**
 * Loads the base registry plus provider extension files (providers/*.json, same
 * schema). Extensions can only add NVIDIA-hosted models; a file that redefines
 * an existing id or references an unknown fallback is rejected as a whole.
 */
export function loadModelRegistry(file: string, extensionFiles: string[] = []): { models: ModelSpec[]; extensions: { loaded: string[]; errors: string[] } } {
  const parsed = RegistryFileSchema.parse(JSON.parse(readFileSync(file, 'utf8')));
  const ids = new Set<string>();
  for (const m of parsed.models) {
    if (ids.has(m.id)) throw new Error(`Duplicate model id in registry: ${m.id}`);
    ids.add(m.id);
  }
  const models = [...parsed.models];
  const extensions = { loaded: [] as string[], errors: [] as string[] };
  for (const f of extensionFiles) {
    try {
      const ext = RegistryFileSchema.parse(JSON.parse(readFileSync(f, 'utf8')));
      const dup = ext.models.find((m) => ids.has(m.id) || ext.models.filter((x) => x.id === m.id).length > 1);
      if (dup) throw new Error(`model ${dup.id} is already defined`);
      const known = new Set([...ids, ...ext.models.map((m) => m.id)]);
      for (const m of ext.models) for (const fb of m.fallbacks) if (!known.has(fb)) throw new Error(`model ${m.id} lists unknown fallback ${fb}`);
      for (const m of ext.models) ids.add(m.id);
      models.push(...ext.models);
      extensions.loaded.push(...ext.models.map((m) => m.id));
    } catch (err) {
      extensions.errors.push(`${f}: ${err instanceof Error ? err.message : String(err)}`.slice(0, 500));
    }
  }
  for (const m of models) {
    for (const f of m.fallbacks) if (!ids.has(f)) throw new Error(`Model ${m.id} lists unknown fallback ${f}`);
  }
  return { models, extensions };
}
