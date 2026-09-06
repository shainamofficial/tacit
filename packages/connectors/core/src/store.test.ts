// Integration against the migrated dev database; every test runs in a
// transaction that is rolled back.
import pg from 'pg';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SyncStore, contentHash } from './store';

const url = process.env.DATABASE_URL;

describe.skipIf(!url)('SyncStore (integration; needs DATABASE_URL, migrated)', () => {
  let client: pg.Client;
  let sourceId: string;
  let store: SyncStore;

  beforeEach(async () => {
    client = new pg.Client({ connectionString: url });
    await client.connect();
    await client.query('begin');
    const org = await client.query<{ id: string }>("insert into orgs (name) values ('store-test') returning id");
    const src = await client.query<{ id: string }>("insert into sources (org_id, kind) values ($1, 'github') returning id", [org.rows[0]?.id]);
    sourceId = src.rows[0]?.id ?? '';
    store = new SyncStore(client);
  });

  afterEach(async () => {
    await client.query('rollback');
    await client.end();
  });

  const acl = { kind: 'users' as const, emails: ['github:jenna-ortiz'] };

  it('inserts, dedups by content hash, updates on change, soft-deletes, and undeletes (F-ING-6)', async () => {
    const a = await store.upsert({ sourceId, externalId: 'file:README.md', kind: 'file', title: 'README.md', content: '# hi\n', acl });
    expect(a.outcome).toBe('inserted');

    const b = await store.upsert({ sourceId, externalId: 'file:README.md', kind: 'file', title: 'README.md', content: '# hi\n', acl });
    expect(b.outcome).toBe('unchanged');
    expect(b.itemId).toBe(a.itemId);

    const c = await store.upsert({ sourceId, externalId: 'file:README.md', kind: 'file', title: 'README.md', content: '# hello\n', acl });
    expect(c.outcome).toBe('updated');
    const item = await store.get(sourceId, 'file:README.md');
    expect(item?.content).toBe('# hello\n');
    expect(item?.contentHash).toBe(contentHash('# hello\n'));

    expect(await store.markDeleted(sourceId, 'file:README.md')).toBe(true);
    expect(await store.markDeleted(sourceId, 'file:README.md')).toBe(false);
    expect(await store.listActive(sourceId)).toEqual([]);

    const d = await store.upsert({ sourceId, externalId: 'file:README.md', kind: 'file', title: 'README.md', content: '# hello\n', acl });
    expect(d.outcome).toBe('updated'); // same content, but it was deleted: undelete counts as a write
    expect((await store.get(sourceId, 'file:README.md'))?.deletedAt).toBeNull();
  });

  it('treats an ACL change as an update even when content is unchanged (F-ING-3)', async () => {
    await store.upsert({ sourceId, externalId: 'x', kind: 'file', title: 'x', content: 'same', acl });
    const r = await store.upsert({ sourceId, externalId: 'x', kind: 'file', title: 'x', content: 'same', acl: { kind: 'users', emails: ['github:jenna-ortiz', 'github:dev-patel'] } });
    expect(r.outcome).toBe('updated');
    expect((await store.get(sourceId, 'x'))?.acl).toEqual({ kind: 'users', emails: ['github:dev-patel', 'github:jenna-ortiz'] });
    const again = await store.upsert({ sourceId, externalId: 'x', kind: 'file', title: 'x', content: 'same', acl: { kind: 'users', emails: ['github:dev-patel', 'github:jenna-ortiz'] } });
    expect(again.outcome).toBe('unchanged');
  });

  it('quarantines secrets by id and never stores the secret bytes (F-ING-5)', async () => {
    const secret = 'AKIAIOSFODNN7EXAMPLE';
    const content = `region = us-east-1\naws_access_key_id = ${secret}\n`;
    const r = await store.upsert({ sourceId, externalId: 'file:config.ini', kind: 'file', title: 'config.ini', content, acl });
    expect(r.outcome).toBe('inserted');
    expect(r.quarantined).toBe(1);

    const item = await store.get(sourceId, 'file:config.ini');
    expect(item?.content).not.toContain(secret);
    expect(item?.content).toMatch(/aws_access_key_id = \[SECRET:[0-9a-f-]{36}\]/);
    expect(item?.redactedSpans).toBe(1);
    // the hash is of the raw content, so a rotated secret is seen as a change
    expect(item?.contentHash).toBe(contentHash(content));

    const spans = await client.query<{ detector: string; span: string; content_hash: string }>('select detector, span::text, content_hash from quarantined_spans where sync_item_id = $1', [r.itemId]);
    expect(spans.rows).toEqual([{ detector: 'aws_access_key', span: `[${content.indexOf(secret)},${content.indexOf(secret) + secret.length})`, content_hash: contentHash(content) }]);

    const anywhere = await client.query<{ n: string }>(
      `select count(*)::text as n from (
         select content as t from sync_item_content
         union all select detector from quarantined_spans
         union all select title from sync_items
       ) x where t like $1`,
      [`%${secret}%`],
    );
    expect(anywhere.rows[0]?.n).toBe('0');

    const again = await store.upsert({ sourceId, externalId: 'file:config.ini', kind: 'file', title: 'config.ini', content, acl });
    expect(again.outcome).toBe('unchanged');
    expect(again.quarantined).toBe(0);
    const count = await client.query<{ n: string }>('select count(*)::text as n from quarantined_spans where sync_item_id = $1', [r.itemId]);
    expect(count.rows[0]?.n).toBe('1');
  });

  it('is atomic: a failure mid-upsert leaves no partial item', async () => {
    const boom = new SyncStore(client, () => {
      throw new Error('scanner exploded');
    });
    await expect(boom.upsert({ sourceId, externalId: 'file:bad', kind: 'file', title: 'bad', content: 'x', acl })).rejects.toThrow('scanner exploded');
    expect(await store.get(sourceId, 'file:bad')).toBeNull();
    // the outer transaction is still usable after the savepoint rollback
    expect((await store.upsert({ sourceId, externalId: 'file:ok', kind: 'file', title: 'ok', content: 'x', acl })).outcome).toBe('inserted');
  });
});
