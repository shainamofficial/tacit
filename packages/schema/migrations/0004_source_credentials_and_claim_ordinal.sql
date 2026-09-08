-- 0004_source_credentials_and_claim_ordinal.sql
--
-- 1. source_credentials: sealed OAuth tokens for the connect flow (F-ADM-1,
--    F-ING-1). sources.oauth_ref is a reference into this table ("pg:<id>"),
--    never the token. Rows hold AES-256-GCM ciphertext under TACIT_MASTER_KEY
--    (apps/admin/src/credentials.ts); the plaintext never touches Postgres.
--    Revocation is a timestamp, not a delete, so an audit can see what was
--    connected when.
-- 2. claims.ordinal / provenance.ordinal: artifact bodies cite claims by
--    position ([c1], [c2]…). The read path currently relies on physical row
--    order of never-updated rows; an explicit ordinal makes the order a fact.

create table source_credentials (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references orgs(id),
  kind        text not null check (kind in ('slack', 'gdrive', 'github', 'zendesk')),
  ciphertext  text not null,
  created_at  timestamptz not null default now(),
  revoked_at  timestamptz
);
create index source_credentials_org_idx on source_credentials (org_id) where revoked_at is null;

alter table claims     add column ordinal integer;
alter table provenance add column ordinal integer;
create index claims_artifact_ordinal_idx on claims (artifact_id, ordinal);
