// The slice of GitHub the connector needs. Implemented by the Octokit adapter
// (octokit.ts) for production and by a git-backed fake for tests, so connector
// logic is exercised offline against the Northwind corpus repo.

export interface RepoRef {
  readonly owner: string;
  readonly repo: string;
}

export interface RepoInfo {
  readonly fullName: string;
  readonly description: string | null;
  readonly defaultBranch: string;
  readonly private: boolean;
  readonly htmlUrl: string;
  readonly topics: readonly string[];
}

export interface TreeEntry {
  readonly path: string;
  readonly sha: string;
  readonly size: number;
}

export interface PullReview {
  readonly author: string;
  readonly state: string;
  readonly body: string | null;
  readonly submittedAt: string | null;
}

export interface PullComment {
  readonly author: string;
  readonly body: string;
  readonly createdAt: string;
}

export type FileStatus = 'added' | 'modified' | 'removed' | 'renamed';

export interface PullFile {
  readonly path: string;
  readonly status: FileStatus;
  readonly previousPath?: string;
}

export interface PullSummary {
  readonly number: number;
  readonly title: string;
  readonly body: string | null;
  readonly author: string;
  readonly mergedAt: string;
  readonly mergeCommitSha: string | null;
  readonly baseRef: string;
  readonly htmlUrl: string;
  readonly reviews: readonly PullReview[];
  readonly comments: readonly PullComment[];
  readonly files: readonly PullFile[];
}

export interface GitHubApi {
  getRepo(ref: RepoRef): Promise<RepoInfo>;
  /** All blobs reachable from the branch head. */
  listTree(ref: RepoRef, branch: string): Promise<TreeEntry[]>;
  /** Blob text, or null if binary. */
  getBlobText(ref: RepoRef, sha: string): Promise<string | null>;
  /** File text at a git ref (branch, tag, or commit sha), or null if missing/binary. */
  getFileText(ref: RepoRef, path: string, gitRef: string): Promise<string | null>;
  /** Merged pull requests targeting `base`, oldest first, with reviews, comments, and files. */
  listMergedPulls(ref: RepoRef, base: string): Promise<PullSummary[]>;
  getPull(ref: RepoRef, number: number): Promise<PullSummary>;
  /** Logins with read access. */
  listCollaborators(ref: RepoRef): Promise<string[]>;
}
