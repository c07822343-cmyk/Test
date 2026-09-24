import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig, type AppConfig } from '../../src/config/env.ts';
import type { Db } from '../../src/db/pool.ts';
import { createServices, type Services } from '../../src/services.ts';
import { NimTestServer } from './nimTestServer.ts';

export const TEST_TOKEN = 'test-api-token-0123456789abcdef0123456789';

export function testConfig(nimUrl: string, overrides: Record<string, string> = {}): AppConfig {
  return loadConfig({
    NODE_ENV: 'test',
    APEXWEB_API_TOKEN: TEST_TOKEN,
    DATABASE_URL: 'postgres://unused/test',
    APEXWEB_DATA_DIR: mkdtempSync(path.join(os.tmpdir(), 'apexweb-test-')),
    NVIDIA_BASE_URL: nimUrl,
    NVIDIA_API_KEY_1: 'nvapi-test-key-one-aaaaaaaaaaaaaaaa',
    NVIDIA_API_KEY_2: 'nvapi-test-key-two-bbbbbbbbbbbbbbbb',
    NVIDIA_API_KEY_3: 'nvapi-test-key-three-cccccccccccccc',
    NVIDIA_API_KEY_4: 'nvapi-test-key-four-dddddddddddddddd',
    NVIDIA_DISCOVER_MODELS: 'false',
    MAX_CONCURRENT_TASKS: '8',
    EXECUTION_DRIVER: 'internal',
    WORKER_ID: 'test-worker',
    RESEARCH_ALLOW_WEB_FETCH: 'false',
    ...overrides,
  });
}

export async function startStack(db: Db, reply: (body: any) => string, overrides: Record<string, string> = {}): Promise<{ s: Services; nim: NimTestServer }> {
  const nim = new NimTestServer();
  const url = await nim.start();
  nim.behaviour = (call) => ({ reply: reply(call.body) });
  const s = await createServices(testConfig(url, overrides), { db });
  return { s, nim };
}

export async function waitFor<T>(fn: () => Promise<T | null | undefined | false>, timeoutMs: number, label: string, intervalMs = 250): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}`);
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}
