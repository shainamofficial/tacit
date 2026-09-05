import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { checksum, loadMigrations, migrate, resetSchema } from './migrate';

const baseUrl = process.env.DATABASE_URL;

// Integration tests run in a dedicated `tacit_test` database on the same server
// so they never wipe the dev database that DATABASE_URL points at.
function testDatabaseUrl(url: string): string {
  const u = new URL(url);
  u.pathname = '/tacit_test';
  return u.toString();
}

describe('checksum', () => {
  it('is line-ending agnostic', () => {
    expect(checksum('select 1;\r\nselect 2;')).toBe(checksum('select 1;\nselect 2;'));
  });
});

describe('loadMigrations', () => {
  it('lists migrations in order, starting with 0001_init.sql', async () => {
    const migrations = await loadMigrations();
    expect(migrations[0]?.name).toBe('0001_init.sql');
    expect(migrations.map((m) => m.name)).toEqual([...migrations.map((m) => m.name)].sort());
  });
});

describe.skipIf(!baseUrl)('migrate against Postgres (integration; needs DATABASE_URL)', () => {
  let client: pg.Client;

  beforeAll(async () => {
    const url = baseUrl as string;
    const admin = new pg.Client({ connectionString: url });
    await admin.connect();
    const exists = await admin.query("select 1 from pg_database where datname = 'tacit_test'");
    if (exists.rowCount === 0) await admin.query('create database tacit_test');
    await admin.end();

    client = new pg.Client({ connectionString: testDatabaseUrl(url) });
    await client.connect();
    await resetSchema(client);
  });

  afterAll(async () => {
    await client?.end();
  });

  it('applies 0001_init.sql cleanly and is a no-op on re-run', async () => {
    const first = await migrate(client);
    expect(first.applied).toEqual(['0001_init.sql']);
    expect(first.skipped).toEqual([]);

    const second = await migrate(client);
    expect(second.applied).toEqual([]);
    expect(second.skipped).toEqual(['0001_init.sql']);
  });

  it('creates every table from implementation-plan §8', async () => {
    const { rows } = await client.query<{ table_name: string }>(
      "select table_name from information_schema.tables where table_schema = 'public'",
    );
    const names = rows.map((r) => r.table_name);
    for (const table of [
      'orgs',
      'sources',
      'sync_items',
      'artifacts',
      'claims',
      'provenance',
      'gaps',
      'interviews',
      'validation_graph',
      'pipeline_runs',
      'model_calls',
    ]) {
      expect(names, `missing table ${table}`).toContain(table);
    }
  });

  it('refuses to proceed when an applied migration was edited', async () => {
    const [init] = await loadMigrations();
    if (!init) throw new Error('no migrations found');
    await expect(migrate(client, [{ ...init, checksum: 'tampered' }])).rejects.toThrow(
      /checksum mismatch/,
    );
  });

  it('forbids hard deletes of knowledge rows (CLAUDE.md #5, F-FRS-2)', async () => {
    const org = await client.query<{ id: string }>("insert into orgs (name) values ('t') returning id");
    const orgId = org.rows[0]?.id;
    const artifact = await client.query<{ id: string }>(
      `insert into artifacts (org_id, type, schema_version, title, body_md, permission_scope)
       values ($1, 'qa_fact', '0.3', 't', 't', '{"require_all": []}') returning id`,
      [orgId],
    );
    await expect(
      client.query('delete from artifacts where id = $1', [artifact.rows[0]?.id]),
    ).rejects.toThrow(/Hard delete on artifacts is forbidden/);
  });

  it('rejects an artifact without a permission_scope (F-SEC-1)', async () => {
    const org = await client.query<{ id: string }>("insert into orgs (name) values ('t2') returning id");
    await expect(
      client.query(
        `insert into artifacts (org_id, type, schema_version, title, body_md, permission_scope)
         values ($1, 'qa_fact', '0.3', 't', 't', null)`,
        [org.rows[0]?.id],
      ),
    ).rejects.toThrow(/permission_scope/);
  });
});
