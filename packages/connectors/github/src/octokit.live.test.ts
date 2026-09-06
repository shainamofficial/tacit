// Live tests for the Octokit adapter against a real repository. Skipped unless
// GITHUB_SMOKE_REPO (owner/name) and GITHUB_TOKEN are set. The canonical
// target is shainamofficial/tacit-connector-smoke: the synthetic Northwind
// monorepo pushed as-is, plus one merged PR (#1) with a review comment.
//
// Every call the adapter makes is exercised, and the tree it returns is
// cross-checked against the local Northwind repo served by the offline fake.
import path from 'node:path';
import { SyncStore } from '@tacit/connector-core';
import { CORPUS_DIR, MANIFEST_PATH, ensureCorpus } from '@tacit/evals/corpus';
import { Octokit } from 'octokit';
import pg from 'pg';
import { describe, expect, it } from 'vitest';
import { FILE_PREFIX, PR_PREFIX, backfillRepo, isSyncablePath } from './connector';
import { OctokitGitHubApi } from './octokit';
import { corpusGitHubApi } from './testing/corpus-api';

const smokeRepo = process.env.GITHUB_SMOKE_REPO;
const token = process.env.GITHUB_TOKEN;
const dbUrl = process.env.DATABASE_URL;

describe.skipIf(!smokeRepo || !token)('OctokitGitHubApi (live; needs GITHUB_SMOKE_REPO + GITHUB_TOKEN)', () => {
  const [owner = '', repo = ''] = (smokeRepo ?? '').split('/');
  const ref = { owner, repo };
  const api = new OctokitGitHubApi(new Octokit({ auth: token }));

  it('reads repo metadata', async () => {
    const info = await api.getRepo(ref);
    expect(info.fullName.toLowerCase()).toBe(smokeRepo?.toLowerCase());
    expect(info.defaultBranch).toBe('main');
    expect(info.private).toBe(true);
    expect(info.htmlUrl).toContain(repo);
  }, 30_000);

  it('lists the same blobs as the local Northwind repo and decodes them identically', async () => {
    ensureCorpus(CORPUS_DIR, MANIFEST_PATH, () => undefined);
    const local = corpusGitHubApi({ repoDir: path.join(CORPUS_DIR, 'repo') });
    const [remoteTree, localTree] = await Promise.all([api.listTree(ref, 'main'), local.listTree(ref, 'main')]);
    const remotePaths = new Set(remoteTree.map((t) => t.path));
    for (const t of localTree) expect(remotePaths.has(t.path), t.path).toBe(true);
    expect(remoteTree.length).toBe(localTree.length);

    const codeowners = remoteTree.find((t) => t.path === 'CODEOWNERS');
    expect(codeowners).toBeDefined();
    const text = await api.getBlobText(ref, codeowners?.sha ?? '');
    expect(text).toContain('services/fleet-agent/ @jenna-ortiz');
    expect(text).toBe(await local.getBlobText(ref, codeowners?.sha ?? ''));

    expect(await api.getFileText(ref, 'README.md', 'main')).toContain('# Northwind Robotics monorepo');
    expect(await api.getFileText(ref, 'does/not/exist.ts', 'main')).toBeNull();
  }, 120_000);

  it('lists merged PRs with reviews, files, and merge commit', async () => {
    const pulls = await api.listMergedPulls(ref, 'main');
    expect(pulls.length).toBeGreaterThanOrEqual(1);
    const smoke = pulls.find((p) => p.title.includes('smoke-test change'));
    expect(smoke).toBeDefined();
    expect(smoke?.mergeCommitSha).toMatch(/^[0-9a-f]{40}$/);
    expect(smoke?.mergedAt).toMatch(/^\d{4}-/);
    expect(smoke?.files.map((f) => f.path)).toEqual(['services/control-plane/CHANGELOG.md']);
    expect(smoke?.files[0]?.status).toBe('modified');
    expect(smoke?.reviews.some((r) => r.body?.includes('smoke test'))).toBe(true);

    const same = await api.getPull(ref, smoke?.number ?? 1);
    expect(same.number).toBe(smoke?.number);
    expect(same.files).toEqual(smoke?.files);
    expect(await api.getFileText(ref, 'services/control-plane/CHANGELOG.md', same.mergeCommitSha ?? 'main')).toContain('smoke-test change');
  }, 60_000);

  it('lists collaborators', async () => {
    const logins = await api.listCollaborators(ref);
    expect(logins.map((l) => l.toLowerCase())).toContain(owner.toLowerCase());
  }, 30_000);

  it.skipIf(!dbUrl)('backfills the live repo into the sync store and re-syncs with zero updates', async () => {
    const client = new pg.Client({ connectionString: dbUrl });
    await client.connect();
    try {
      await client.query('begin');
      const org = await client.query<{ id: string }>("insert into orgs (name) values ('gh-live') returning id");
      const src = await client.query<{ id: string }>("insert into sources (org_id, kind) values ($1, 'github') returning id", [org.rows[0]?.id]);
      const sourceId = src.rows[0]?.id ?? '';
      const store = new SyncStore(client);

      const first = await backfillRepo(api, store, { sourceId, ref });
      expect(first.inserted).toBe(first.seen);
      expect(first.quarantined).toBe(0);
      const files = await store.listActive(sourceId, 'file');
      const tree = await api.listTree(ref, 'main');
      expect(files.length).toBe(tree.filter((t) => isSyncablePath(t.path)).length);
      expect((await store.get(sourceId, `${FILE_PREFIX}CODEOWNERS`))?.content).toContain('@marcus-webb');
      const prs = await store.listActive(sourceId, 'pull_request');
      expect(prs.length).toBeGreaterThanOrEqual(1);
      expect((await store.get(sourceId, `${PR_PREFIX}1`))?.acl).toMatchObject({ kind: 'users' });

      const second = await backfillRepo(api, store, { sourceId, ref });
      expect(second.unchanged).toBe(second.seen);
      expect(second.inserted + second.updated + second.deleted).toBe(0);
    } finally {
      await client.query('rollback');
      await client.end();
    }
  }, 180_000);
});
