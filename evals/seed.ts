// `pnpm seed:northwind` — load the Northwind corpus into the sync store as a
// connected, permission-approved org, so the whole path (connect → sync →
// compile → serve) runs end to end without OAuth apps. Items go through the
// real SyncStore (content hashes, ACL capture, secrets quarantine), with the
// same external refs, titles, and content the eval uses, so a compile from
// the database hits the stage cache the eval already paid for.
import path from 'node:path';
import pg from 'pg';
import { SyncStore, approvePatch, loadAclGroups, mapPermissions, type Db } from '@tacit/connector-core';
import { EVALS_ROOT, loadCorpus } from './src/corpus';

try {
  process.loadEnvFile(path.join(EVALS_ROOT, '..', '.env'));
} catch {
  // rely on the environment
}
const ORG_NAME = process.env.TACIT_SEED_ORG_NAME ?? 'Northwind Robotics';
const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error('DATABASE_URL is required');
  process.exit(2);
}

export interface SeedResult {
  readonly orgId: string;
  readonly sources: Record<string, string>;
  readonly inserted: number;
  readonly updated: number;
  readonly unchanged: number;
  readonly quarantined: number;
}

export async function seedNorthwind(db: Db, orgName = ORG_NAME, log: (msg: string) => void = () => undefined): Promise<SeedResult> {
  const corpus = loadCorpus({ log });
  const existing = await db.query<{ id: string }>('select id from orgs where name = $1 limit 1', [orgName]);
  let orgId = existing.rows[0]?.id;
  if (!orgId) {
    const created = await db.query<{ id: string }>('insert into orgs (name) values ($1) returning id', [orgName]);
    orgId = created.rows[0]?.id;
  }
  if (!orgId) throw new Error('could not create the seed org');

  const sources: Record<string, string> = {};
  for (const kind of ['slack', 'gdrive', 'github', 'zendesk'] as const) {
    const found = await db.query<{ id: string }>("select id from sources where org_id = $1 and kind = $2 and status <> 'disconnected' order by created_at limit 1", [orgId, kind]);
    let id = found.rows[0]?.id;
    if (!id) {
      const created = await db.query<{ id: string }>("insert into sources (org_id, kind, oauth_ref, status, scope_config) values ($1, $2, 'seed:northwind', 'connected', '{}') returning id", [orgId, kind]);
      id = created.rows[0]?.id;
    }
    if (!id) throw new Error(`could not create the ${kind} source`);
    sources[kind] = id;
  }

  const store = new SyncStore(db);
  const counts = { inserted: 0, updated: 0, unchanged: 0, quarantined: 0 };
  for (const item of corpus.items) {
    const sourceKind = item.source === 'github_commit' ? 'github' : item.source;
    const sourceId = sources[sourceKind];
    if (!sourceId) continue;
    const result = await store.upsert({
      sourceId,
      externalId: item.external_ref,
      kind: item.kind ?? 'item',
      title: item.title,
      content: item.content,
      acl: item.acl,
      meta: { scope_key: item.scope_key, corpus: 'northwind' },
      updatedAt: new Date(item.modified_at),
    });
    counts[result.outcome] += 1;
    counts.quarantined += result.quarantined;
  }

  // Approve the permission mapping of every source, as the admin would after reviewing it.
  const org = await db.query<{ settings: Record<string, unknown> }>('select settings from orgs where id = $1', [orgId]);
  let settings = org.rows[0]?.settings ?? {};
  for (const id of Object.values(sources)) {
    const mapping = mapPermissions(await loadAclGroups(db, id));
    settings = { ...settings, ...approvePatch(settings, id, mapping.digest, 'seed') };
  }
  await db.query('update orgs set settings = settings || $2::jsonb where id = $1', [orgId, JSON.stringify({ permission_review: (settings as { permission_review: unknown }).permission_review })]);

  return { orgId, sources, ...counts };
}

const pool = new pg.Pool({ connectionString: databaseUrl });
try {
  const result = await seedNorthwind(pool, ORG_NAME, (msg) => console.error(msg));
  console.log(JSON.stringify(result, null, 2));
} finally {
  await pool.end();
}
