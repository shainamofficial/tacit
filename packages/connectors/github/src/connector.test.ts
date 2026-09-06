// Connector logic against the real Northwind git repo (built by the corpus
// generator) and the migrated dev database. Acceptance from the playbook:
// re-syncing an unchanged corpus performs zero model calls and zero row updates.
import path from 'node:path';
import { SyncStore } from '@tacit/connector-core';
import { CORPUS_DIR, MANIFEST_PATH, ensureCorpus } from '@tacit/evals/corpus';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FILE_PREFIX, PR_PREFIX, REPO_ID, backfillRepo, isSyncablePath, parseCodeowners, renderPull, syncMergedPull } from './connector';
import { corpusGitHubApi, withOverrides } from './testing/corpus-api';

const url = process.env.DATABASE_URL;
const ref = { owner: 'northwind', repo: 'monorepo' };

describe('pure helpers', () => {
  it('isSyncablePath skips vendored dirs, lockfiles, and binaries', () => {
    expect(isSyncablePath('services/control-plane/src/auth.ts')).toBe(true);
    expect(isSyncablePath('README.md')).toBe(true);
    expect(isSyncablePath('node_modules/x/index.js')).toBe(false);
    expect(isSyncablePath('apps/web/node_modules/x/index.js')).toBe(false);
    expect(isSyncablePath('pnpm-lock.yaml')).toBe(false);
    expect(isSyncablePath('docs/diagram.png')).toBe(false);
  });

  it('parses CODEOWNERS', () => {
    expect(parseCodeowners('# c\n* @jenna-ortiz\nservices/billing-service/ @marcus-webb @sam-okafor\n\n')).toEqual([
      { pattern: '*', owners: ['@jenna-ortiz'] },
      { pattern: 'services/billing-service/', owners: ['@marcus-webb', '@sam-okafor'] },
    ]);
  });
});

