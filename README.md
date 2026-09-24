# ApexWeb OS

An autonomous agency operating system for ApexWeb. You talk to one **Main Agent**; it
interprets the request, writes a project blueprint, picks skills and specialists, builds a
dependency-aware task graph, runs independent work in parallel across a pool of NVIDIA API
keys, reviews and QA-checks everything (including rendered visual QA with a self-correction
loop), and hands back a scored, packaged result with a plain report.

n8n is the visual control plane: every step of every task runs as a real n8n execution you
can watch, and a parity check proves n8n's view matches the backend state.

```
User ─► Main Agent ─► blueprint ─► skills ─► task graph ─► Task Queue (Postgres)
                                                             │
                     n8n workflows (01–20) ◄─────────────────┤ dispatch
                                                             ▼
         Key Manager ─► 55 RPM rolling-window limiter ─► Model Router ─► NVIDIA
                                                             │
          specialist output ─► skill validation ─► review / triage / QA / visual QA
                                                             │
                              scorecard ─► package ─► report ─► handoff approval
```

## What's in the box

| Area | What it does |
|---|---|
| **Main Agent** | Interprets requests and commands, asks clarifying questions, writes the blueprint (source of truth), selects skills, plans the graph, triages reviewer findings, assembles the report. |
| **51 agents** | 36 specialists across command, research, development, content, quality and operations, plus 15 sub-agents that specialists spawn for focused checks. `GET /v1/agents` |
| **48 skills** | Versioned (`premium-design@1.0` and `@1.1` side by side), enabled or disabled, with compatible agents, tools, sub-skills and chains, and validators the output must pass. `GET /v1/skills` |
| **17 workflow templates** | New local business website, redesign, audit, SEO audit, landing page, 3D site, emergency bug fix, client revision, competitor research, pre-launch QA, and more. |
| **NVIDIA key pool** | NVIDIA only. Keys `NVIDIA_API_KEY_1..4` come from env or secrets. Each key has a hard **55 requests / rolling 60 s** local ceiling, enforced atomically in Postgres across processes. Keys are chosen by health-weighted headroom, not round robin. When every key is full, requests wait in a FIFO queue and are never dropped. Also: cooldowns, circuit breaking, `Retry-After`, exponential backoff with jitter. |
| **Model Router** | Picks a model by capability from a registry (`config/models.json` plus `providers/`), with fallbacks, catalog discovery and health overlay. |
| **Task queue** | Persistent (Postgres). Supports priorities and classes (CRITICAL…BACKGROUND with aging), dependencies, concurrency caps, leases, heartbeats, retries, dead letters, dedupe and idempotency. Tasks can be cancelled, paused and resumed, and they survive restarts. |
| **Quality** | Independent reviewers ("second set of eyes"), then Main Agent triage, fix tasks behind a change-review gate, rendered Visual QA at 3 viewports that loops until pass or the limit (only continuing while scores measurably improve), a Final QA gate, and a checklist scorecard. |
| **Research** | Uses SearXNG, Brave or no search provider. Every source is recorded with URL, time and hash. Claims are classified VERIFIED_FACT, SOURCE_DERIVED, INFERENCE or UNVERIFIED, and that classification is **enforced against fetched sources**. External content is screened for prompt injection and never gains instruction priority. |
| **Files & git** | Handles file and asset intelligence for PNG, JPEG, PDF and ZIP uploads. Every project gets a git repository: snapshots after each change, diffs, and approval-gated rollback applied as a new commit (history is never destroyed). |
| **Human control** | Three modes (Assist, Semi-Autonomous, Autopilot), approval gates, dry run, slash commands, task overrides (retry, reassign, override, cancel), a live activity feed (SSE), workers and heartbeats, and a watchdog. |
| **Learning** | Per-project retrospectives propose *candidate* knowledge. It only becomes global knowledge after a human promotes it, and project-specific details are refused. |
| **Observability** | Live per-key RPM bars from real limiter state, plus usage, cost-avoidance (cache hits, dedupe), audit log, dead letters and metrics. |

## Quick start (Docker)

```bash
cp .env.example .env
# Fill in: APEXWEB_API_TOKEN, POSTGRES_PASSWORD, N8N_WEBHOOK_SECRET, N8N_ENCRYPTION_KEY
#          (openssl rand -hex 32 for each) and NVIDIA_API_KEY_1..4
docker compose up -d
```

- Dashboard: <http://localhost:8080> (sign in with `APEXWEB_API_TOKEN`)
- n8n: <http://localhost:5678>. Create the owner account on first visit. The 20 ApexWeb
  workflows are already imported and published by `n8n-init`.
