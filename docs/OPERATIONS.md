# Operations

## 1. NVIDIA keys

1. Create up to four API keys at build.nvidia.com (NVIDIA API Catalog).
2. Provide them as environment variables or secret files. Never put them in code, workflow
   JSON or the frontend:
   ```
   NVIDIA_API_KEY_1=nvapi-…          # or NVIDIA_API_KEY_1_FILE=/run/secrets/nvidia_key_1
   NVIDIA_API_KEY_2=nvapi-…
   NVIDIA_API_KEY_3=nvapi-…
   NVIDIA_API_KEY_4=nvapi-…
   ```
   More slots (up to 16) work the same way. `NVIDIA_API_KEY_n_MODELS` restricts a key to
   specific model ids.
3. The host must be able to reach `integrate.api.nvidia.com` over HTTPS (and
   `ai.api.nvidia.com` if you use the vision model). In locked-down environments (corporate
   proxies, sandboxed cloud containers), add these hosts to the outbound allowlist.
4. Verify:
   ```
   node scripts/check-keys.ts        # or: POST /v1/keys/check
   ```
   Each key gets one catalog request, leased through the limiter, and the check reports which
   registry models that key can see. Only masked ids are printed.

The 55 requests/minute per key is a **local safety ceiling**, not an attempt to reach or
work around NVIDIA's limits. Lower it with `NVIDIA_RPM_PER_KEY`. Values above 55 are
refused at boot. If NVIDIA returns 429, that key cools down for the `Retry-After` period
and traffic moves to healthy keys.

## 2. n8n

`docker compose up -d` runs `n8n-init` first, which:

1. imports two Header Auth credentials (core token, webhook secret) into n8n's encrypted
   store (see `n8n/credentials/README.md`), and
2. imports and publishes the 20 generated workflows from `src/n8n/generate.ts`.

Outside Docker, use the same environment as n8n (DB settings, `N8N_ENCRYPTION_KEY`) and run:

```
APEXWEB_API_TOKEN=… N8N_WEBHOOK_SECRET=… APEXWEB_CORE_URL=http://<core-host>:8080 \
  npm run n8n:bootstrap
```

Then restart n8n so webhooks and schedules register, and start the core with
`EXECUTION_DRIVER=n8n` and `N8N_BASE_URL=http://<n8n-host>:5678`.

After changing workflow generation code, run `npm run n8n:generate` to refresh
`n8n/workflows/*.json` (for review in git) and re-run the bootstrap to publish.

**Parity check**: confirms that n8n's view matches backend state.

```
DATABASE_URL=<core db> N8N_DATABASE_URL=<n8n db> [PROJECT_ID=prj_…] node scripts/n8n-parity.ts
```

It exits non-zero if any completed task lacks an n8n execution, or any pipeline execution
lacks core steps.

## 3. Day-to-day control

| Want to… | Do |
|---|---|
| Start work | Chat: `Create a premium website for a local HVAC company.` |
| See the plan first | `/dryrun <request>` → review → `/approve <id>` |
| Follow progress | Dashboard → Project (stage bar, live DAG, tasks) or Activity (live feed) |
| Stop dispatching | `/pause` (running calls finish), `/resume` |
| Stop everything | `/cancel`, or `/cancel <task>` for one task |
| Retry a failure | `/retry <task>`, or reassign/override it in the task panel |
| Add a check pass | `/review`, `/test`, `/qa` |
| Urgent fix | `/fix <problem>` (CRITICAL priority, change review, regression check) |
| Change autonomy | `/mode assist|semi|autopilot` |
| Undo site changes | `/snapshots` → `/rollback <id>` → approve. Applied as a new commit. |
| Accept a lesson | `/knowledge candidates` → `/promote <id>` |

When a required task still fails after retries, a model switch and a rescue attempt, the
project moves to `NEEDS_ATTENTION` and the Main Agent posts what failed and your options.
The failed request is kept in dead letters (`GET /v1/dead-letters`).

## 4. Monitoring

- `GET /healthz`: database reachable, driver, number of configured keys (no values).
- `GET /v1/keys`: per-key window count/ceiling, in-flight, health, cooldown, latency, errors.
- `GET /v1/metrics` / `GET /v1/metrics/text`: queue, projects, keys (text bars), models.
- `GET /v1/usage`: NVIDIA requests by key, model, project and agent, plus avoided work
  (cache hits, duplicates prevented).
- `GET /v1/workers`: heartbeats. `POST /v1/watchdog/run` forces a recovery pass. The
  watchdog already runs every 30 s and recovers stuck tasks, orphaned claims and expired
  leases, and marks dead workers.
- `GET /v1/activity/stream`: server-sent events for the live feed.
- `GET /v1/security/events`: injection screening hits and denied tool permissions.
- `GET /v1/audit`: every human action and override.
- `GET /v1/extensions`: what was loaded from the extension folders, and what was rejected.

## 5. Restarts and recovery

Everything is persisted in Postgres. On start, the core re-queues any tasks its worker id
(`WORKER_ID`, stable per deployment) held when it stopped, and the watchdog reclaims leases
from workers that stopped heartbeating. Projects continue where they left off. Keep
`WORKER_ID` stable across restarts of the same deployment.

## 6. Rotating secrets

- **NVIDIA key**: update the env or secret file, then restart the core. The key keeps its slot
  id (`key_n`), so history and metrics stay continuous.
- **API token / webhook secret**: update `.env`, re-run the n8n bootstrap (it overwrites
  both credentials by id), then restart the core and n8n.

## 7. Backups

Back up the Postgres databases `apexweb` and `n8n`, and the core data volume (`/data`),
which holds project packages and per-project git repositories.

## 8. Troubleshooting

| Symptom | Likely cause |
|---|---|
| Every key reports `network_error` | Outbound HTTPS to `integrate.api.nvidia.com` is blocked (proxy or allowlist). |
| A key shows `disabled: auth_failed` | The key is invalid or revoked (401/403). It stays disabled until you replace it (new value → re-enabled on restart). |
| Tasks stay `QUEUED` | The project is paused, or awaiting approval (`GET /v1/approvals`), or all keys are at the ceiling (see `/v1/keys`; they recover as the window rolls). |
| Tasks stuck in n8n mode | n8n is not running, or the workflows are not published. Check `N8N_BASE_URL`, then re-run the bootstrap. |
| Scorecard browser checks "not evaluated" | Chromium is unavailable. The Docker image includes it. Locally, set `CHROMIUM_EXECUTABLE_PATH`. |
| Research says "no search provider" | Set `RESEARCH_SEARCH_PROVIDER` (searxng or brave). Without a provider, research only uses supplied URLs and files, and says so. |
