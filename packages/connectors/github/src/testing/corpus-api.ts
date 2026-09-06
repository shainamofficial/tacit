// A GitHubApi served from a local git repository (the generated Northwind
// monorepo). PRs are synthesized from commit trailers ("PR #N",
// "Reviewed-by: Name") the way the corpus generator wrote them. Test-only.
import { execFileSync } from 'node:child_process';
import type { FileStatus, GitHubApi, PullSummary, RepoRef, TreeEntry } from '../api';

function git(cwd: string, args: string[]): Buffer {
  return execFileSync('git', args, { cwd, maxBuffer: 64 * 1024 * 1024 });
}

const handle = (name: string): string => name.trim().toLowerCase().replace(/\s+/g, '-');

function parseStatus(code: string): FileStatus {
  if (code.startsWith('A')) return 'added';
  if (code.startsWith('D')) return 'removed';
  if (code.startsWith('R')) return 'renamed';
  return 'modified';
}

export interface CorpusApiOptions {
  readonly repoDir: string;
  readonly branch?: string;
  readonly isPrivate?: boolean;
}

export function corpusGitHubApi(opts: CorpusApiOptions): GitHubApi & { readonly pulls: PullSummary[] } {
  const dir = opts.repoDir;
  const branch = opts.branch ?? 'main';

  const pulls: PullSummary[] = (() => {
    const raw = git(dir, ['log', '--reverse', `--format=%H%x00%an%x00%aI%x00%s%x00%b%x01`, branch]).toString('utf8');
    const out: PullSummary[] = [];
    for (const record of raw.split('\x01')) {
      const [sha, author, date, subject, body = ''] = record.replace(/^\n/, '').split('\x00');
      if (!sha || !subject) continue;
      const pr = /PR #(\d+)/.exec(body);
      if (!pr) continue;
      const reviewer = /Reviewed-by: (.+)/.exec(body)?.[1];
      const description = body
        .split('\n')
        .filter((l) => !/^PR #\d+/.test(l) && !/^Reviewed-by:/.test(l))
        .join('\n')
        .trim();
      const status = git(dir, ['diff-tree', '--root', '--no-commit-id', '--name-status', '-r', '-M', sha]).toString('utf8');
      const files = status
        .split('\n')
        .filter(Boolean)
        .map((line) => {
          const [code = '', a = '', b] = line.split('\t');
          const st = parseStatus(code);
          return st === 'renamed' ? { path: b ?? a, status: st, previousPath: a } : { path: a, status: st };
        });
      out.push({
        number: Number(pr[1]),
        title: subject,
        body: description || null,
        author: handle(author ?? ''),
        mergedAt: date ?? '',
        mergeCommitSha: sha,
        baseRef: branch,
        htmlUrl: `https://github.example/northwind/monorepo/pull/${pr[1]}`,
        reviews: reviewer ? [{ author: handle(reviewer), state: 'APPROVED', body: null, submittedAt: date ?? null }] : [],
        comments: [],
        files,
      });
    }
    return out;
  })();

  return {
    pulls,
    async getRepo(ref: RepoRef) {
      const readme = git(dir, ['show', `${branch}:README.md`]).toString('utf8').split('\n')[0] ?? '';
      return {
        fullName: `${ref.owner}/${ref.repo}`,
        description: readme.replace(/^#\s*/, ''),
        defaultBranch: branch,
        private: opts.isPrivate ?? true,
        htmlUrl: `https://github.example/${ref.owner}/${ref.repo}`,
        topics: ['robotics'],
      };
    },
    async listTree(_ref, b) {
      const entries: TreeEntry[] = [];
      for (const line of git(dir, ['ls-tree', '-r', '-l', b]).toString('utf8').split('\n')) {
        if (!line) continue;
        const [meta = '', path = ''] = line.split('\t');
        const [, type = '', sha = '', size = '0'] = meta.split(/\s+/);
        if (type === 'blob') entries.push({ path, sha, size: Number(size) });
      }
      return entries;
    },
    async getBlobText(_ref, sha) {
      const buf = git(dir, ['cat-file', '-p', sha]);
      return buf.subarray(0, 8000).includes(0) ? null : buf.toString('utf8');
    },
    async getFileText(_ref, path, gitRef) {
      try {
        const buf = git(dir, ['show', `${gitRef}:${path}`]);
        return buf.subarray(0, 8000).includes(0) ? null : buf.toString('utf8');
      } catch {
        return null;
      }
    },
    async listMergedPulls(_ref, base) {
      return pulls.filter((p) => p.baseRef === base);
    },
    async getPull(_ref, number) {
      const p = pulls.find((x) => x.number === number);
      if (!p) throw new Error(`no PR #${number}`);
      return p;
    },
    async listCollaborators() {
      return [...new Set(pulls.flatMap((p) => [p.author, ...p.reviews.map((r) => r.author)]))].sort();
    },
  };
}

/** Layer overrides on an api for incremental-sync tests. */
export function withOverrides(
  api: GitHubApi,
  overrides: { files?: Record<string, string | null>; pull?: PullSummary },
): GitHubApi {
  return {
    ...api,
    getRepo: (ref) => api.getRepo(ref),
    listTree: (ref, b) => api.listTree(ref, b),
    getBlobText: (ref, sha) => api.getBlobText(ref, sha),
    listMergedPulls: (ref, b) => api.listMergedPulls(ref, b),
    listCollaborators: (ref) => api.listCollaborators(ref),
    async getFileText(ref, path, gitRef) {
      if (overrides.files && path in overrides.files) return overrides.files[path] ?? null;
      return api.getFileText(ref, path, gitRef);
    },
    async getPull(ref, number) {
      if (overrides.pull && overrides.pull.number === number) return overrides.pull;
      return api.getPull(ref, number);
    },
  };
}
