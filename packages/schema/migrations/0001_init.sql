-- 0001_init.sql — core schema from docs/implementation-plan.md §8 (artifact shape: PRD §13).
--
-- Requirements: F-ING-3 (ACL captured at ingest, NOT NULL), F-SEC-1 (permission_scope,
-- ACL intersection, NOT NULL), F-FRS-2 (bi-temporal validity; supersede, never delete),
-- F-CMP-2 (pipeline_runs budget caps), F-CMP-3 / F-CMP-5 (model_calls cost + cache logging),
-- F-INT-4 (interview rate-limit query index). Audit log (F-SEC-2) lands with the MCP server.
--
-- Conventions: uuid pks via gen_random_uuid() (core since PG13), timestamptz everywhere,
-- enum-ish text columns constrained by CHECK so a bad value fails at the boundary.

create extension if not exists vector;

create table orgs (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  -- admin-tunable knobs: interview limits, quiet hours, compile budgets (F-INT-4, F-ADM-2)
  settings    jsonb not null default '{}'::jsonb,
  created_at  timestamptz not null default now()
);

-- ---------------------------------------------------------------- sync layer

create table sources (
  id            uuid primary key default gen_random_uuid(),
  org_id        uuid not null references orgs(id),
  kind          text not null check (kind in ('slack', 'gdrive', 'github', 'zendesk')),
  oauth_ref     text,
  scope_config  jsonb not null default '{}'::jsonb,
  status        text not null default 'connected'
                check (status in ('connected', 'syncing', 'error', 'disconnected')),
  created_at    timestamptz not null default now()
);
create index sources_org_idx on sources (org_id);

create table sync_items (
  id            uuid primary key default gen_random_uuid(),
  source_id     uuid not null references sources(id),
  external_id   text not null,
  content_hash  text not null,
  acl           jsonb not null,          -- captured at ingest (F-ING-3); sync fails closed if unreadable
  raw_ref       text,
  updated_at    timestamptz not null default now(),
  deleted_at    timestamptz,
  unique (source_id, external_id)
);
create index sync_items_content_hash_idx on sync_items (content_hash);

-- ------------------------------------------------------------- artifacts (PRD §13)

create table artifacts (
  id                  uuid primary key default gen_random_uuid(),
  org_id              uuid not null references orgs(id),
  type                text not null check (type in (
                        'entity_card', 'decision_record', 'process_doc', 'service_card',
                        'api_surface', 'glossary_entry', 'qa_fact')),
  schema_version      text not null,
  title               text not null,
  body_md             text not null,
  verification_state  text not null default 'unverified' check (verification_state in (
                        'unverified', 'machine_consistent', 'human_verified', 'cross_validated')),
  verified_by         text[] not null default '{}',
  verified_at         timestamptz,
  -- world time (F-FRS-2)
  valid_from          timestamptz,
  valid_to            timestamptz,
  -- system time
  recorded_at         timestamptz not null default now(),
  superseded_at       timestamptz,
  superseded_by       uuid references artifacts(id),
  owner               text,
  permission_scope    jsonb not null,    -- {"require_all": [...]} (F-SEC-1)
  staleness           text not null default 'fresh' check (staleness in ('fresh', 'stale')),
  embedding           vector(1024),
  check (valid_from is null or valid_to is null or valid_to >= valid_from)
);
create index artifacts_org_live_idx on artifacts (org_id) where superseded_at is null;
create index artifacts_org_type_idx on artifacts (org_id, type);

create table claims (
  id           uuid primary key default gen_random_uuid(),
  artifact_id  uuid not null references artifacts(id),
  text         text not null,
  confidence   real not null check (confidence >= 0 and confidence <= 1)
);
create index claims_artifact_idx on claims (artifact_id);

create table provenance (
  id            uuid primary key default gen_random_uuid(),
  claim_id      uuid not null references claims(id),
  source_kind   text not null check (source_kind in ('slack', 'gdrive', 'github', 'zendesk')),
  external_ref  text not null,
  span          int4range,
  permalink     text,
  captured_at   timestamptz not null default now(),
  status        text not null default 'live' check (status in ('live', 'source_unavailable'))
);
create index provenance_claim_idx on provenance (claim_id);

