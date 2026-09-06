-- 0003_sync_cursors.sql — per-source incremental sync cursors (F-ING-2):
-- Drive changes-API page tokens, Slack per-channel latest ts, etc.
create table sync_cursors (
  source_id   uuid not null references sources(id),
  key         text not null,
  cursor      text not null,
  updated_at  timestamptz not null default now(),
  primary key (source_id, key)
);
