// Central configuration. Every setting comes from the environment (or a *_FILE
// secret mount); nothing secret is ever hardcoded or returned by the API.
import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** Hard upper bound mandated by ApexWeb policy. Configuration may lower it, never raise it. */
export const NVIDIA_RPM_HARD_MAX = 55;

function readSecret(name: string, env: NodeJS.ProcessEnv): string | undefined {
  const direct = env[name];
  if (direct && direct.trim()) return direct.trim();
  const file = env[`${name}_FILE`];
  if (file && file.trim()) {
    const value = readFileSync(file.trim(), 'utf8').trim();
    return value || undefined;
  }
  return undefined;
}

function int(env: NodeJS.ProcessEnv, name: string, fallback: number, min?: number, max?: number): number {
  const raw = env[name];
  let value = raw === undefined || raw === '' ? fallback : Number.parseInt(raw, 10);
  if (!Number.isFinite(value)) throw new Error(`Environment variable ${name} must be an integer`);
  if (min !== undefined && value < min) value = min;
  if (max !== undefined && value > max) value = max;
  return value;
}

function bool(env: NodeJS.ProcessEnv, name: string, fallback: boolean): boolean {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(raw.toLowerCase());
}

export interface NvidiaKeyConfig {
  /** Stable, non-secret identifier used everywhere outside the provider layer. */
  id: string;
  slot: number;
  /** The secret itself. Only the provider's secret vault may read this. */
  secret: string;
  /** Optional model allowlist for this credential (model compatibility). */
  allowedModels: string[] | null;
}

export interface AppConfig {
  env: string;
  host: string;
  port: number;
  apiToken: string;
  databaseUrl: string;
  dataDir: string;
  workerId: string;
  executionDriver: 'internal' | 'n8n';
  maxConcurrentTasks: number;
  taskLeaseMs: number;
  maxFixCycles: number;
  nvidia: {
    baseUrl: string;
    keys: NvidiaKeyConfig[];
    rpmPerKey: number;
    windowMs: number;
    requestTimeoutMs: number;
    maxInflightPerKey: number;
    modelsFile: string;
    discoverModels: boolean;
    maxLeaseWaitMs: number;
    schedulingStrategy: string;
  };
  n8n: {
    baseUrl: string | null;
    webhookSecret: string | null;
    dispatchWebhookPath: string;
    assemblyWebhookPath: string;
  };
  research: {
    allowWebFetch: boolean;
    fetchTimeoutMs: number;
    maxFetchBytes: number;
  };
}

export function loadNvidiaKeys(env: NodeJS.ProcessEnv): NvidiaKeyConfig[] {
  const keys: NvidiaKeyConfig[] = [];
  const seen = new Set<string>();
  const push = (slot: number, secret: string | undefined) => {
    if (!secret || seen.has(secret)) return;
    seen.add(secret);
    const allow = env[`NVIDIA_API_KEY_${slot}_MODELS`];
    keys.push({
      id: `key_${slot}`,
      slot,
      secret,
      allowedModels: allow ? allow.split(',').map((m) => m.trim()).filter(Boolean) : null,
    });
  };
  for (let slot = 1; slot <= 16; slot++) push(slot, readSecret(`NVIDIA_API_KEY_${slot}`, env));
  // Alternative: NVIDIA_API_KEYS="k1,k2,..." fills any unused slots in order.
  const list = readSecret('NVIDIA_API_KEYS', env);
  if (list) {
    let slot = 1;
    for (const secret of list.split(',').map((s) => s.trim()).filter(Boolean)) {
      while (keys.some((k) => k.slot === slot)) slot++;
      push(slot, secret);
    }
  }
  return keys.sort((a, b) => a.slot - b.slot);
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const apiToken = readSecret('APEXWEB_API_TOKEN', env);
  if (!apiToken || apiToken.length < 24) {
    throw new Error('APEXWEB_API_TOKEN must be set (at least 24 characters). Generate one with: openssl rand -hex 32');
  }
  const databaseUrl = readSecret('DATABASE_URL', env);
  if (!databaseUrl) throw new Error('DATABASE_URL must be set');
  const driver = (env.EXECUTION_DRIVER ?? 'internal').toLowerCase();
  if (driver !== 'internal' && driver !== 'n8n') throw new Error('EXECUTION_DRIVER must be "internal" or "n8n"');

  const configuredRpm = int(env, 'NVIDIA_RPM_PER_KEY', NVIDIA_RPM_HARD_MAX, 1);
  if (configuredRpm > NVIDIA_RPM_HARD_MAX) {
    throw new Error(`NVIDIA_RPM_PER_KEY=${configuredRpm} exceeds the ApexWeb hard ceiling of ${NVIDIA_RPM_HARD_MAX}`);
  }

  return {
    env: env.NODE_ENV ?? 'development',
    host: env.APEXWEB_HOST ?? '0.0.0.0',
    port: int(env, 'APEXWEB_PORT', 8080, 0, 65535),
    apiToken,
    databaseUrl,
    dataDir: path.resolve(env.APEXWEB_DATA_DIR ?? './data'),
    // Stable across restarts so crash recovery can reclaim this worker's in-flight tasks.
    workerId: env.WORKER_ID ?? `core@${os.hostname()}`,
    executionDriver: driver,
    maxConcurrentTasks: int(env, 'MAX_CONCURRENT_TASKS', 8, 1, 64),
    taskLeaseMs: int(env, 'TASK_LEASE_MS', 15 * 60_000, 10_000),
    maxFixCycles: int(env, 'MAX_FIX_CYCLES', 2, 0, 5),
    nvidia: {
      baseUrl: (env.NVIDIA_BASE_URL ?? 'https://integrate.api.nvidia.com/v1').replace(/\/+$/, ''),
      keys: loadNvidiaKeys(env),
      rpmPerKey: configuredRpm,
      windowMs: int(env, 'NVIDIA_RATE_WINDOW_MS', 60_000, 100),
      requestTimeoutMs: int(env, 'NVIDIA_REQUEST_TIMEOUT_MS', 180_000, 1_000),
      maxInflightPerKey: int(env, 'NVIDIA_MAX_INFLIGHT_PER_KEY', 8, 1, 64),
      modelsFile: path.resolve(env.NVIDIA_MODELS_FILE ?? 'config/models.json'),
      discoverModels: bool(env, 'NVIDIA_DISCOVER_MODELS', true),
      maxLeaseWaitMs: int(env, 'NVIDIA_MAX_LEASE_WAIT_MS', 10 * 60_000, 1_000),
      schedulingStrategy: env.NVIDIA_KEY_STRATEGY ?? 'health-weighted-headroom',
    },
    n8n: {
      baseUrl: env.N8N_BASE_URL ? env.N8N_BASE_URL.replace(/\/+$/, '') : null,
      webhookSecret: readSecret('N8N_WEBHOOK_SECRET', env) ?? null,
      dispatchWebhookPath: env.N8N_DISPATCH_WEBHOOK_PATH ?? 'apexweb/dispatch',
      assemblyWebhookPath: env.N8N_ASSEMBLY_WEBHOOK_PATH ?? 'apexweb/final-assembly',
    },
    research: {
      allowWebFetch: bool(env, 'RESEARCH_ALLOW_WEB_FETCH', true),
      fetchTimeoutMs: int(env, 'RESEARCH_FETCH_TIMEOUT_MS', 15_000, 1_000),
      maxFetchBytes: int(env, 'RESEARCH_MAX_FETCH_BYTES', 1_500_000, 10_000),
    },
  };
}
