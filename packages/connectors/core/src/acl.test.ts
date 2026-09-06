import { describe, expect, it } from 'vitest';
import { aclAllows, aclEquals, aclIntersect, normalizeAcl } from './acl';

const D = { kind: 'domain', domain: 'Northwind.example' } as const;
const U = (...emails: string[]) => ({ kind: 'users' as const, emails });

describe('acl', () => {
  it('normalizes case, whitespace, order, and duplicates', () => {
    expect(normalizeAcl(U(' B@x.com', 'a@x.com', 'b@x.com'))).toEqual(U('a@x.com', 'b@x.com'));
    expect(normalizeAcl(D)).toEqual({ kind: 'domain', domain: 'northwind.example' });
    expect(aclEquals(U('b@x.com', 'a@x.com'), U('a@x.com', 'B@x.com'))).toBe(true);
  });

  it('intersects: users ∩ users, domain ∩ users, domain ∩ domain (F-SEC-1)', () => {
    expect(aclIntersect([U('a@x', 'b@x'), U('b@x', 'c@x')])).toEqual(U('b@x'));
    expect(aclIntersect([D, U('a@x')])).toEqual(U('a@x'));
    expect(aclIntersect([U('a@x'), D])).toEqual(U('a@x'));
    expect(aclIntersect([D, D])).toEqual(normalizeAcl(D));
    expect(aclIntersect([D, { kind: 'domain', domain: 'other.example' }])).toEqual(U());
    expect(aclIntersect([U('a@x'), U('b@x')])).toEqual(U());
  });

  it('checks membership', () => {
    expect(aclAllows(D, 'lena.fischer@northwind.example')).toBe(true);
    expect(aclAllows(D, 'someone@else.example')).toBe(false);
    expect(aclAllows(U('a@x'), 'A@X')).toBe(true);
    expect(aclAllows(U('github:jenna-ortiz'), 'github:jenna-ortiz')).toBe(true);
  });
});
