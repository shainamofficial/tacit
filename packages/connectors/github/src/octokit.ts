// Octokit-backed GitHubApi for a GitHub App installation (F-ING-1: read-only
// permissions — contents:read, metadata:read, pull_requests:read).
import { App, Octokit } from 'octokit';
import type { FileStatus, GitHubApi, PullSummary, RepoRef } from './api';

export interface GitHubAppConfig {
  readonly appId: string | number;
  readonly privateKey: string;
  readonly installationId: number;
}

export async function octokitForInstallation(config: GitHubAppConfig): Promise<Octokit> {
  const app = new App({ appId: config.appId, privateKey: config.privateKey });
  return app.getInstallationOctokit(config.installationId);
}

function isBinary(buf: Buffer): boolean {
  const probe = buf.subarray(0, 8000);
  return probe.includes(0);
}

function decodeContent(base64: string): string | null {
  const buf = Buffer.from(base64.replace(/\n/g, ''), 'base64');
  return isBinary(buf) ? null : buf.toString('utf8');
}

function toStatus(status: string): FileStatus {
  switch (status) {
    case 'added':
    case 'removed':
    case 'renamed':
      return status;
    default:
      return 'modified';
  }
}

export class OctokitGitHubApi implements GitHubApi {
  constructor(private readonly octokit: Octokit) {}

  async getRepo(ref: RepoRef) {
    const { data } = await this.octokit.rest.repos.get({ owner: ref.owner, repo: ref.repo });
    return {
      fullName: data.full_name,
      description: data.description,
      defaultBranch: data.default_branch,
      private: data.private,
      htmlUrl: data.html_url,
      topics: data.topics ?? [],
    };
  }

  async listTree(ref: RepoRef, branch: string) {
    const { data } = await this.octokit.rest.git.getTree({ owner: ref.owner, repo: ref.repo, tree_sha: branch, recursive: '1' });
    if (data.truncated) {
      throw new Error(`tree for ${ref.owner}/${ref.repo}@${branch} is truncated by GitHub; per-directory listing not implemented (plan §12: per-repo caps)`);
    }
    return data.tree
      .filter((t) => t.type === 'blob' && typeof t.path === 'string' && typeof t.sha === 'string')
      .map((t) => ({ path: t.path as string, sha: t.sha as string, size: t.size ?? 0 }));
  }

  async getBlobText(ref: RepoRef, sha: string) {
    const { data } = await this.octokit.rest.git.getBlob({ owner: ref.owner, repo: ref.repo, file_sha: sha });
    return decodeContent(data.content);
  }

  async getFileText(ref: RepoRef, path: string, gitRef: string) {
    try {
      const { data } = await this.octokit.rest.repos.getContent({ owner: ref.owner, repo: ref.repo, path, ref: gitRef });
      if (Array.isArray(data) || data.type !== 'file') return null;
      return decodeContent(data.content);
    } catch (err) {
      if (typeof err === 'object' && err !== null && 'status' in err && (err as { status: number }).status === 404) return null;
      throw err;
    }
  }

  private async hydratePull(ref: RepoRef, pr: { number: number; title: string; body: string | null; user: { login: string } | null; merged_at: string | null; merge_commit_sha: string | null; base: { ref: string }; html_url: string }): Promise<PullSummary> {
    const base = { owner: ref.owner, repo: ref.repo, pull_number: pr.number, per_page: 100 };
    const [reviews, comments, files] = await Promise.all([
      this.octokit.paginate(this.octokit.rest.pulls.listReviews, base),
      this.octokit.paginate(this.octokit.rest.issues.listComments, { owner: ref.owner, repo: ref.repo, issue_number: pr.number, per_page: 100 }),
      this.octokit.paginate(this.octokit.rest.pulls.listFiles, base),
    ]);
    return {
      number: pr.number,
      title: pr.title,
      body: pr.body,
      author: pr.user?.login ?? 'unknown',
      mergedAt: pr.merged_at ?? '',
      mergeCommitSha: pr.merge_commit_sha,
      baseRef: pr.base.ref,
      htmlUrl: pr.html_url,
      reviews: reviews.map((r) => ({ author: r.user?.login ?? 'unknown', state: r.state, body: r.body || null, submittedAt: r.submitted_at ?? null })),
      comments: comments.map((c) => ({ author: c.user?.login ?? 'unknown', body: c.body ?? '', createdAt: c.created_at })),
      files: files.map((f) => ({ path: f.filename, status: toStatus(f.status), ...(f.previous_filename ? { previousPath: f.previous_filename } : {}) })),
    };
  }

  async listMergedPulls(ref: RepoRef, base: string) {
    const closed = await this.octokit.paginate(this.octokit.rest.pulls.list, { owner: ref.owner, repo: ref.repo, state: 'closed', base, per_page: 100, sort: 'created', direction: 'asc' });
    const merged = closed.filter((pr) => pr.merged_at !== null);
    const out: PullSummary[] = [];
    for (const pr of merged) out.push(await this.hydratePull(ref, pr));
    return out;
  }

  async getPull(ref: RepoRef, number: number) {
    const { data } = await this.octokit.rest.pulls.get({ owner: ref.owner, repo: ref.repo, pull_number: number });
    return this.hydratePull(ref, data);
  }

  async listCollaborators(ref: RepoRef) {
    const users = await this.octokit.paginate(this.octokit.rest.repos.listCollaborators, { owner: ref.owner, repo: ref.repo, per_page: 100 });
    return users.map((u) => u.login);
  }
}
