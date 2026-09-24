// Verifies every configured NVIDIA key with one lightweight catalog request.
// Each check is leased for that key through the Key Manager, so it counts
// against the key's 55 RPM ceiling like any other call. Only masked key ids
// are printed. Exit code 1 if any key fails.
//
// Env: DATABASE_URL, APEXWEB_API_TOKEN, NVIDIA_API_KEY_1..4 (or *_FILE), optional NVIDIA_BASE_URL
import { loadConfig } from '../src/config/env.ts';
import { createServices } from '../src/services.ts';

process.env.LOG_SILENT ??= '1';
const config = loadConfig();
if (!config.nvidia.keys.length) {
  console.error('No NVIDIA keys configured. Set NVIDIA_API_KEY_1..NVIDIA_API_KEY_4 (or NVIDIA_API_KEY_n_FILE) in the environment or secrets store.');
  process.exit(1);
}
const s = await createServices(config);
try {
  const results = await s.provider.checkKeys();
  for (const r of results) {
    const status = r.ok ? 'OK  ' : 'FAIL';
    const detail = r.ok
      ? `${r.models_visible} models visible, ${r.latency_ms}ms${r.registry_models_missing.length ? `; registry models not visible to this key: ${r.registry_models_missing.join(', ')}` : ''}`
      : `${r.http_status ?? 'no response'} ${r.error ?? ''}`;
    console.log(`${status} ${r.key} (${r.masked})  ${detail}`);
  }
  if (results.some((r) => !r.ok)) {
    console.log('\nIf every key fails with a network error, the host cannot reach the NVIDIA endpoint (check outbound network access / proxy allowlists for integrate.api.nvidia.com).');
    process.exitCode = 1;
  }
} finally {
  s.keyPool.stop();
  await s.db.end();
}
