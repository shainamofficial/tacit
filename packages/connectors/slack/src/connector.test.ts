import { readFileSync } from 'node:fs';
import { SyncCursors, SyncStore } from '@tacit/connector-core';
import { CORPUS_DIR, MANIFEST_PATH, ensureCorpus } from '@tacit/evals/corpus';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CHANNEL_PREFIX, MSG_PREFIX, conversationInScope, cursorKey, indexUsers, renderThread, syncSlack } from './connector';
import { corpusSlackApi } from './testing/corpus-api';

const url = process.env.DATABASE_URL;
const DOMAIN = 'northwindrobotics.example';

const conv = (over: Partial<Parameters<typeof conversationInScope>[0]> = {}) => ({ id: 'C1', name: 'eng', isPrivate: false, isArchived: false, isIm: false, isMpim: false, topic: '', purpose: '', ...over });

describe('scoping and rendering', () => {
  it('conversationInScope honors archived, DM, include, and exclude rules (F-ING-4)', () => {
    const base = { sourceId: 's', domain: DOMAIN };
    expect(conversationInScope(conv(), base)).toBe(true);
    expect(conversationInScope(conv({ isArchived: true }), base)).toBe(false);
    expect(conversationInScope(conv({ isIm: true }), { ...base, includeDms: false })).toBe(false);
    expect(conversationInScope(conv(), { ...base, include: ['#eng'] })).toBe(true);
    expect(conversationInScope(conv(), { ...base, include: ['C1'] })).toBe(true);
    expect(conversationInScope(conv(), { ...base, include: ['sales'] })).toBe(false);
    expect(conversationInScope(conv(), { ...base, exclude: ['eng'] })).toBe(false);
  });

  it('renders a thread with timestamps, names, and reply markers', () => {
    const users = indexUsers([{ id: 'U1', name: 'jenna', realName: 'Jenna Ortiz', email: 'j@x', isBot: false, deleted: false }]);
    const text = renderThread(conv(), [
      { ts: '1770109200.000001', user: 'U1', text: 'inc opened', replyCount: 1 },
      { ts: '1770109500.000002', user: 'U9', text: 'looking', threadTs: '1770109200.000001' },
    ], users);
    expect(text).toBe('#eng\n[2026-02-03 09:00 UTC] Jenna Ortiz: inc opened\n  ↳ [2026-02-03 09:05 UTC] U9: looking\n');
    expect(users.principal('U1')).toBe('j@x');
    expect(users.principal('U9')).toBe('slack:U9');
  });
});

