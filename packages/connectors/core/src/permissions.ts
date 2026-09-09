// Permission-mapping review (F-ADM-1: "who can see what — approve"). The
// mapping is derived from the ACLs the sync store captured at ingest
// (F-ING-3), never from what an admin believes. Approval is recorded against
// a digest of the mapping, so if the ACLs change the review is stale and the
// compile gate closes again (F-ING-4: scoping and review happen before the
// first compile). Shared by the admin app (review) and the compiler (gate).
import { createHash } from 'node:crypto';
import type { Acl } from './acl';
import type { Db } from './store';

/** One distinct ACL captured on a source's items, with how many items carry it. */
export interface AclGroup {
  readonly acl: Acl;
  readonly items: number;
  readonly samples: readonly string[];
}

export async function loadAclGroups(db: Db, sourceId: string): Promise<AclGroup[]> {
  const r = await db.query<{ acl: Acl; items: string; samples: string[] }>(
    `select acl, count(*)::text as items, (array_agg(title order by title))[1:3] as samples
     from sync_items where source_id = $1 and deleted_at is null group by acl order by count(*) desc`,
    [sourceId],
  );
  return r.rows.map((row) => ({ acl: row.acl, items: Number(row.items), samples: row.samples }));
}

export interface MappingRow {
  readonly kind: 'domain' | 'users';
  readonly label: string;
  readonly members: readonly string[];
  readonly items: number;
  readonly samples: readonly string[];
}
export interface PermissionMapping {
  readonly rows: readonly MappingRow[];
  readonly items: number;
  readonly restrictedItems: number;
  readonly digest: string;
}

export function mapPermissions(groups: readonly AclGroup[]): PermissionMapping {
  const rows: MappingRow[] = groups.map((g) => {
    if (g.acl.kind === 'domain') return { kind: 'domain', label: `Everyone at ${g.acl.domain}`, members: [], items: g.items, samples: g.samples };
    const members = [...new Set(g.acl.emails.map((e) => e.toLowerCase()))].sort();
    return { kind: 'users', label: `${members.length} ${members.length === 1 ? 'person' : 'people'}`, members, items: g.items, samples: g.samples };
  });
  const canonical = rows.map((r) => `${r.kind}|${r.members.join(',')}|${r.items}`).sort().join('\n');
  return {
    rows,
    items: rows.reduce((s, r) => s + r.items, 0),
    restrictedItems: rows.filter((r) => r.kind === 'users').reduce((s, r) => s + r.items, 0),
    digest: createHash('sha256').update(canonical).digest('hex').slice(0, 16),
  };
}

export interface Approval {
  readonly approved_at: string;
  readonly approved_by: string;
  readonly digest: string;
}

const KEY = 'permission_review';

export function approvalFor(settings: Readonly<Record<string, unknown>>, sourceId: string): Approval | null {
  const all = settings[KEY];
  if (!all || typeof all !== 'object') return null;
  const a = (all as Record<string, unknown>)[sourceId];
  if (!a || typeof a !== 'object') return null;
  const { approved_at, approved_by, digest } = a as Record<string, unknown>;
  return typeof approved_at === 'string' && typeof approved_by === 'string' && typeof digest === 'string' ? { approved_at, approved_by, digest } : null;
}

/** The settings patch that records an approval of this exact mapping. */
export function approvePatch(settings: Readonly<Record<string, unknown>>, sourceId: string, digest: string, by: string, at = new Date().toISOString()): Record<string, unknown> {
  const existing = (settings[KEY] && typeof settings[KEY] === 'object' ? settings[KEY] : {}) as Record<string, unknown>;
  return { [KEY]: { ...existing, [sourceId]: { approved_at: at, approved_by: by, digest } } };
}

/** Compile gate: approved, and the mapping has not changed since. */
export function isApproved(settings: Readonly<Record<string, unknown>>, sourceId: string, mapping: PermissionMapping): 'approved' | 'stale' | 'pending' {
  const a = approvalFor(settings, sourceId);
  if (!a) return 'pending';
  return a.digest === mapping.digest ? 'approved' : 'stale';
}
