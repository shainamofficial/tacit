import { SyncCursors, SyncStore } from '@tacit/connector-core';
import { CORPUS_DIR, MANIFEST_PATH, ensureCorpus } from '@tacit/evals/corpus';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CURSOR_KEY, FILE_PREFIX, aclFromPermissions, backfillDrive, fileInScope, syncDriveChanges } from './connector';
import { corpusDriveApi } from './testing/corpus-api';

const url = process.env.DATABASE_URL;
const DOMAIN = 'northwindrobotics.example';

describe('aclFromPermissions (F-ING-3)', () => {
  it('maps domain / anyone to domain-wide, users to users, and unreadable to nobody', () => {
    expect(aclFromPermissions([{ type: 'domain', domain: DOMAIN, role: 'reader' }], DOMAIN)).toEqual({ acl: { kind: 'domain', domain: DOMAIN }, unreadable: false });
    expect(aclFromPermissions([{ type: 'anyone', role: 'reader' }], DOMAIN).acl).toEqual({ kind: 'domain', domain: DOMAIN });
    expect(
      aclFromPermissions(
        [
          { type: 'user', emailAddress: 'tom.nakamura@x', role: 'owner' },
          { type: 'group', emailAddress: 'finance@x', role: 'reader' },
          { type: 'domain', domain: 'partner.example', role: 'reader' },
        ],
        DOMAIN,
      ).acl,
    ).toEqual({ kind: 'users', emails: ['tom.nakamura@x', 'group:finance@x', 'domain:partner.example'] });
    expect(aclFromPermissions(null, DOMAIN)).toEqual({ acl: { kind: 'users', emails: [] }, unreadable: true });
  });
});

describe('fileInScope (F-ING-4)', () => {
  const file = { id: '1', name: 'runbook.md', mimeType: 'x', modifiedTime: '', parents: [], folderPath: 'Engineering/Runbooks', permissions: [], trashed: false };
  it('matches folder paths by prefix and honors exclude over include', () => {
    expect(fileInScope(file, { sourceId: 's', domain: DOMAIN })).toBe(true);
    expect(fileInScope(file, { sourceId: 's', domain: DOMAIN, include: ['Engineering'] })).toBe(true);
    expect(fileInScope(file, { sourceId: 's', domain: DOMAIN, include: ['Sales'] })).toBe(false);
    expect(fileInScope(file, { sourceId: 's', domain: DOMAIN, include: ['Engineering'], exclude: ['Engineering/Runbooks'] })).toBe(false);
  });
});

describe.skipIf(!url)('Drive connector against the Northwind export (integration)', () => {
  let client: pg.Client;
  let sourceId: string;
  let store: SyncStore;
  let cursors: SyncCursors;
  const api = (() => {
    ensureCorpus(CORPUS_DIR, MANIFEST_PATH, () => undefined);
    return corpusDriveApi(CORPUS_DIR);
  })();

  beforeAll(async () => {
    client = new pg.Client({ connectionString: url });
    await client.connect();
    await client.query('begin');
    const org = await client.query<{ id: string }>("insert into orgs (name) values ('drive-test') returning id");
    const src = await client.query<{ id: string }>("insert into sources (org_id, kind) values ($1, 'gdrive') returning id", [org.rows[0]?.id]);
    sourceId = src.rows[0]?.id ?? '';
    store = new SyncStore(client);
    cursors = new SyncCursors(client);
  });

  afterAll(async () => {
    await client.query('rollback');
    await client.end();
  });

  const opts = () => ({ sourceId, domain: DOMAIN });

  it('backfills 40 docs with the right ACLs and zero quarantines', async () => {
    const stats = await backfillDrive(api, store, cursors, opts());
    expect(stats).toMatchObject({ seen: 40, inserted: 40, updated: 0, unchanged: 0, deleted: 0, quarantined: 0 });
    expect(await cursors.get(sourceId, CURSOR_KEY)).toBe('0');

    const docs = api.docs;
    const compBands = docs.find((d) => d.name === 'Compensation Bands 2026');
    const item = await store.get(sourceId, `${FILE_PREFIX}${compBands?.id}`);
    expect(item?.acl).toEqual({ kind: 'users', emails: ['alice.chen@northwindrobotics.example', 'jenna.ortiz@northwindrobotics.example', 'sofia.reyes@northwindrobotics.example', 'tom.nakamura@northwindrobotics.example'] });
    expect(item?.content).toContain('Engineering L4 band');
    expect((item?.meta as { path: string }).path).toBe('Exec-Restricted/Compensation Bands 2026');

    const handbook = docs.find((d) => d.name === 'Employee Handbook');
    expect((await store.get(sourceId, `${FILE_PREFIX}${handbook?.id}`))?.acl).toEqual({ kind: 'domain', domain: DOMAIN });

    const restricted = await client.query<{ n: string }>("select count(*)::text as n from sync_items where source_id = $1 and acl->>'kind' = 'users'", [sourceId]);
    expect(restricted.rows[0]?.n).toBe('5');
  });

  it('re-running the backfill performs zero row updates (acceptance)', async () => {
    const before = await client.query<{ stamp: string }>("select string_agg(external_id || updated_at::text, ',' order by external_id) as stamp from sync_items where source_id = $1", [sourceId]);
    const stats = await backfillDrive(api, store, cursors, opts());
    expect(stats).toMatchObject({ seen: 40, unchanged: 40, inserted: 0, updated: 0, deleted: 0 });
    const after = await client.query<{ stamp: string }>("select string_agg(external_id || updated_at::text, ',' order by external_id) as stamp from sync_items where source_id = $1", [sourceId]);
    expect(after.rows[0]?.stamp).toBe(before.rows[0]?.stamp);
  });

  it('delta sync applies only the changes since the cursor, then is a no-op', async () => {
    const [changed, removed] = api.docs.filter((d) => d.folderPath === 'Sales');
    if (!changed || !removed) throw new Error('need two Sales docs');
    api.update(changed.id, '# Pricing Sheet 2026\n\nAll prices doubled.\n');
    api.remove(removed.id);

    const stats = await syncDriveChanges(api, store, cursors, opts());
    expect(stats).toMatchObject({ seen: 1, updated: 1, deleted: 1, inserted: 0 });
    expect((await store.get(sourceId, `${FILE_PREFIX}${changed.id}`))?.content).toContain('doubled');
    expect((await store.get(sourceId, `${FILE_PREFIX}${removed.id}`))?.deletedAt).not.toBeNull();
    expect(await cursors.get(sourceId, CURSOR_KEY)).toBe('2');

    const again = await syncDriveChanges(api, store, cursors, opts());
    expect(again).toMatchObject({ seen: 0, updated: 0, deleted: 0 });
  });

  it('folder scoping excludes restricted folders when asked (F-ING-4)', async () => {
    const scopedSource = await client.query<{ id: string }>("insert into sources (org_id, kind) select org_id, 'gdrive' from sources where id = $1 returning id", [sourceId]);
    const sid = scopedSource.rows[0]?.id ?? '';
    const stats = await backfillDrive(api, store, cursors, { sourceId: sid, domain: DOMAIN, exclude: ['Exec-Restricted', 'Finance-Restricted'] });
    expect(stats.seen).toBe(34); // 40 - 5 restricted - 1 removed above
    const restricted = await client.query<{ n: string }>("select count(*)::text as n from sync_items where source_id = $1 and acl->>'kind' = 'users'", [sid]);
    expect(restricted.rows[0]?.n).toBe('0');
  });
});
