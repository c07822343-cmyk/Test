# Architecture

## Components

```
src/
  api/            Fastify HTTP API, dashboard, SSE activity stream, metrics
  orchestrator/   Main Agent, planner, templates, blueprint, approvals/modes, lifecycle,
                  commands, context builder, failure manager, retrospectives
  agents/         Agent registry (specialists + sub-agents), output protocol parser
  skills/         Skills engine (registry, versions, selection, validators)
  queue/          Task queue, project store, task/project state machines
  provider/       Key pool + rate limiter, scheduling strategies, model registry/router,
                  NVIDIA client, requestModel()
  worker/         Task executor (step functions), internal worker, n8n driver, watchdog
  tools/          Tool catalog + permission profiles, runner, site audits, browser checks,
                  visual QA, web fetch (SSRF-guarded), site import
  research/       Search providers, source records, claim classification
  security/       Redaction, untrusted-content wrapping, injection screening
  files/          File/asset intelligence (images, PDF, ZIP, codebases)
  devops/         Per-project git repositories: snapshots, diff, rollback
  quality/        Scorecard
  knowledge/      Knowledge base (global lessons, candidates, promotion)
  cache/          Result cache (model responses, research)
  extensions/     Loaders for tools/ and qa/ extension folders
  n8n/            Workflow builder + generator (20 workflows)
```

Postgres is the single source of truth: projects, tasks, events, keys, key requests, model
health, memory, artifacts, approvals, skills, knowledge, research sources/claims,
snapshots, workers, security events, audit log. Nothing important lives only in memory,
so every process can restart without losing work.

## Request lifecycle

1. **Intake**: the user's message (chat, API, or the n8n webhook) goes to `MainAgent.receive`.
   Slash commands run directly. New work becomes a project, and identical requests inside
   the dedupe window come back as duplicates.
2. **Interpret**: intent, business details the user actually stated, and unknowns. If the
   request is too ambiguous to act on, the Main Agent asks a clarifying question and waits.
3. **Blueprint**: pages, sections, audience, requirements with checkable criteria, and
   constraints. Contact details the user did not state are removed, never invented.
   The blueprint is the source of truth that every agent sees.
4. **Skills**: the LLM selects skills from the catalog, with a rule-based fallback. Sub-skills
   and chains are expanded, and each task gets the skills compatible with its agent.
5. **Plan**: the Task Decomposer proposes a graph. It is validated (agents, dependencies,
   cycles, review targets, gates). If it fails validation twice, the template graph is used.
   Mode gates are then inserted as approval tasks.
6. **Enqueue**: tasks are written with dependencies and priorities. In Assist mode the plan
   waits for approval (`AWAITING_APPROVAL`).
7. **Execute**: see "Task execution" below. Independent tasks run in parallel up to
   `MAX_CONCURRENT_TASKS`, and the limiter keeps every key at or under 55 requests per
   rolling window.
8. **Settle**: when no work is active, a Final Handoff approval is requested if that gate
   is on. Otherwise Final Assembly runs.
9. **Assemble**: builds the scorecard, runs the retrospective, writes the package (site, docs,
   screenshots, reports, tar.gz), takes a stable snapshot and writes the completion report
   (Completed / Agents Used / Outputs / Issues / QA / Files / Recommended Next Step). If new
   work is added during assembly, that package is superseded and assembly runs again.

Lifecycle stages shown to the user are derived from task state, not set by hand:
INTAKE → RESEARCH → PLANNING → DESIGN → DEVELOPMENT → CONTENT → INTEGRATION →
TESTING → QA → REVISION → FINAL REVIEW → READY FOR HANDOFF → COMPLETED
(`project_stage_history` records each transition).

## Task execution

Each task runs as a sequence of step functions. The **same functions** run in-process
(`EXECUTION_DRIVER=internal`) or as n8n nodes calling `/v1/tasks/:id/<step>`
(`EXECUTION_DRIVER=n8n`), so the two drivers cannot drift apart.

| Step | What happens |
|---|---|
| `start` | `ASSIGNED → RUNNING`, attempt counter, heartbeat |
| `tools` | The agent's tools plus its skills' tools, filtered by the agent's permission profile. Denied tools are recorded as security events. |
| `model` | The Model Router picks a model by capability, skipping models already tried and unhealthy ones |
| `context` | The Context Builder assembles global rules, the blueprint, facts, unconfirmed claims, skills, knowledge, dependency outputs and tool results into a token budget. If an identical prompt was already answered in this project, the cached answer is reused. |
| `lease` | Key Manager lease (blocking in-process; n8n polls with a wait hint) |
| `invoke` | The NVIDIA call through `requestModel()`, with heartbeats |
| `review` | Parse the output protocol, check write permissions, run skill validators, verify research claims, write files, take a snapshot, then route: triage, review gate, QA gate or visual QA loop |
| `fail` | Failure Manager decides: retry, retry with backoff on another model, one rescue attempt, then escalate to the user and write a dead letter |

Task statuses: `QUEUED, PLANNING, ASSIGNED, RUNNING, WAITING, REVIEW, RETRYING, BLOCKED,
COMPLETED, FAILED, CANCELLED`, with allowed transitions enforced in
`src/queue/types.ts`.

## Key pool and rate limiter

