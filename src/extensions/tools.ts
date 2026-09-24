// Tool extensions: tools/*.ts|*.mjs|*.js modules that add a tool without
// touching the runner. A module default-exports
//   { name, permission, description, run({ site, task, facts }) }
// and is registered into the tool catalog at boot. It declares one of the
// existing permissions, so tool profiles still decide which agents may run it,
// and it only ever receives read-only inputs (the project's site files, the
// task's mission and confirmed facts) - never the database, keys or config.
// Extension code runs in-process: install only code you trust.
import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { registerTool, type Permission } from '../tools/catalog.ts';
import type { Finding } from '../tools/siteAudit.ts';
import { errorMessage } from '../util/log.ts';

export interface ToolExtensionInput {
  site: Readonly<Record<string, string>>;
  task: { id: string; project_id: string; agent_type: string; title: string; mission: string };
  facts: readonly string[];
}

export interface ToolExtensionOutput {
  summary: unknown;
  findings?: Finding[];
  hard_failures?: Finding[];
}

export interface ToolExtension {
  name: string;
  permission: Permission;
  description: string;
  timeoutMs?: number;
  run(input: ToolExtensionInput): Promise<ToolExtensionOutput> | ToolExtensionOutput;
}

const registry = new Map<string, ToolExtension>();

export function extensionTool(name: string): ToolExtension | undefined {
  return registry.get(name);
}

export async function loadToolExtensions(dirs: string[]): Promise<{ loaded: string[]; errors: string[] }> {
  const out = { loaded: [] as string[], errors: [] as string[] };
  for (const dir of dirs) {
    if (!existsSync(dir)) continue;
    for (const f of readdirSync(dir).filter((x) => /\.(ts|mjs|js)$/.test(x) && !x.endsWith('.d.ts')).sort()) {
      try {
        const mod = await import(pathToFileURL(path.join(dir, f)).href);
        const ext = (mod.default ?? mod) as ToolExtension;
        if (typeof ext?.run !== 'function' || typeof ext.description !== 'string') throw new Error('module must default-export { name, permission, description, run }');
        if (registry.has(ext.name)) {
          out.loaded.push(ext.name);
          continue; // already registered in this process (e.g. services created twice in tests)
        }
        registerTool({ name: ext.name, permission: ext.permission, description: ext.description.slice(0, 400) });
        registry.set(ext.name, ext);
        out.loaded.push(ext.name);
      } catch (err) {
        out.errors.push(`${f}: ${errorMessage(err)}`.slice(0, 500));
      }
    }
  }
  return out;
}

/** Runs an extension tool with a timeout; its output is normalised into the standard finding shape. */
export async function runToolExtension(ext: ToolExtension, input: ToolExtensionInput): Promise<Required<ToolExtensionOutput>> {
  const frozen: ToolExtensionInput = { site: Object.freeze({ ...input.site }), task: Object.freeze({ ...input.task }), facts: Object.freeze([...input.facts]) };
  const timeout = ext.timeoutMs ?? 60_000;
  let timer: NodeJS.Timeout | undefined;
  try {
    const r = await Promise.race([
      Promise.resolve(ext.run(frozen)),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`tool ${ext.name} timed out after ${timeout}ms`)), timeout);
      }),
    ]);
    const norm = (xs: unknown): Finding[] => (Array.isArray(xs) ? xs : []).slice(0, 200).map((x: any) => ({
      severity: ['critical', 'major', 'minor'].includes(x?.severity) ? x.severity : 'minor',
      rule: String(x?.rule ?? ext.name).slice(0, 80),
      page: x?.page == null ? null : String(x.page).slice(0, 200),
      detail: String(x?.detail ?? '').slice(0, 500),
    }));
    return { summary: r?.summary ?? null, findings: norm(r?.findings), hard_failures: norm(r?.hard_failures) };
  } finally {
    clearTimeout(timer);
  }
}
