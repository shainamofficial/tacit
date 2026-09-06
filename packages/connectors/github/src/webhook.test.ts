import { describe, expect, it } from 'vitest';
import { handleWebhook, parseMergeEvent, signPayload, verifySignature } from './webhook';

const secret = 'whsec_test';

const mergedPayload = {
  action: 'closed',
  pull_request: {
    number: 42,
    title: 'feat: thing',
    merged: true,
    merge_commit_sha: 'abc123',
    html_url: 'https://github.com/o/r/pull/42',
    base: { ref: 'main', repo: { default_branch: 'main' } },
  },
  repository: { name: 'r', owner: { login: 'o' } },
  installation: { id: 77 },
};

describe('webhook', () => {
  it('verifies HMAC signatures in constant time and rejects bad ones', () => {
    const body = JSON.stringify(mergedPayload);
    expect(verifySignature(body, signPayload(body, secret), secret)).toBe(true);
    expect(verifySignature(body, signPayload(body, 'other'), secret)).toBe(false);
    expect(verifySignature(body, undefined, secret)).toBe(false);
    expect(verifySignature(body, 'sha256=short', secret)).toBe(false);
  });

  it('parses only merged PRs into the default branch', () => {
    expect(parseMergeEvent('pull_request', mergedPayload)).toMatchObject({ ref: { owner: 'o', repo: 'r' }, number: 42, mergeCommitSha: 'abc123', installationId: 77 });
    expect(parseMergeEvent('push', mergedPayload)).toBeNull();
    expect(parseMergeEvent('pull_request', { ...mergedPayload, action: 'opened' })).toBeNull();
    expect(parseMergeEvent('pull_request', { ...mergedPayload, pull_request: { ...mergedPayload.pull_request, merged: false } })).toBeNull();
    expect(parseMergeEvent('pull_request', { ...mergedPayload, pull_request: { ...mergedPayload.pull_request, base: { ref: 'release', repo: { default_branch: 'main' } } } })).toBeNull();
    expect(parseMergeEvent('pull_request', { garbage: true })).toBeNull();
  });

  it('handleWebhook returns 401 / 400 / 204 / 202 as appropriate', () => {
    const body = JSON.stringify(mergedPayload);
    expect(handleWebhook({ eventName: 'pull_request', rawBody: body, signature: 'sha256=nope', secret })).toMatchObject({ ok: false, status: 401 });
    expect(handleWebhook({ eventName: 'pull_request', rawBody: '{not json', signature: signPayload('{not json', secret), secret })).toMatchObject({ ok: false, status: 400 });
    expect(handleWebhook({ eventName: 'issues', rawBody: body, signature: signPayload(body, secret), secret })).toMatchObject({ ok: true, status: 204, event: null });
    const accepted = handleWebhook({ eventName: 'pull_request', rawBody: Buffer.from(body), signature: signPayload(body, secret), secret });
    expect(accepted).toMatchObject({ ok: true, status: 202, event: { number: 42 } });
  });
});
