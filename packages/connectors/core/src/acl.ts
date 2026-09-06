// ACLs captured at ingest (F-ING-3) and intersected for artifacts (F-SEC-1).
//
// Principals are emails for company identities, or `github:<login>` style
// strings for connector identities that are not yet mapped to a person.
// Permissions are inherited, never invented: an unmapped principal is kept as
// is and simply never matches a user until the identity map resolves it.
import { z } from 'zod';

export const AclSchema = z.union([
  z.object({ kind: z.literal('domain'), domain: z.string().min(1) }),
  z.object({ kind: z.literal('users'), emails: z.array(z.string().min(1)) }),
]);
export type Acl = z.infer<typeof AclSchema>;

export function normalizeAcl(acl: Acl): Acl {
  if (acl.kind === 'domain') return { kind: 'domain', domain: acl.domain.toLowerCase() };
  return { kind: 'users', emails: [...new Set(acl.emails.map((e) => e.trim().toLowerCase()))].sort() };
}

export function aclEquals(a: Acl, b: Acl): boolean {
  return JSON.stringify(normalizeAcl(a)) === JSON.stringify(normalizeAcl(b));
}

/** Intersection of ACLs: only principals allowed by every input. Domain ∩ domain (same) stays domain-wide. */
export function aclIntersect(acls: readonly Acl[]): Acl {
  if (acls.length === 0) throw new Error('aclIntersect of nothing');
  let result = normalizeAcl(acls[0] as Acl);
  for (const next of acls.slice(1).map(normalizeAcl)) {
    if (result.kind === 'domain' && next.kind === 'domain') {
      result = result.domain === next.domain ? result : { kind: 'users', emails: [] };
    } else if (result.kind === 'domain') {
      result = next; // users ⊂ domain: the narrower side wins
    } else if (next.kind === 'domain') {
      // keep result (users)
    } else {
      const allowed = new Set(next.emails);
      result = { kind: 'users', emails: result.emails.filter((e) => allowed.has(e)) };
    }
  }
  return result;
}

export function aclAllows(acl: Acl, principal: string): boolean {
  const p = principal.trim().toLowerCase();
  if (acl.kind === 'domain') return p.endsWith(`@${acl.domain.toLowerCase()}`);
  return acl.emails.some((e) => e.toLowerCase() === p);
}