describe.skipIf(!url)('GitHub connector against the Northwind repo (integration)', () => {
  let client: pg.Client;
  let sourceId: string;
  let store: SyncStore;
  const api = (() => {
    ensureCorpus(CORPUS_DIR, MANIFEST_PATH, () => undefined);
    return corpusGitHubApi({ repoDir: path.join(CORPUS_DIR, 'repo') });
  })();

  beforeAll(async () => {
    client = new pg.Client({ connectionString: url });
    await client.connect();
    await client.query('begin');
    const org = await client.query<{ id: string }>("insert into orgs (name) values ('gh-test') returning id");
    const src = await client.query<{ id: string }>("insert into sources (org_id, kind) values ($1, 'github') returning id", [org.rows[0]?.id]);
    sourceId = src.rows[0]?.id ?? '';
    store = new SyncStore(client);
  }, 60_000);

  afterAll(async () => {
    await client.query('rollback');
    await client.end();
  });

  it('backfills repo, files, PRs with CODEOWNERS and ACL, with zero quarantines on clean code', async () => {
    const stats = await backfillRepo(api, store, { sourceId, ref });
    expect(stats.inserted).toBe(stats.seen);
    expect(stats.updated + stats.unchanged + stats.deleted).toBe(0);
    expect(stats.quarantined).toBe(0);

    const repo = await store.get(sourceId, REPO_ID);
    expect(repo?.kind).toBe('repo');
    expect(repo?.content).toContain('services/fleet-agent/: @jenna-ortiz');
    expect(repo?.acl.kind).toBe('users');
    expect((repo?.acl as { emails: string[] }).emails).toContain('github:dev-patel');
    expect((repo?.meta as { codeowners: unknown[] }).codeowners.length).toBeGreaterThan(3);

    const files = await store.listActive(sourceId, 'file');
    expect(files.length).toBeGreaterThan(30);
    const auth = await store.get(sourceId, `${FILE_PREFIX}services/control-plane/src/auth.ts`);
    expect(auth?.content).toContain("export const AUTH_SCHEME = 'oauth2_client_credentials' as const;");

    const prs = await store.listActive(sourceId, 'pull_request');
    expect(prs).toHaveLength(150);
    const pr196 = await store.get(sourceId, `${PR_PREFIX}196`); // ordinal 96 → PR #196: "remove legacy key auth"
    expect(pr196?.title).toBe('#196 remove legacy key auth');
    expect(pr196?.content).toContain('services/control-plane/src/auth.ts (modified)');
    expect(pr196?.content).toContain('(APPROVED)');
    expect((pr196?.meta as { author: string }).author).toBe('omar-haddad');
  }, 120_000);

  it('re-syncing the unchanged repo performs zero row updates (acceptance)', async () => {
    const before = await client.query<{ max: Date | null; n: string }>('select max(updated_at) as max, count(*)::text as n from sync_items where source_id = $1', [sourceId]);
    const stats = await backfillRepo(api, store, { sourceId, ref });
    expect(stats.unchanged).toBe(stats.seen);
    expect(stats.inserted + stats.updated + stats.deleted + stats.quarantined).toBe(0);
    const after = await client.query<{ max: Date | null; n: string }>('select max(updated_at) as max, count(*)::text as n from sync_items where source_id = $1', [sourceId]);
    expect(after.rows[0]?.max?.getTime()).toBe(before.rows[0]?.max?.getTime());
    expect(after.rows[0]?.n).toBe(before.rows[0]?.n);
  }, 120_000);

  it('a merge webhook syncs only the touched files, deletes removed ones, and quarantines a leaked secret', async () => {
    const changedPath = 'services/control-plane/src/config.ts';
    const removedPath = 'services/control-plane/src/pagination.ts';
    const newPath = 'services/control-plane/src/secrets.ts';
    const leaked = 'ghp_abcdefghijklmnopqrstuvwxyz0123456789ABCD';
    const pull = {
      number: 999,
      title: 'chore: rotate config',
      body: 'Rotates the token.',
      author: 'omar-haddad',
      mergedAt: '2026-09-01T10:00:00Z',
      mergeCommitSha: 'deadbeef',
      baseRef: 'main',
      htmlUrl: 'https://github.example/northwind/monorepo/pull/999',
      reviews: [],
      comments: [],
      files: [
        { path: changedPath, status: 'modified' as const },
        { path: removedPath, status: 'removed' as const },
        { path: newPath, status: 'added' as const },
        { path: 'docs/diagram.png', status: 'added' as const },
      ],
    };
    const patched = withOverrides(api, {
      pull,
      files: {
        [changedPath]: "export const config = { region: 'eu-central-1' } as const;\n",
        [newPath]: `export const GITHUB_TOKEN = '${leaked}';\n`,
      },
    });
    const snapshot = async (): Promise<Map<string, string>> => {
      const rows = await client.query<{ external_id: string; stamp: string }>(
        "select external_id, updated_at::text || coalesce(deleted_at::text, '') as stamp from sync_items where source_id = $1",
        [sourceId],
      );
      return new Map(rows.rows.map((r) => [r.external_id, r.stamp]));
    };
    const before = await snapshot();

    const stats = await syncMergedPull(patched, store, { sourceId, ref }, { ref, number: 999, title: pull.title, mergeCommitSha: 'deadbeef', baseRef: 'main', htmlUrl: pull.htmlUrl });
    expect(stats).toMatchObject({ inserted: 2, updated: 1, deleted: 1, quarantined: 1 });

    expect((await store.get(sourceId, `${FILE_PREFIX}${changedPath}`))?.content).toContain('eu-central-1');
    expect((await store.get(sourceId, `${FILE_PREFIX}${removedPath}`))?.deletedAt).not.toBeNull();
    const secretFile = await store.get(sourceId, `${FILE_PREFIX}${newPath}`);
    expect(secretFile?.content).not.toContain(leaked);
    expect(secretFile?.content).toMatch(/\[SECRET:[0-9a-f-]{36}\]/);
    expect(await store.get(sourceId, `${FILE_PREFIX}docs/diagram.png`)).toBeNull();
    expect((await store.get(sourceId, `${PR_PREFIX}999`))?.content).toBe(renderPull(pull));

    // Only the touched rows moved: 3 files + 1 PR, nothing else.
    const after = await snapshot();
    const changed = [...after.entries()].filter(([id, stamp]) => before.get(id) !== stamp).map(([id]) => id).sort();
    expect(changed).toEqual([`${FILE_PREFIX}${changedPath}`, `${FILE_PREFIX}${newPath}`, `${FILE_PREFIX}${removedPath}`, `${PR_PREFIX}999`].sort());
  }, 60_000);
});
