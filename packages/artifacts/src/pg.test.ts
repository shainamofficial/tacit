// Integration test against the dockerized Postgres (DATABASE_URL). Everything
// runs inside one transaction that is rolled back, so the dev database is
// untouched and the forbid-delete triggers are never tempted.
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PgArtifactStore, fromRow, toRow } from './pg';
import type { ServeArtifact } from './retrieve';

const url = process.env.DATABASE_URL;

describe('provenance row mapping', () => {
  it('rides commits on the github source kind with a prefix, both ways', () => {
    expect(toRow({ kind: 'github_commit', ref: 'abc' })).toEqual({ source_kind: 'github', external_ref: 'commit:abc' });
    expect(fromRow('github', 'commit:abc', null)).toEqual({ kind: 'github_commit', ref: 'abc' });
    expect(fromRow('gdrive', 'drive/x.md', 12)).toEqual({ kind: 'gdrive', ref: 'drive/x.md', line: 12 });
  });
});

describe.skipIf(!url)('PgArtifactStore (integration; needs DATABASE_URL)', () => {
  let client: pg.Client;
  let orgId: string;

  beforeAll(async () => {
    client = new pg.Client({ connectionString: url });
    await client.connect();
    await client.query('begin');
    const org = await client.query<{ id: string }>("insert into orgs (name) values ('artifacts-test') returning id");
    orgId = org.rows[0]?.id ?? '';
  });
  afterAll(async () => {
    await client?.query('rollback');
    await client?.end();
  });

  const card = (id: string, title: string, over: Partial<ServeArtifact> = {}): ServeArtifact => ({
    id,
    type: 'qa_fact',
    title,
    body_md: `${title} body`,
    claims: [{ text: `${title} claim`, confidence: 0.9, provenance: [{ kind: 'gdrive', ref: 'drive/x.md', line: 3 }, { kind: 'github_commit', ref: 'deadbeef' }] }],
    permission_scope: { require_all: ['gdrive:doc:x'] },
    verification_state: 'machine_consistent',
    ...over,
  });

  it('round-trips artifacts, claims, and provenance, and supersedes the previous machine card of the same title/scope', async () => {
    const store = new PgArtifactStore(client);
    const first = await store.saveCompiled(orgId, [card('c1', 'Refund window'), card('c2', 'Warranty', { permission_scope: { require_all: ['gdrive:doc:x', 'gdrive:doc:y'] } })]);
    expect(first.size).toBe(2);
    let live = await store.artifacts(orgId);
    expect(live.map((a) => a.title).sort()).toEqual(['Refund window', 'Warranty']);
    const refund = live.find((a) => a.title === 'Refund window');
    expect(refund?.claims[0]?.provenance).toEqual([{ kind: 'gdrive', ref: 'drive/x.md', line: 3 }, { kind: 'github_commit', ref: 'deadbeef' }]);
    expect(refund?.permission_scope.require_all).toEqual(['gdrive:doc:x']);

    // Recompile: same title and scope → the old row is superseded (never deleted), the new one is live.
    const second = await store.saveCompiled(orgId, [card('c1', 'Refund window', { body_md: 'now 14 days' })]);
    live = await store.artifacts(orgId);
    expect(live.filter((a) => a.title === 'Refund window').map((a) => a.body_md)).toEqual(['now 14 days']);
    const old = await client.query('select superseded_at, superseded_by from artifacts where id = $1', [first.get('c1')]);
    expect(old.rows[0]?.superseded_at).not.toBeNull();
    expect(old.rows[0]?.superseded_by).toBe(second.get('c1'));

    // A human-verified card is never superseded by the compiler (F-FRS-1).
    await client.query("update artifacts set verification_state = 'human_verified', verified_by = '{priya}' where id = $1", [second.get('c1')]);
    await store.saveCompiled(orgId, [card('c1', 'Refund window', { body_md: 'machine says 30 again' })]);
    live = await store.artifacts(orgId);
    const refunds = live.filter((a) => a.title === 'Refund window');
    expect(refunds.map((a) => a.verification_state).sort()).toEqual(['human_verified', 'machine_consistent']);
    expect(refunds.find((a) => a.verification_state === 'human_verified')?.verified_by).toEqual(['priya']);
  });
});
