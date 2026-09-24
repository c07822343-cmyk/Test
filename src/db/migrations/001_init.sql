-- ApexWeb OS core schema. Postgres is the single source of truth: tasks, key
-- usage and rate-limit timestamps all live here so state survives restarts and
-- multiple core replicas share one limiter.

CREATE TABLE IF NOT EXISTS projects (
  id              text PRIMARY KEY,
  name            text NOT NULL,
  kind            text NOT NULL,
  status          text NOT NULL,
  request         text NOT NULL,
  interpretation  jsonb,
  plan            jsonb,
  final_report    jsonb,
  idempotency_key text UNIQUE,
  paused          boolean NOT NULL DEFAULT false,
  fix_cycles      integer NOT NULL DEFAULT 0,
  approved_at     timestamptz,
  approved_by     text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  completed_at    timestamptz
);

CREATE TABLE IF NOT EXISTS tasks (
  id                    text PRIMARY KEY,
  project_id            text NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  parent_task_id        text REFERENCES tasks(id) ON DELETE CASCADE,
  plan_key              text NOT NULL,
  agent_type            text NOT NULL,
  title                 text NOT NULL,
  mission               text NOT NULL,
  kind                  text NOT NULL DEFAULT 'work',       -- root | work | review | subtask | fix | qa
  status                text NOT NULL,
  optional              boolean NOT NULL DEFAULT false,
  priority              integer NOT NULL DEFAULT 50,
  dependencies          text[] NOT NULL DEFAULT '{}',
  inputs                jsonb NOT NULL DEFAULT '{}'::jsonb,
  outputs               jsonb,
  phase                 text NOT NULL DEFAULT 'execute',     -- execute | synthesize
  review_target         text REFERENCES tasks(id) ON DELETE SET NULL,
  capability            text,
  model_override        text,
  attempt               integer NOT NULL DEFAULT 0,
  max_attempts          integer NOT NULL DEFAULT 3,
  capacity_waits        integer NOT NULL DEFAULT 0,
  revision              integer NOT NULL DEFAULT 0,
  max_revisions         integer NOT NULL DEFAULT 2,
  assigned_key          text,
  assigned_model        text,
  lease_owner           text,
  lease_expires_at      timestamptz,
  not_before            timestamptz,
  timeout_ms            integer NOT NULL DEFAULT 600000,
  idempotency_key       text UNIQUE,
  error                 jsonb,
  workflow_execution_id text,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  started_at            timestamptz,
  completed_at          timestamptz
);
CREATE INDEX IF NOT EXISTS tasks_ready_idx ON tasks (status, priority DESC, created_at);
CREATE INDEX IF NOT EXISTS tasks_project_idx ON tasks (project_id);
CREATE INDEX IF NOT EXISTS tasks_parent_idx ON tasks (parent_task_id);
CREATE INDEX IF NOT EXISTS tasks_deps_idx ON tasks USING gin (dependencies);

CREATE TABLE IF NOT EXISTS task_events (
  id          bigserial PRIMARY KEY,
  task_id     text REFERENCES tasks(id) ON DELETE CASCADE,
  project_id  text REFERENCES projects(id) ON DELETE CASCADE,
  at          timestamptz NOT NULL DEFAULT clock_timestamp(),
  type        text NOT NULL,
  from_status text,
  to_status   text,
  actor       text NOT NULL,
  detail      jsonb
);
CREATE INDEX IF NOT EXISTS task_events_task_idx ON task_events (task_id, id);
CREATE INDEX IF NOT EXISTS task_events_project_idx ON task_events (project_id, id);

-- One row per configured credential. The secret itself is NEVER stored; only a
-- non-reversible fingerprint so operators can tell keys apart.
CREATE TABLE IF NOT EXISTS nvidia_keys (
  id                   text PRIMARY KEY,
  slot                 integer NOT NULL UNIQUE,
  fingerprint          text NOT NULL,
  masked               text NOT NULL,
  active               boolean NOT NULL DEFAULT true,
  disabled_reason      text,
  cooldown_until       timestamptz,
  consecutive_failures integer NOT NULL DEFAULT 0,
  total_requests       bigint NOT NULL DEFAULT 0,
  total_failures       bigint NOT NULL DEFAULT 0,
  total_timeouts       bigint NOT NULL DEFAULT 0,
  total_429            bigint NOT NULL DEFAULT 0,
  total_5xx            bigint NOT NULL DEFAULT 0,
  last_used_at         timestamptz,
  last_error           text,
  current_model        text,
  updated_at           timestamptz NOT NULL DEFAULT now()
);