-- Non-negotiable #5: supersede, never delete. Knowledge rows can only be hard-deleted by
-- GDPR tooling, which must disable these triggers explicitly and on purpose.
create function forbid_hard_delete() returns trigger language plpgsql as $$
begin
  raise exception 'Hard delete on % is forbidden: set valid_to / superseded_at instead (CLAUDE.md #5, F-FRS-2)',
    tg_table_name;
end
$$;
create trigger artifacts_forbid_delete  before delete on artifacts  for each row execute function forbid_hard_delete();
create trigger claims_forbid_delete     before delete on claims     for each row execute function forbid_hard_delete();
create trigger provenance_forbid_delete before delete on provenance for each row execute function forbid_hard_delete();

-- ---------------------------------------------------------- gaps & interviews

create table gaps (
  id            uuid primary key default gen_random_uuid(),
  org_id        uuid not null references orgs(id),
  kind          text not null check (kind in ('contradiction', 'low_confidence', 'query_miss', 'drift')),
  detail        jsonb not null default '{}'::jsonb,
  artifact_ids  uuid[] not null default '{}',
  state         text not null default 'open' check (state in ('open', 'in_progress', 'resolved', 'dismissed')),
  created_at    timestamptz not null default now(),
  resolved_at   timestamptz
);
create index gaps_org_state_idx on gaps (org_id, state);

create table interviews (
  id            uuid primary key default gen_random_uuid(),
  org_id        uuid not null references orgs(id),
  gap_id        uuid not null references gaps(id),
  knower        text not null,
  channel       text not null check (channel in ('slack', 'email', 'manual')),
  question      text not null,
  options       jsonb not null default '[]'::jsonb,
  why_you       text,
  sent_at       timestamptz,
  responded_at  timestamptz,
  response      jsonb,
  outcome       text
);
-- Rate-limit invariant (F-INT-4), enforced in the interview service for every channel:
--   count(interviews where org_id = O and knower = X and sent_at > now() - interval '7 days') < org limit
create index interviews_org_knower_sent_idx on interviews (org_id, knower, sent_at desc);
create index interviews_gap_idx on interviews (gap_id);

create table validation_graph (
  org_id         uuid not null references orgs(id),
  person         text not null,
  area           text not null,
  evidence       jsonb not null default '{}'::jsonb,
  response_rate  real,
  accuracy       real,
  last_asked     timestamptz,
  primary key (org_id, person, area)
);

-- ------------------------------------------------------------------------ ops

create table pipeline_runs (
  id           uuid primary key default gen_random_uuid(),
  org_id       uuid not null references orgs(id),
  kind         text not null check (kind in ('initial', 'incremental', 'eval')),
  status       text not null default 'queued'
               check (status in ('queued', 'running', 'succeeded', 'failed', 'budget_exceeded')),
  budget_usd   numeric(10, 4) not null,  -- per-run cap (F-CMP-2); hard-stop at cap
  spent_usd    numeric(10, 4) not null default 0,
  detail       jsonb not null default '{}'::jsonb,
  created_at   timestamptz not null default now(),
  started_at   timestamptz,
  finished_at  timestamptz
);
create index pipeline_runs_org_idx on pipeline_runs (org_id, created_at desc);

create table model_calls (
  id                 uuid primary key default gen_random_uuid(),
  run_id             uuid references pipeline_runs(id),
  org_id             uuid not null references orgs(id),
  stage              text not null,
  provider           text not null,
  model              text not null,
  in_tokens          integer not null default 0,
  out_tokens         integer not null default 0,
  cache_read_tokens  integer not null default 0,   -- F-CMP-5
  cache_write_tokens integer not null default 0,
  cost_usd           numeric(10, 6) not null default 0,
  latency_ms         integer not null default 0,
  edit_rate_signal   text,                          -- judge: approve | edit | escalate
  created_at         timestamptz not null default now()
);
create index model_calls_run_idx on model_calls (run_id);
create index model_calls_org_stage_idx on model_calls (org_id, stage, created_at desc);
