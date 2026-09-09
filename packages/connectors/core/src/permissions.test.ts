import { describe, expect, it } from 'vitest';
import { approvalFor, approvePatch, isApproved, mapPermissions } from './permissions';
import { scopeKeyOf, scopeKeys } from './scope';

const groups = [
  { acl: { kind: 'domain' as const, domain: 'northwind.example' }, items: 120, samples: ['Pricing sheet', 'SLA'] },
  { acl: { kind: 'users' as const, emails: ['Alice.Chen@northwind.example', 'tom.nakamura@northwind.example', 'alice.chen@northwind.example'] }, items: 3, samples: ['Compensation bands'] },
];

describe('scope keys', () => {
  it('name the ACL boundary: one per Drive file, per Slack conversation, per repo', () => {
    expect(scopeKeys.driveDoc('1abc')).toBe('gdrive:doc:1abc');
    expect(scopeKeys.slackConversation({ id: 'C1' })).toBe('slack:channel:C1');
    expect(scopeKeys.slackConversation({ id: 'D1', isIm: true })).toBe('slack:dm:D1');
    expect(scopeKeys.githubRepo('northwind', 'monorepo')).toBe('github:repo:northwind/monorepo');
    expect(scopeKeyOf({ scope_key: 'zendesk:all' })).toBe('zendesk:all');
    expect(scopeKeyOf({ scope_key: '' })).toBeNull();
    expect(scopeKeyOf(null)).toBeNull();
  });
});

describe('permission mapping', () => {
  it('derives readable-by rows from captured ACLs and counts restricted items', () => {
    const m = mapPermissions(groups);
    expect(m.rows.map((r) => r.label)).toEqual(['Everyone at northwind.example', '2 people']);
    expect(m.rows[1]?.members).toEqual(['alice.chen@northwind.example', 'tom.nakamura@northwind.example']);
    expect(m.items).toBe(123);
    expect(m.restrictedItems).toBe(3);
    expect(m.digest).toHaveLength(16);
  });

  it('approval is bound to the mapping digest: a changed ACL makes the review stale', () => {
    const m = mapPermissions(groups);
    let settings: Record<string, unknown> = {};
    expect(isApproved(settings, 'src-1', m)).toBe('pending');
    settings = { ...settings, ...approvePatch(settings, 'src-1', m.digest, 'admin', '2026-09-09T00:00:00Z') };
    expect(approvalFor(settings, 'src-1')).toEqual({ approved_at: '2026-09-09T00:00:00Z', approved_by: 'admin', digest: m.digest });
    expect(isApproved(settings, 'src-1', m)).toBe('approved');
    const changed = mapPermissions([...groups, { acl: { kind: 'users', emails: ['x@northwind.example'] }, items: 1, samples: ['New restricted doc'] }]);
    expect(isApproved(settings, 'src-1', changed)).toBe('stale');
    settings = { ...settings, ...approvePatch(settings, 'src-2', 'abc', 'admin') };
    expect(approvalFor(settings, 'src-1')?.digest).toBe(m.digest);
  });
});