- Check that every key works (uses one request per key through the limiter):
  `docker compose exec apexweb-core node scripts/check-keys.ts`
- Run the demo: `APEXWEB_API_TOKEN=… node scripts/demo-hvac.ts`

Optional self-hosted web search: set `RESEARCH_SEARCH_PROVIDER=searxng` and
`SEARXNG_URL=http://searxng:8080` in `.env`, then `docker compose --profile search up -d`.

## Quick start (local)

Requires Node ≥ 22.18 (TypeScript runs directly, no build step) and Postgres ≥ 14.

```bash
npm ci
export DATABASE_URL=postgres://apexweb:…@localhost:5432/apexweb
export APEXWEB_API_TOKEN=$(openssl rand -hex 32)
export NVIDIA_API_KEY_1=… NVIDIA_API_KEY_2=… NVIDIA_API_KEY_3=… NVIDIA_API_KEY_4=…
export EXECUTION_DRIVER=internal      # or n8n, after `npm run n8n:bootstrap`
npm start
```

## Using it

Talk to the Main Agent in the dashboard chat, or `POST /v1/chat {"message": "..."}`, or the
n8n intake webhook `POST /webhook/apexweb/request` (header `X-ApexWeb-Webhook-Secret`).

```
Create a premium website for a local HVAC company.
/dryrun Redesign example.com for a dental clinic       # plan + risks, runs only after approval
/status   /tasks   /activity   /scorecard   /usage
/pause    /resume  /cancel [task]   /retry <task>
/review   /test    /qa    /fix <problem>   /audit <url>   /research <topic>
/approve [id]  /reject <id>   /mode assist|semi|autopilot   /handoff
/snapshots  /rollback <snapshot>   /skills [name]   /knowledge   /promote <id>
```

| Mode | Gates on by default |
|---|---|
| **Assist** | plan approval, major redesign, irreversible repo actions, external publish, final handoff |
| **Semi-Autonomous** (default) | major redesign, irreversible repo actions, external publish |
| **Autopilot** | irreversible repo actions, external publish |

## Extending without code changes

Each folder is loaded at boot (and again from `APEXWEB_EXTENSIONS_DIR` if set). Invalid
entries are rejected and listed at `GET /v1/extensions`.

| Folder | Adds |
|---|---|
| `agents/` | Specialist agents (JSON). Validated against the tool permission model. |
| `skills/` | Versioned skills (JSON) with validators, tools, sub-skills and chains. |
| `workflows/` | Workflow templates (JSON task graphs). |
| `tools/` | Tool modules (`.ts`/`.mjs`). They must declare an existing permission and get read-only inputs. |
| `providers/` | NVIDIA-hosted models for the Model Router. Endpoints must be `https://*.nvidia.com`. |
| `memory/` | Global knowledge-base seeds. |
| `qa/` | Deterministic scorecard checks. |

## Security

- Keys live only in env or secret files and in process memory. They are masked as
  `nvapi-…abcd` everywhere, redacted from logs, messages and errors, and never passed to
  n8n, the frontend or agents. A registry entry cannot route a key to a non-NVIDIA host.
- 55 RPM is a **local safety ceiling** this system imposes on itself. It never tries to evade
  provider limits. A 429 cools the key down and honours `Retry-After`.
- Every `/v1` route and the dashboard require the bearer token. n8n ↔ core traffic uses
  a shared webhook secret held in n8n's encrypted credential store.
- Untrusted content (web pages, client files) is wrapped, screened and neutralised. Tool
  permission profiles limit what each agent can do, and a skill cannot widen them.

## Tests

```bash
npm run typecheck
npm test                      # unit + integration; needs Postgres at TEST_DATABASE_URL
                              # (default postgres://apexweb:apexweb_dev@127.0.0.1:5432/apexweb_test;
                              #  the database name must contain "test" — it is reset)
```

Integration tests run the real stack (Postgres, queue, limiter, executor, Main Agent, HTTP API)
against **`test/support/nimTestServer.ts`, a test-only OpenAI-compatible protocol server**.
Its scripted agents are only for tests; nothing in `src/` references them. Production calls go
to `NVIDIA_BASE_URL`. The suites cover rate limiting, key routing, queueing, failure recovery,
dependencies, persistence and restart, n8n parity, agent routing, approvals, rollback,
caching, dedupe, the watchdog and permissions.

More: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) · [docs/OPERATIONS.md](docs/OPERATIONS.md)
