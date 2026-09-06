// GitHub webhook handling: HMAC verification and the one event we act on —
// a pull request merged into the default branch (F-ING-2, F-CODE-2 trigger).
import { createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import type { RepoRef } from './api';

export function signPayload(rawBody: string | Buffer, secret: string): string {
  return `sha256=${createHmac('sha256', secret).update(rawBody).digest('hex')}`;
}

export function verifySignature(rawBody: string | Buffer, signatureHeader: string | undefined, secret: string): boolean {
  if (!signatureHeader) return false;
  const expected = Buffer.from(signPayload(rawBody, secret));
  const given = Buffer.from(signatureHeader);
  return expected.length === given.length && timingSafeEqual(expected, given);
}

const PullRequestClosedSchema = z.object({
  action: z.string(),
  pull_request: z.object({
    number: z.number().int().positive(),
    title: z.string(),
    merged: z.boolean().nullable(),
    merge_commit_sha: z.string().nullable(),
    html_url: z.string(),
    base: z.object({ ref: z.string(), repo: z.object({ default_branch: z.string() }) }),
  }),
  repository: z.object({ name: z.string(), owner: z.object({ login: z.string() }) }),
  installation: z.object({ id: z.number().int() }).optional(),
});

export interface MergeEvent {
  readonly ref: RepoRef;
  readonly number: number;
  readonly title: string;
  readonly mergeCommitSha: string | null;
  readonly baseRef: string;
  readonly htmlUrl: string;
  readonly installationId?: number;
}

/** Returns the merge event, or null for anything that is not "PR merged into the default branch". */
export function parseMergeEvent(eventName: string, payload: unknown): MergeEvent | null {
  if (eventName !== 'pull_request') return null;
  const parsed = PullRequestClosedSchema.safeParse(payload);
  if (!parsed.success) return null;
  const { action, pull_request: pr, repository, installation } = parsed.data;
  if (action !== 'closed' || pr.merged !== true) return null;
  if (pr.base.ref !== pr.base.repo.default_branch) return null;
  return {
    ref: { owner: repository.owner.login, repo: repository.name },
    number: pr.number,
    title: pr.title,
    mergeCommitSha: pr.merge_commit_sha,
    baseRef: pr.base.ref,
    htmlUrl: pr.html_url,
    ...(installation ? { installationId: installation.id } : {}),
  };
}

export interface WebhookInput {
  readonly eventName: string | undefined;
  readonly rawBody: string | Buffer;
  readonly signature: string | undefined;
  readonly secret: string;
}

export type WebhookOutcome =
  | { ok: false; status: 401 | 400; reason: string }
  | { ok: true; status: 204; event: null; reason: string }
  | { ok: true; status: 202; event: MergeEvent };

/** Verify, parse, and decide. The caller enqueues `event` for syncMergedPull when status is 202. */
export function handleWebhook(input: WebhookInput): WebhookOutcome {
  if (!verifySignature(input.rawBody, input.signature, input.secret)) {
    return { ok: false, status: 401, reason: 'invalid signature' };
  }
  let payload: unknown;
  try {
    payload = JSON.parse(typeof input.rawBody === 'string' ? input.rawBody : input.rawBody.toString('utf8'));
  } catch {
    return { ok: false, status: 400, reason: 'body is not JSON' };
  }
  const event = parseMergeEvent(input.eventName ?? '', payload);
  if (!event) return { ok: true, status: 204, event: null, reason: `ignored ${input.eventName ?? 'unknown'} event` };
  return { ok: true, status: 202, event };
}
