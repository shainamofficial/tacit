// GitHub connector: backfill and merge-triggered incremental sync into the
// sync store (F-ING-2, F-ING-3, F-ING-6, F-CODE-2). No model calls here, ever.
import { SyncStore, emptyStats, tally, type Acl, type SyncStats } from '@tacit/connector-core';
import type { GitHubApi, PullSummary, RepoInfo, RepoRef } from './api';
import type { MergeEvent } from './webhook';

export interface GitHubSyncOptions {
  readonly sourceId: string;
  readonly ref: RepoRef;
  /** Map a GitHub login to a principal; default keeps it as `github:<login>` (resolved by the identity map later). */
  readonly identity?: (login: string) => string;
  /** Skip blobs larger than this (default 512 KiB). */
  readonly maxFileBytes?: number;
  /** Structured log sink; never receives content. */
  readonly log?: (line: Record<string, unknown>) => void;
}

const DEFAULT_MAX_FILE_BYTES = 512 * 1024;

const SKIP_DIRS = ['node_modules/', 'dist/', 'build/', 'vendor/', '.git/', '.turbo/', '.next/', 'coverage/'];
const SKIP_FILES = new Set(['pnpm-lock.yaml', 'package-lock.json', 'yarn.lock', 'Cargo.lock', 'poetry.lock', 'Gemfile.lock', 'composer.lock']);
const BINARY_EXT = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.bmp', '.svg', '.pdf', '.zip', '.gz', '.tgz', '.tar', '.7z', '.rar',
  '.woff', '.woff2', '.ttf', '.otf', '.eot', '.mp3', '.mp4', '.mov', '.wav', '.jar', '.exe', '.dll', '.so', '.dylib',
  '.bin', '.class', '.pyc', '.wasm', '.psd', '.ai', '.sketch', '.fig', '.parquet', '.db', '.sqlite',
]);

export function isSyncablePath(path: string): boolean {
  if (SKIP_DIRS.some((d) => path.startsWith(d) || path.includes(`/${d}`))) return false;
  const name = path.slice(path.lastIndexOf('/') + 1);
  if (SKIP_FILES.has(name)) return false;
  const dot = name.lastIndexOf('.');
  const ext = dot >= 0 ? name.slice(dot).toLowerCase() : '';
  return !BINARY_EXT.has(ext);
}

export interface CodeownersRule {
  readonly pattern: string;
  readonly owners: readonly string[];
}