-- Rolling-window ledger. Every granted slot is a row stamped with the DB clock;
-- the limiter counts rows inside the window under a row lock on nvidia_keys.
CREATE TABLE IF NOT EXISTS key_requests (
  id          bigserial PRIMARY KEY,
  lease_id    text NOT NULL UNIQUE,
  key_id      text NOT NULL REFERENCES nvidia_keys(id) ON DELETE CASCADE,
  granted_at  timestamptz NOT NULL,
  model       text NOT NULL,
  task_id     text,
  purpose     text,
  status      text NOT NULL DEFAULT 'granted',  -- granted | in_flight | ok | rate_limited | server_error | timeout | client_error | auth_error | network_error | expired
  http_status integer,
  latency_ms  integer,
  finished_at timestamptz,
  error       text,
  usage       jsonb
);
CREATE INDEX IF NOT EXISTS key_requests_window_idx ON key_requests (key_id, granted_at DESC);
CREATE INDEX IF NOT EXISTS key_requests_time_idx ON key_requests (granted_at DESC);

-- Runtime overlay on the model capability registry (config/models.json).
CREATE TABLE IF NOT EXISTS model_health (
  model_id             text PRIMARY KEY,
  available            boolean NOT NULL DEFAULT true,
  reason               text,
  consecutive_failures integer NOT NULL DEFAULT 0,
  last_checked_at      timestamptz,
  updated_at           timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS memory (
  id         bigserial PRIMARY KEY,
  scope      text NOT NULL CHECK (scope IN ('global', 'project', 'task', 'agent')),
  scope_id   text NOT NULL,
  key        text NOT NULL,
  value      jsonb NOT NULL,
  source     text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (scope, scope_id, key)
);

CREATE TABLE IF NOT EXISTS artifacts (
  id           text PRIMARY KEY,
  project_id   text NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  task_id      text REFERENCES tasks(id) ON DELETE SET NULL,
  path         text NOT NULL,
  version      integer NOT NULL,
  kind         text NOT NULL,          -- site | doc | report | screenshot | client_file
  content_type text NOT NULL,
  content      bytea NOT NULL,
  bytes        integer NOT NULL,
  sha256       text NOT NULL,
  created_by   text NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id, path, version)
);
CREATE INDEX IF NOT EXISTS artifacts_project_idx ON artifacts (project_id, path, version DESC);

CREATE TABLE IF NOT EXISTS dead_letters (
  id          bigserial PRIMARY KEY,
  task_id     text REFERENCES tasks(id) ON DELETE CASCADE,
  project_id  text REFERENCES projects(id) ON DELETE CASCADE,
  reason      text NOT NULL,
  error       jsonb,
  created_at  timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz,
  resolution  text
);

CREATE TABLE IF NOT EXISTS messages (
  id         bigserial PRIMARY KEY,
  project_id text REFERENCES projects(id) ON DELETE CASCADE,
  role       text NOT NULL CHECK (role IN ('user', 'main_agent', 'system')),
  content    text NOT NULL,
  data       jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS messages_project_idx ON messages (project_id, id);

CREATE TABLE IF NOT EXISTS audit_log (
  id          bigserial PRIMARY KEY,
  at          timestamptz NOT NULL DEFAULT now(),
  actor       text NOT NULL,
  action      text NOT NULL,
  target_type text NOT NULL,
  target_id   text,
  detail      jsonb
);

-- n8n executions reported back by the workflows, used to prove the visual
-- control plane reflects backend state.
CREATE TABLE IF NOT EXISTS workflow_runs (
  id           bigserial PRIMARY KEY,
  workflow     text NOT NULL,
  execution_id text NOT NULL,
  task_id      text REFERENCES tasks(id) ON DELETE CASCADE,
  project_id   text REFERENCES projects(id) ON DELETE CASCADE,
  step         text NOT NULL,
  status       text NOT NULL,
  at           timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS workflow_runs_task_idx ON workflow_runs (task_id);
