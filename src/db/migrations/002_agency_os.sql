-- Round 2: agency operating system - skills, blueprint, lifecycle, approvals,
-- modes, knowledge, research provenance, caching, heartbeats, snapshots.

-- Versioned skills. Definitions are loaded from skills/*.json (built-in
-- library + extensions) or registered through the API; enable state and
-- every version are persisted so old projects keep their pinned versions.
CREATE TABLE IF NOT EXISTS skills (
  name        text NOT NULL,
  version     text NOT NULL,
  definition  jsonb NOT NULL,
  changes     text,
  enabled     boolean NOT NULL DEFAULT true,
  source      text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (name, version)
);

ALTER TABLE projects ADD COLUMN IF NOT EXISTS mode text NOT NULL DEFAULT 'semi';
ALTER TABLE projects ADD COLUMN IF NOT EXISTS approval_gates text[];
ALTER TABLE projects ADD COLUMN IF NOT EXISTS dry_run boolean NOT NULL DEFAULT false;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS stage text NOT NULL DEFAULT 'INTAKE';
ALTER TABLE projects ADD COLUMN IF NOT EXISTS skill_chain jsonb;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS blueprint jsonb;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS scorecard jsonb;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS dry_run_report jsonb;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS max_refinement_cycles integer NOT NULL DEFAULT 3;

CREATE TABLE IF NOT EXISTS project_stage_history (
  id         bigserial PRIMARY KEY,
  project_id text NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  from_stage text,
  to_stage   text NOT NULL,
  reason     text,
  at         timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX IF NOT EXISTS stage_history_project_idx ON project_stage_history (project_id, id);

ALTER TABLE tasks ADD COLUMN IF NOT EXISTS skills text[] NOT NULL DEFAULT '{}';
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS stage text;
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS priority_class text NOT NULL DEFAULT 'NORMAL';
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS dedupe_key text;
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS heartbeat_at timestamptz;
-- Duplicate-task detection: at most one active task per (project, normalised work).
CREATE UNIQUE INDEX IF NOT EXISTS tasks_dedupe_active_idx ON tasks (project_id, dedupe_key)
  WHERE dedupe_key IS NOT NULL AND status NOT IN ('COMPLETED', 'FAILED', 'CANCELLED');

CREATE TABLE IF NOT EXISTS approvals (
  id            text PRIMARY KEY,
  project_id    text NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  task_id       text REFERENCES tasks(id) ON DELETE CASCADE,
  gate          text NOT NULL,
  title         text NOT NULL,
  detail        jsonb,
  status        text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected', 'expired')),
  requested_at  timestamptz NOT NULL DEFAULT now(),
  decided_at    timestamptz,
  decided_by    text,
  decision_note text
);
CREATE INDEX IF NOT EXISTS approvals_pending_idx ON approvals (status, project_id);

-- Knowledge base: GLOBAL knowledge only (project and task knowledge live in
-- scoped memory). Candidates come from retrospectives and need promotion.
CREATE TABLE IF NOT EXISTS knowledge (
  id             text PRIMARY KEY,
  category       text NOT NULL,
  title          text NOT NULL,
  content        text NOT NULL,
  tags           text[] NOT NULL DEFAULT '{}',
  status         text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'candidate', 'rejected', 'archived')),
  source         text NOT NULL,
  source_project text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  decided_by     text,
  decided_at     timestamptz
);
CREATE INDEX IF NOT EXISTS knowledge_tags_idx ON knowledge USING gin (tags);

CREATE TABLE IF NOT EXISTS retrospectives (
  project_id text PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
  report     jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Result cache (research fetches, searches, deterministic-safe model results).
CREATE TABLE IF NOT EXISTS result_cache (
  key        text PRIMARY KEY,
  scope      text NOT NULL,
  scope_id   text NOT NULL,
  kind       text NOT NULL,
  query      text,
  result     jsonb NOT NULL,
  sources    jsonb,
  hits       integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS result_cache_expiry_idx ON result_cache (expires_at);

-- Research provenance.
CREATE TABLE IF NOT EXISTS research_sources (
  id              text PRIMARY KEY,
  project_id      text NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  task_id         text REFERENCES tasks(id) ON DELETE SET NULL,
  url             text NOT NULL,
  final_url       text,
  title           text,
  source_type     text NOT NULL,
  retrieved_at    timestamptz NOT NULL DEFAULT now(),
  content_sha256  text,
  excerpt         text,
  injection_flags text[] NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS research_sources_project_idx ON research_sources (project_id);

CREATE TABLE IF NOT EXISTS research_claims (
  id               text PRIMARY KEY,
  project_id       text NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  task_id          text REFERENCES tasks(id) ON DELETE SET NULL,
  statement        text NOT NULL,
  classification   text NOT NULL CHECK (classification IN ('VERIFIED_FACT', 'SOURCE_DERIVED', 'INFERENCE', 'UNVERIFIED')),
  claimed_as       text NOT NULL,
  source_ids       text[] NOT NULL DEFAULT '{}',
  confidence       real,
  downgrade_reason text,
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS research_claims_project_idx ON research_claims (project_id, classification);

-- Worker heartbeats (internal workers, n8n, core).
CREATE TABLE IF NOT EXISTS workers (
  id           text PRIMARY KEY,
  kind         text NOT NULL,
  status       text NOT NULL DEFAULT 'alive',
  started_at   timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  inflight     integer NOT NULL DEFAULT 0,
  meta         jsonb
);

-- Version-control snapshots of project output (git commits in the project repo).
CREATE TABLE IF NOT EXISTS project_snapshots (
  id          text PRIMARY KEY,
  project_id  text NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  task_id     text REFERENCES tasks(id) ON DELETE SET NULL,
  label       text NOT NULL,
  commit_sha  text,
  files       jsonb NOT NULL,
  stable      boolean NOT NULL DEFAULT false,
  created_by  text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS project_snapshots_idx ON project_snapshots (project_id, created_at DESC);

CREATE TABLE IF NOT EXISTS file_analyses (
  id         text PRIMARY KEY,
  project_id text NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  path       text NOT NULL,
  kind       text NOT NULL,
  analysis   jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id, path)
);

CREATE TABLE IF NOT EXISTS security_events (
  id         bigserial PRIMARY KEY,
  project_id text REFERENCES projects(id) ON DELETE CASCADE,
  task_id    text REFERENCES tasks(id) ON DELETE SET NULL,
  source     text NOT NULL,
  kind       text NOT NULL,
  flags      text[] NOT NULL DEFAULT '{}',
  excerpt    text,
  action     text NOT NULL,
  at         timestamptz NOT NULL DEFAULT now()
);

-- Usage attribution (cost awareness).
ALTER TABLE key_requests ADD COLUMN IF NOT EXISTS project_id text;
ALTER TABLE key_requests ADD COLUMN IF NOT EXISTS agent_type text;
CREATE INDEX IF NOT EXISTS key_requests_project_idx ON key_requests (project_id);

CREATE TABLE IF NOT EXISTS usage_savings (
  id         bigserial PRIMARY KEY,
  project_id text,
  task_id    text,
  kind       text NOT NULL,
  detail     jsonb,
  at         timestamptz NOT NULL DEFAULT now()
);