- **Hard ceiling**: `NVIDIA_RPM_PER_KEY` (≤ 55, enforced at boot) grants per rolling
  `NVIDIA_RATE_WINDOW_MS`.
- **Atomic across processes**: each grant pass locks every `nvidia_keys` row `FOR UPDATE`,
  counts `key_requests` inside the window using the database clock, and inserts the grant
  before committing. Two processes can never both take the 56th slot.
- **Fair queue**: in-process waiters are served by a single pump in priority, then FIFO
  order. Remote (n8n) callers join the same ordered queue by polling, and capacity is
  reserved for whoever is ahead. Nothing is dropped. A caller only gives up after
  `NVIDIA_MAX_LEASE_WAIT_MS`, and then its task is retried.
- **Selection**: `health-weighted-headroom` (default) scores keys on headroom (45%),
  reliability (25%), latency (15%) and concurrency (15%), minus penalties for consecutive
  failures and degraded health. `weighted-least-loaded` is the alternative.
- **Outcomes**: a 429 cools the key down (honouring `Retry-After`). Repeated 5xx or
  timeouts trip a circuit-breaker cooldown. 401/403 disables the key. An unknown model is
  taken out of rotation.
- **Visibility**: `GET /v1/keys` and the dashboard bars show real window counts,
  in-flight, health, cooldowns, latency percentiles and error rates.

## Quality system

- **Review gates**: work tagged `review_of` must be approved, or the target is revised
  (bounded).
- **Second set of eyes**: design, UX, bug, responsive, accessibility, performance and SEO
  reviewers run in parallel. The Main Agent **triages** their findings (fix, defer or
  reject, with reasons). Fixes run as new tasks behind a Change Reviewer gate and are
  inserted before the QA tasks that depend on them.
- **Visual QA loop**: renders the site at 360, 768 and 1440 px, runs region checks
  (horizontal overflow, hero/CTA above the fold, navigation reachability and menu toggle,
  overlapping or clipped elements, tap targets, text size/measure/line height, broken
  images, animation problems, runtime errors) and compares pixels against the previous
  pass. Colour contrast is covered by the axe-core accessibility check. It loops fix → re-render → compare until
  it passes, until `max_refinement_cycles`, or until scores stop improving
  (`cycle_scores`).
- **Final QA gate**: checks every blueprint requirement with evidence. A rejection starts a
  bounded fix cycle.
- **Scorecard**: 30+ criteria (functionality, visual quality, UX, responsiveness,
  accessibility, SEO, performance, content completeness, technical quality, project
  requirements, plus `qa/` extensions). Each one is marked passed, failed or not
  evaluated, with evidence.

## n8n control plane

| # | Workflow | Role |
|---|---|---|
| 01 | Main Intake | Webhook front door; routes commands vs. new work |
| 02 | Main Agent Orchestrator | interpret → blueprint → skills → plan → approval branch → enqueue |
| 03 | Task Queue | Claims ready tasks on a schedule and on demand |
| 04 | NVIDIA Key Manager | Lease request with wait/poll loop |
| 05 | NVIDIA Rate Limiter | Limiter view and sweeps |
| 06 | Model Router | Capability → model selection |
| 07 | Agent Dispatcher | Switch by pipeline; fans out in parallel (`mode: each`, no wait) |
| 08–13 | Pipelines | Website development, research, content, SEO, design review, QA |
| 14 | Final Assembly | Settled project → package and report |
| 15 | Error / Retry Manager | Failure step and dead letters |
| 16 | Observability / Metrics | Periodic snapshot and on-demand metrics |
| 17 | Visual QA Pipeline | Render → analyse → loop, with a cache branch |
| 18 | Human Approval Gates | Approval decisions → resume |
| 19 | Watchdog & Heartbeats | Stuck/orphaned work, dead workers |
| 20 | Skill Runner | Run any skill directly |

Nodes follow the naming standard `AREA — Action` (e.g. `MAIN — Receive Request`,
`KEYPOOL — Lease Request`). Workflows are generated (`npm run n8n:generate`) with
content-hash version ids, so a re-import publishes the new version. The core records every
step it runs for n8n in `workflow_runs` (execution id, node). `scripts/n8n-parity.ts`
checks both directions: every completed task has an n8n execution, and every pipeline
execution maps to core steps.

## Security model

| Boundary | Control |
|---|---|
| Secrets | env or `*_FILE` only. Registered with the redactor and masked everywhere. Never in git, workflow JSON, logs or agent-visible text. |
| API | Bearer token on every `/v1` route and the dashboard. n8n ↔ core uses a shared webhook secret. Previews use signed, expiring links. |
| NVIDIA | Keys stay in the core. Model endpoints must be `https://*.nvidia.com`. |
| External content | Wrapped as untrusted data. Screened for instruction override, role manipulation, exfiltration, command execution, priority or permission manipulation, delimiter spoofing and hidden text. Flagged spans are neutralised and recorded. |
| Web fetch | Public http(s) only (SSRF guard), size and time limits, no credentials. |
| Tools | Permission profiles per agent. Skills cannot widen them, and denials are logged. |
| Repositories | Snapshots and diffs are free. Rollback needs approval and is applied as a new commit, so history is never rewritten. |
| Knowledge | Retrospectives only propose knowledge. A human promotes it, and project-specific details are refused. |
