// End-to-end demo against a running ApexWeb core (internal or n8n driver):
// sends the request to the Main Agent, follows the project live (stage,
// task counts, per-key RPM) and prints the completion report.
//
// Env: APEXWEB_URL (default http://localhost:8080), APEXWEB_API_TOKEN
// Args: optional request text (default: the HVAC demo request)
const base = (process.env.APEXWEB_URL ?? 'http://localhost:8080').replace(/\/$/, '');
const token = process.env.APEXWEB_API_TOKEN;
if (!token) {
  console.error('Set APEXWEB_API_TOKEN to the core API token.');
  process.exit(1);
}
const message = process.argv.slice(2).join(' ') || 'Create a premium ApexWeb demo website for a local HVAC company.';

async function api(method: string, path: string, body?: unknown): Promise<any> {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${path} -> HTTP ${res.status}: ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : null;
}

const sent = await api('POST', '/v1/chat', { message });
console.log(`Main Agent: ${sent.reply}`);
const projectId = sent.project?.id;
if (!projectId) process.exit(0);
console.log(`Project ${projectId}\n`);

const terminal = new Set(['COMPLETED', 'APPROVED', 'NEEDS_ATTENTION', 'FAILED', 'CANCELLED']);
let last = '';
const announced = new Set<string>();
const started = Date.now();
for (;;) {
  const [{ project, progress }, keys, approvals] = await Promise.all([
    api('GET', `/v1/projects/${projectId}`),
    api('GET', '/v1/keys'),
    api('GET', `/v1/approvals?project_id=${projectId}&status=pending`),
  ]);
  const rpm = keys.keys.map((k: any) => `${k.id} ${k.windowCount}/${k.ceiling}`).join('  ');
  const line = `[${Math.round((Date.now() - started) / 1000)}s] ${project.status} · stage ${project.stage ?? '-'} · ${progress.completed}/${progress.total} tasks, ${progress.active} active · ${rpm}`;
  if (line.replace(/^\[\d+s\] /, '') !== last) {
    console.log(line);
    last = line.replace(/^\[\d+s\] /, '');
  }
  for (const a of approvals.approvals ?? []) {
    if (announced.has(a.id)) continue;
    announced.add(a.id);
    console.log(`\n  Approval needed: ${a.title}\n  Approve with: POST /v1/approvals/${a.id}/approve  (or /approve ${a.id} in chat)\n`);
  }
  if (terminal.has(project.status)) break;
  await new Promise((r) => setTimeout(r, 3_000));
}
const { messages } = await api('GET', `/v1/messages?project_id=${projectId}&limit=500`);
const reportMessage = [...messages].reverse().find((m: any) => m.role === 'main_agent' && m.data?.report);
if (reportMessage) console.log(`\n${reportMessage.content}`);
else {
  const { status, report } = await api('GET', `/v1/projects/${projectId}/report`);
  console.log(report ? `\n${JSON.stringify(report, null, 2)}` : `\nProject ended ${status} without a report; see GET /v1/messages?project_id=${projectId}.`);
}
