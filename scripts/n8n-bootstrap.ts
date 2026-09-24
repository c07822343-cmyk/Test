// Imports the ApexWeb control plane into n8n: two header-auth credentials
// (core API token, webhook secret) and the 20 generated workflows, then
// publishes (activates) them. Secrets are written to a 0600 temp file only for
// the duration of the import and never stored in workflow JSON.
//
// Env: APEXWEB_API_TOKEN, N8N_WEBHOOK_SECRET, APEXWEB_CORE_URL (as reachable from n8n),
//      N8N_BIN (default "n8n"), N8N_* database settings as n8n itself needs.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CREDENTIALS } from '../src/n8n/builder.ts';
import { generateWorkflows, writeWorkflows } from '../src/n8n/generate.ts';

const token = process.env.APEXWEB_API_TOKEN;
const secret = process.env.N8N_WEBHOOK_SECRET;
const core = process.env.APEXWEB_CORE_URL ?? 'http://apexweb-core:8080';
const bin = process.env.N8N_BIN ?? 'n8n';
if (!token || !secret) {
  console.error('APEXWEB_API_TOKEN and N8N_WEBHOOK_SECRET must be set');
  process.exit(1);
}

const tmp = mkdtempSync(path.join(os.tmpdir(), 'apexweb-n8n-'));
const run = (args: string[]) => {
  const out = execFileSync(bin, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: process.env });
  return out.trim().split('\n').filter((l) => /imported|publish|error|success/i.test(l)).join('\n');
};

try {
  const credFile = path.join(tmp, 'credentials.json');
  writeFileSync(credFile, JSON.stringify([
    { id: CREDENTIALS.coreApi.id, name: CREDENTIALS.coreApi.name, type: 'httpHeaderAuth', data: { name: 'Authorization', value: `Bearer ${token}` } },
    { id: CREDENTIALS.webhook.id, name: CREDENTIALS.webhook.name, type: 'httpHeaderAuth', data: { name: 'X-ApexWeb-Webhook-Secret', value: secret } },
  ]), { mode: 0o600 });
  console.log(run(['import:credentials', `--input=${credFile}`]) || 'credentials imported');
  rmSync(credFile, { force: true });

  const wfDir = path.join(tmp, 'workflows');
  writeWorkflows(wfDir, core);
  console.log(run(['import:workflow', '--separate', `--input=${wfDir}`]) || 'workflows imported');
  for (const wf of generateWorkflows(core)) {
    if (!wf.active) continue;
    run(['publish:workflow', `--id=${wf.id}`]);
    console.log(`published ${wf.name}`);
  }
  console.log('Restart n8n (or it picks up published workflows on next start) so webhooks and schedules register.');
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