export function parseCodeowners(text: string): CodeownersRule[] {
  const rules: CodeownersRule[] = [];
  for (const raw of text.split('\n')) {
    const line = raw.replace(/#.*$/, '').trim();
    if (!line) continue;
    const [pattern, ...owners] = line.split(/\s+/);
    if (pattern && owners.length > 0) rules.push({ pattern, owners });
  }
  return rules;
}

export function renderPull(p: PullSummary): string {
  const lines = [
    `# PR #${p.number}: ${p.title}`,
    '',
    `Author: @${p.author} · Merged: ${p.mergedAt} · Base: ${p.baseRef}${p.mergeCommitSha ? ` · Merge commit: ${p.mergeCommitSha}` : ''}`,
    '',
    p.body?.trim() || '(no description)',
  ];
  if (p.reviews.length > 0) {
    lines.push('', '## Reviews');
    for (const r of p.reviews) lines.push(`- @${r.author} (${r.state})${r.body ? `: ${r.body}` : ''}`);
  }
  if (p.comments.length > 0) {
    lines.push('', '## Comments');
    for (const c of p.comments) lines.push(`- @${c.author} (${c.createdAt}): ${c.body}`);
  }
  if (p.files.length > 0) {
    lines.push('', '## Files');
    for (const f of p.files) lines.push(`- ${f.path} (${f.status}${f.previousPath ? ` from ${f.previousPath}` : ''})`);
  }
  return `${lines.join('\n')}\n`;
}

async function repoAcl(api: GitHubApi, opts: GitHubSyncOptions, repo: RepoInfo): Promise<Acl> {
  // A private repo is readable by its collaborators; a public one by everyone at the company.
  if (!repo.private) return { kind: 'domain', domain: 'public' };
  const identity = opts.identity ?? ((login: string) => `github:${login}`);
  const logins = await api.listCollaborators(opts.ref);
  return { kind: 'users', emails: logins.map(identity) };
}

export const FILE_PREFIX = 'file:';
export const PR_PREFIX = 'pr:';
export const REPO_ID = 'repo';

async function upsertRepoItem(store: SyncStore, opts: GitHubSyncOptions, repo: RepoInfo, acl: Acl, codeownersText: string | null, stats: SyncStats): Promise<void> {
  const codeowners = codeownersText ? parseCodeowners(codeownersText) : [];
  const content = [
    `# ${repo.fullName}`,
    '',
    repo.description ?? '(no description)',
    '',
    `Default branch: ${repo.defaultBranch}`,
    repo.topics.length ? `Topics: ${repo.topics.join(', ')}` : '',
    codeowners.length ? `\n## Code owners\n${codeowners.map((r) => `- ${r.pattern}: ${r.owners.join(' ')}`).join('\n')}` : '',
  ]
    .filter((l) => l !== '')
    .join('\n');
  tally(
    stats,
    await store.upsert({
      sourceId: opts.sourceId,
      externalId: REPO_ID,
      kind: 'repo',
      title: repo.fullName,
      content: `${content}\n`,
      acl,
      meta: { default_branch: repo.defaultBranch, private: repo.private, html_url: repo.htmlUrl, topics: repo.topics, codeowners },
    }),
  );
}

async function upsertPull(store: SyncStore, opts: GitHubSyncOptions, p: PullSummary, acl: Acl, stats: SyncStats): Promise<void> {
  tally(
    stats,
    await store.upsert({
      sourceId: opts.sourceId,
      externalId: `${PR_PREFIX}${p.number}`,
      kind: 'pull_request',
      title: `#${p.number} ${p.title}`,
      content: renderPull(p),
      acl,
      meta: {
        number: p.number,
        merged_at: p.mergedAt,
        merge_commit_sha: p.mergeCommitSha,
        author: p.author,
        reviewers: [...new Set(p.reviews.map((r) => r.author))],
        files: p.files.map((f) => f.path),
        html_url: p.htmlUrl,
      },
      updatedAt: new Date(p.mergedAt),
    }),
  );
}

/** Initial backfill: repo metadata + CODEOWNERS, every text file on the default branch, every merged PR. */
export async function backfillRepo(api: GitHubApi, store: SyncStore, opts: GitHubSyncOptions): Promise<SyncStats> {
  const stats = emptyStats();
  const log = opts.log ?? (() => undefined);
  const repo = await api.getRepo(opts.ref);
  const acl = await repoAcl(api, opts, repo);
  const maxBytes = opts.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;

  const tree = (await api.listTree(opts.ref, repo.defaultBranch)).filter((t) => isSyncablePath(t.path) && t.size <= maxBytes);
  const codeownersEntry = tree.find((t) => t.path === 'CODEOWNERS' || t.path === '.github/CODEOWNERS' || t.path === 'docs/CODEOWNERS');
  const codeownersText = codeownersEntry ? await api.getBlobText(opts.ref, codeownersEntry.sha) : null;
  await upsertRepoItem(store, opts, repo, acl, codeownersText, stats);

  const seenPaths = new Set<string>();
  for (const entry of tree) {
    const text = await api.getBlobText(opts.ref, entry.sha);
    if (text === null) continue;
    seenPaths.add(entry.path);
    tally(
      stats,
      await store.upsert({
        sourceId: opts.sourceId,
        externalId: `${FILE_PREFIX}${entry.path}`,
        kind: 'file',
        title: entry.path,
        content: text,
        acl,
        meta: { sha: entry.sha, size: entry.size, branch: repo.defaultBranch },
      }),
    );
  }

  for (const p of await api.listMergedPulls(opts.ref, repo.defaultBranch)) {
    await upsertPull(store, opts, p, acl, stats);
  }

  // Files that vanished from the branch since the last sync.
  for (const active of await store.listActive(opts.sourceId, 'file')) {
    const path = active.externalId.slice(FILE_PREFIX.length);
    if (!seenPaths.has(path) && (await store.markDeleted(opts.sourceId, active.externalId))) stats.deleted += 1;
  }

  log({ event: 'sync', source: 'github', repo: repo.fullName, mode: 'backfill', ...stats });
  return stats;
}

/** Incremental pass for one merged PR: only the files it touched, plus the PR itself. Never a full rescan (F-ING-2). */
export async function syncMergedPull(api: GitHubApi, store: SyncStore, opts: GitHubSyncOptions, event: MergeEvent): Promise<SyncStats> {
  const stats = emptyStats();
  const log = opts.log ?? (() => undefined);
  const repo = await api.getRepo(opts.ref);
  const acl = await repoAcl(api, opts, repo);
  const pull = await api.getPull(opts.ref, event.number);
  const at = pull.mergeCommitSha ?? repo.defaultBranch;
  const maxBytes = opts.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;

  for (const f of pull.files) {
    if (f.status === 'renamed' && f.previousPath && (await store.markDeleted(opts.sourceId, `${FILE_PREFIX}${f.previousPath}`))) stats.deleted += 1;
    if (f.status === 'removed') {
      if (await store.markDeleted(opts.sourceId, `${FILE_PREFIX}${f.path}`)) stats.deleted += 1;
      continue;
    }
    if (!isSyncablePath(f.path)) continue;
    const text = await api.getFileText(opts.ref, f.path, at);
    if (text === null || Buffer.byteLength(text, 'utf8') > maxBytes) continue;
    tally(
      stats,
      await store.upsert({
        sourceId: opts.sourceId,
        externalId: `${FILE_PREFIX}${f.path}`,
        kind: 'file',
        title: f.path,
        content: text,
        acl,
        meta: { branch: repo.defaultBranch, merge_commit_sha: pull.mergeCommitSha, pr: pull.number },
      }),
    );
    if (f.path === 'CODEOWNERS' || f.path === '.github/CODEOWNERS') await upsertRepoItem(store, opts, repo, acl, text, stats);
  }
  await upsertPull(store, opts, pull, acl, stats);

  log({ event: 'sync', source: 'github', repo: repo.fullName, mode: 'merge', pr: pull.number, ...stats });
  return stats;
}
