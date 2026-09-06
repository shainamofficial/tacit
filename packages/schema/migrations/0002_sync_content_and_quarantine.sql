-- 0002_sync_content_and_quarantine.sql — content storage for sync items and the
-- secrets quarantine (F-ING-5, CLAUDE.md #6). Content stored in sync_item_content
-- is always the REDACTED text: each flagged span is replaced by
-- [SECRET:<quarantined_spans.id>] and the secret bytes are never persisted.

alter table sync_items
  add column kind        text not null default 'item',      -- repo | file | pull_request | doc | message | ticket | macro
  add column title       text not null default '',
  add column meta        jsonb not null default '{}'::jsonb,
  add column created_at  timestamptz not null default now();
create index sync_items_source_kind_idx on sync_items (source_id, kind) where deleted_at is null;

create table sync_item_content (
  sync_item_id    uuid primary key references sync_items(id),
  content         text not null,
  byte_length     integer not null,
  redacted_spans  integer not null default 0,
  updated_at      timestamptz not null default now()
);

create table quarantined_spans (
  id            uuid primary key default gen_random_uuid(),
  sync_item_id  uuid not null references sync_items(id),
  detector      text not null,
  span          int4range not null,   -- offsets into the raw content version identified by content_hash
  content_hash  text not null,
  created_at    timestamptz not null default now()
);
create index quarantined_spans_item_idx on quarantined_spans (sync_item_id);
