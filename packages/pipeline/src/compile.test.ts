// Integration: compile an org from the database with a fake pipeline, inside
// one rolled-back transaction. Covers the permission-review gate, scope-key
// fail-closed loading, artifact/claim/provenance persistence with ordinals,
// gap rows, and the pipeline_runs record.
import pg from 'pg';
import { SyncStore, approvePatch, loadAclGroups, mapPermissions } from '@tacit/connector-core';
import { PgArtifactStore, PgScopeResolver } from '@tacit/artifacts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { compileOrg } from './compile';
import type { EvalPipeline } from './contract';
import { loadItems } from './db-items';

const url = process.env.DATABASE_URL;

describe.skipIf(!url)('compileOrg (integration; needs DATABASE_URL)', () => {
  let client: pg.Client;
  let orgId = '';
  let approvedSource = '';
  let pendingSource = '';

  beforeAll(async () => {
    client = new pg.Client({ connectionString: url });
    await client.connect();
    await client.query('begin');
    orgId = (await client.query<{ id: string }>("insert into orgs (name) values ('compile-test') returning id")).rows[0]?.id ?? '';
    approvedSource = (await client.query<{ id: string }>("insert into sources (org_id, kind, status) values ($1, 'gdrive', 'connected') returning id", [orgId])).rows[0]?.id ?? '';
    pendingSource = (await client.query<{ id: string }>("insert into sources (org_id, kind, status) values ($1, 'slack', 'connected') returning id", [orgId])).rows[0]?.id ?? '';
    const store = new SyncStore(client);
    await store.upsert({ sourceId: approvedSource, externalId: 'file:pricing', kind: 'doc', title: 'Pricing sheet', content: 'Refunds: 30 days on all plans.', acl: { kind: 'domain', domain: 'x.example' }, meta: { scope_key: 'gdrive:doc:pricing' } });
    await store.upsert({ sourceId: approvedSource, externalId: 'file:comp', kind: 'doc', title: 'Comp bands', content: 'L3 $140k', acl: { kind: 'users', emails: ['alice@x.example'] }, meta: { scope_key: 'gdrive:doc:comp' } });
    await store.upsert({ sourceId: approvedSource, externalId: 'file:noscope', kind: 'doc', title: 'No scope', content: 'orphan', acl: { kind: 'domain', domain: 'x.example' }, meta: {} });
    await store.upsert({ sourceId: pendingSource, externalId: 'msg:C1:1.0', kind: 'message', title: '#billing', content: 'refund?', acl: { kind: 'domain', domain: 'x.example' }, meta: { scope_key: 'slack:channel:C1' } });
    const mapping = mapPermissions(await loadAclGroups(client, approvedSource));
    await client.query('update orgs set settings = settings || $2::jsonb where id = $1', [orgId, JSON.stringify(approvePatch({}, approvedSource, mapping.digest, 'test'))]);
  });
  afterAll(async () => {
    await client?.query('rollback');
    await client?.end();
  });

  it('loads live items with their ingest scope keys and skips items without one', async () => {
    const loaded = await loadItems(client, orgId);
    expect(loaded.items.map((i) => i.external_ref).sort()).toEqual(['file:comp', 'file:pricing', 'msg:C1:1.0']);
    expect(loaded.skipped_no_scope).toBe(1);
    expect(loaded.items.find((i) => i.external_ref === 'file:comp')?.scope_key).toBe('gdrive:doc:comp');
  });

  it('compiles only approved sources, persists artifacts with ordinals and gaps, and records the run', async () => {
    const pipeline: EvalPipeline = {
      stages: {
        extract: async (ctx) => ({ artifacts: [], findings: [], usage: { cost_usd: 0.25, model_calls: 1, in_tokens: 10, out_tokens: 5, cached_calls: 1 }, claims: ctx.items.map((i, n) => ({ id: `c${n}`, item_id: i.id, text: `${i.title} claim`, kind: 'policy' as const, subject: i.title.toLowerCase(), provenance: [{ kind: i.source, ref: i.external_ref, line: 1 }], confidence: 0.9, scope_key: i.scope_key, acl: i.acl, source: i.source, modified_at: i.modified_at })) }),
        draft: async (ctx) => ({
          artifacts: ctx.claims.map((c, n) => ({ id: `a${n}`, type: 'qa_fact', title: c.subject, body_md: `${c.text} [c1]`, claims: [{ text: c.text, provenance: c.provenance, confidence: c.confidence }, { text: `${c.text} (second)`, provenance: [], confidence: 0.6 }], permission_scope: { require_all: [c.scope_key] }, verification_state: 'unverified' as const })),
          findings: [{ kind: 'contradiction' as const, refs: [{ kind: 'gdrive' as const, ref: 'file:pricing', line: 1 }], summary: 'a planted conflict', suggested_knowers: ['alice@x.example'], confidence: 0.8 }],
          usage: { cost_usd: 0.5, model_calls: 2, in_tokens: 20, out_tokens: 10 },
        }),
      },
    };
    const result = await compileOrg({ db: client, orgId, budgetUsd: 5, pipeline });
    expect(result.status).toBe('succeeded');
    expect(result.sources.compiled).toEqual([approvedSource]);
    expect(result.sources.skipped).toEqual([{ id: pendingSource, reason: 'pending' }]);
    expect(result.items).toBe(2); // comp + pricing; the orphan has no scope key
    expect(result.artifacts).toBe(2);
    expect(result.findings).toBe(1);
    expect(result.cost_usd).toBeCloseTo(0.75, 5);
    expect(result.notes.join(' ')).toContain('no scope key');

    const store = new PgArtifactStore(client);
    const live = await store.artifacts(orgId);
    expect(live.map((a) => a.title).sort()).toEqual(['comp bands', 'pricing sheet']);
    const pricing = live.find((a) => a.title === 'pricing sheet');
    expect(pricing?.claims.map((c) => c.text)).toEqual(['Pricing sheet claim', 'Pricing sheet claim (second)']);
    expect(pricing?.permission_scope.require_all).toEqual(['gdrive:doc:pricing']);
    const ordinals = await client.query<{ ordinal: number }>('select c.ordinal from claims c join artifacts a on a.id = c.artifact_id where a.org_id = $1 order by c.ordinal', [orgId]);
    expect(ordinals.rows.map((r) => r.ordinal)).toEqual([0, 0, 1, 1]);

    const gaps = await client.query<{ kind: string; detail: { summary: string; run_id: string } }>('select kind, detail from gaps where org_id = $1', [orgId]);
    expect(gaps.rows).toHaveLength(1);
    expect(gaps.rows[0]).toMatchObject({ kind: 'contradiction', detail: { summary: 'a planted conflict', run_id: result.runId } });

    const run = await client.query<{ status: string; spent_usd: string; detail: { artifacts: number } }>('select status, spent_usd, detail from pipeline_runs where id = $1', [result.runId]);
    expect(run.rows[0]?.status).toBe('succeeded');
    expect(Number(run.rows[0]?.spent_usd)).toBeCloseTo(0.75, 3);
    expect(run.rows[0]?.detail.artifacts).toBe(2);

    // Serving from Postgres: sources behind a card come back with their scope, and users get their scope sets.
    const item = await store.item(orgId, { kind: 'gdrive', ref: 'file:pricing', line: 1 });
    expect(item).toMatchObject({ title: 'Pricing sheet', scope_key: 'gdrive:doc:pricing' });
    expect(await store.item(orgId, { kind: 'gdrive', ref: 'file:noscope' })).toBeUndefined();
    const scopes = new PgScopeResolver(client);
    expect([...(await scopes.scopesFor(orgId, 'lena@x.example'))].sort()).toEqual(['gdrive:doc:pricing', 'slack:channel:C1']);
    expect([...(await scopes.scopesFor(orgId, 'alice@x.example'))].sort()).toEqual(['gdrive:doc:comp', 'gdrive:doc:pricing', 'slack:channel:C1']);

    // A second compile supersedes the machine cards rather than duplicating them.
    const again = await compileOrg({ db: client, orgId, budgetUsd: 5, pipeline });
    expect(again.status).toBe('succeeded');
    expect((await store.artifacts(orgId)).length).toBe(2);
    const superseded = await client.query<{ n: string }>('select count(*)::text as n from artifacts where org_id = $1 and superseded_at is not null', [orgId]);
    expect(Number(superseded.rows[0]?.n)).toBe(2);
  });

  it('marks the run failed when a stage throws and keeps nothing half-written', async () => {
    const broken: EvalPipeline = { stages: { filter: async () => { throw new Error('boom'); } } };
    const result = await compileOrg({ db: client, orgId, budgetUsd: 5, pipeline: broken });
    expect(result.status).toBe('failed');
    expect(result.notes.join(' ')).toContain('stage filter failed: boom');
    const run = await client.query<{ status: string }>('select status from pipeline_runs where id = $1', [result.runId]);
    expect(run.rows[0]?.status).toBe('failed');
  });
});