describe.skipIf(!url)('Slack connector against the Northwind export (integration)', () => {
  let client: pg.Client;
  let sourceId: string;
  let store: SyncStore;
  let cursors: SyncCursors;
  const api = (() => {
    ensureCorpus(CORPUS_DIR, MANIFEST_PATH, () => undefined);
    return corpusSlackApi(CORPUS_DIR);
  })();
  const manifest = JSON.parse(readFileSync(MANIFEST_PATH, 'utf8')) as { defects: Array<{ id: string; sources: Array<{ kind: string; conversation?: string; ts?: string; quote?: string }> }> };

  beforeAll(async () => {
    client = new pg.Client({ connectionString: url });
    await client.connect();
    await client.query('begin');
    const org = await client.query<{ id: string }>("insert into orgs (name) values ('slack-test') returning id");
    const src = await client.query<{ id: string }>("insert into sources (org_id, kind) values ($1, 'slack') returning id", [org.rows[0]?.id]);
    sourceId = src.rows[0]?.id ?? '';
    store = new SyncStore(client);
    cursors = new SyncCursors(client);
  });

  afterAll(async () => {
    await client.query('rollback');
    await client.end();
  });

  const opts = () => ({ sourceId, domain: DOMAIN });

  it('backfills every conversation with membership ACLs, threads intact, zero quarantines', async () => {
    const stats = await syncSlack(api, store, cursors, opts());
    expect(stats.inserted).toBe(stats.seen);
    expect(stats.quarantined).toBe(0);
    expect((await store.listActive(sourceId, 'channel')).length).toBe(9);

    // root messages across all conversations = message items
    let roots = 0;
    for (const c of api.conversations) roots += (await api.history(c.id, {})).filter((m) => !m.subtype).length;
    expect((await store.listActive(sourceId, 'message')).length).toBe(roots);

    const exec = api.conversations.find((c) => c.name === 'exec');
    const execChannel = await store.get(sourceId, `${CHANNEL_PREFIX}${exec?.id}`);
    expect(execChannel?.acl).toEqual({ kind: 'users', emails: ['alice.chen@northwindrobotics.example', 'jenna.ortiz@northwindrobotics.example', 'sofia.reyes@northwindrobotics.example', 'tom.nakamura@northwindrobotics.example'] });
    const dm = await store.get(sourceId, `${CHANNEL_PREFIX}D0000001`);
    expect(dm?.acl).toEqual({ kind: 'users', emails: ['alice.chen@northwindrobotics.example', 'jenna.ortiz@northwindrobotics.example'] });
    const general = api.conversations.find((c) => c.name === 'general');
    expect((await store.get(sourceId, `${CHANNEL_PREFIX}${general?.id}`))?.acl).toEqual({ kind: 'domain', domain: DOMAIN });

    // T03's thread is one item carrying all three planted messages.
    const t03 = manifest.defects.find((d) => d.id === 'T03');
    const rootLoc = t03?.sources[0];
    const incidents = api.conversations.find((c) => c.name === rootLoc?.conversation);
    const thread = await store.get(sourceId, `${MSG_PREFIX}${incidents?.id}:${rootLoc?.ts}`);
    for (const s of t03?.sources ?? []) expect(thread?.content, s.quote).toContain(s.quote);
    expect((thread?.meta as { is_thread: boolean; reply_count: number }).is_thread).toBe(true);
    expect(thread?.acl).toEqual({ kind: 'domain', domain: DOMAIN });
    expect(thread?.title).toMatch(/^#incidents · \d{4}-\d{2}-\d{2} · Jenna Ortiz$/);

    // the P04 DM item is restricted to its two participants
    const p04 = manifest.defects.find((d) => d.id === 'P04')?.sources.find((s) => s.kind === 'slack');
    const dmItem = await store.get(sourceId, `${MSG_PREFIX}D0000001:${p04?.ts}`);
    expect(dmItem?.content).toContain('Postmortem for inc-2077');
    expect(dmItem?.acl.kind).toBe('users');
  }, 120_000);

  it('re-sync with cursors sees nothing; a forced full re-sync updates nothing (acceptance)', async () => {
    const before = await client.query<{ stamp: string }>("select string_agg(external_id || updated_at::text, ',' order by external_id) as stamp from sync_items where source_id = $1", [sourceId]);
    const incremental = await syncSlack(api, store, cursors, opts());
    expect(incremental.seen).toBe(9); // channel items only; no new messages
    expect(incremental.unchanged).toBe(9);

    const full = await syncSlack(api, store, cursors, { ...opts(), full: true });
    expect(full.unchanged).toBe(full.seen);
    expect(full.inserted + full.updated + full.deleted).toBe(0);
    const after = await client.query<{ stamp: string }>("select string_agg(external_id || updated_at::text, ',' order by external_id) as stamp from sync_items where source_id = $1", [sourceId]);
    expect(after.rows[0]?.stamp).toBe(before.rows[0]?.stamp);
  }, 120_000);

  it('incremental sync picks up only new messages and quarantines a pasted token', async () => {
    const eng = api.conversations.find((c) => c.name === 'eng');
    if (!eng) throw new Error('no #eng');
    const last = await cursors.get(sourceId, cursorKey(eng.id));
    const ts = `${Number(last?.split('.')[0]) + 3600}.000900`;
    api.append(eng.id, { ts, user: 'U0000009', text: 'staging token for the demo: xoxb-1234567890-abcdefghijklmnop' });

    const stats = await syncSlack(api, store, cursors, opts());
    expect(stats).toMatchObject({ inserted: 1, quarantined: 1, updated: 0 });
    const item = await store.get(sourceId, `${MSG_PREFIX}${eng.id}:${ts}`);
    expect(item?.content).not.toContain('xoxb-');
    expect(item?.content).toMatch(/\[SECRET:[0-9a-f-]{36}\]/);
    expect(await cursors.get(sourceId, cursorKey(eng.id))).toBe(ts);
  });

  it('channel scoping restricts what is synced (F-ING-4)', async () => {
    const scoped = await client.query<{ id: string }>("insert into sources (org_id, kind) select org_id, 'slack' from sources where id = $1 returning id", [sourceId]);
    const sid = scoped.rows[0]?.id ?? '';
    const stats = await syncSlack(api, store, cursors, { sourceId: sid, domain: DOMAIN, include: ['sales', 'billing'], includeDms: false });
    expect((await store.listActive(sid, 'channel')).length).toBe(2);
    expect(stats.seen).toBeGreaterThan(2);
    const exec = await client.query<{ n: string }>("select count(*)::text as n from sync_items where source_id = $1 and acl->>'kind' = 'users'", [sid]);
    expect(exec.rows[0]?.n).toBe('0');
  }, 120_000);
});
