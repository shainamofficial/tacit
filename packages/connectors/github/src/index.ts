// @tacit/connector-github — GitHub App connector: repo tree, merged PRs with
// reviews, CODEOWNERS, and the merge-to-main webhook (F-ING-1..3, F-ING-6, F-CODE-2).
export type { FileStatus, GitHubApi, PullComment, PullFile, PullReview, PullSummary, RepoInfo, RepoRef, TreeEntry } from './api';
export { FILE_PREFIX, PR_PREFIX, REPO_ID, backfillRepo, isSyncablePath, parseCodeowners, renderPull, syncMergedPull, type CodeownersRule, type GitHubSyncOptions } from './connector';
export { OctokitGitHubApi, octokitForInstallation, type GitHubAppConfig } from './octokit';
export { handleWebhook, parseMergeEvent, signPayload, verifySignature, type MergeEvent, type WebhookInput, type WebhookOutcome } from './webhook';
