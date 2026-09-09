// @tacit/connector-core — shared connector plumbing: sync store, cursors,
// secrets scanner + quarantine, ACL helpers (F-ING-2, F-ING-3, F-ING-5, F-ING-6).
import type { UpsertResult } from './store';

export { AclSchema, aclAllows, aclEquals, aclIntersect, normalizeAcl, type Acl } from './acl';
export { SyncCursors } from './cursors';
export { approvalFor, approvePatch, isApproved, loadAclGroups, mapPermissions, type AclGroup, type Approval, type MappingRow, type PermissionMapping } from './permissions';
export { scopeKeyOf, scopeKeys } from './scope';
export { redact, scanSecrets, shannonEntropy, type SecretSpan } from './secrets';
export { SyncStore, atomic, contentHash, type Db, type StoredItem, type UpsertInput, type UpsertOutcome, type UpsertResult } from './store';

export interface SyncStats {
  seen: number;
  inserted: number;
  updated: number;
  unchanged: number;
  deleted: number;
  quarantined: number;
}

export function emptyStats(): SyncStats {
  return { seen: 0, inserted: 0, updated: 0, unchanged: 0, deleted: 0, quarantined: 0 };
}

export function tally(stats: SyncStats, result: UpsertResult): void {
  stats.seen += 1;
  stats[result.outcome] += 1;
  stats.quarantined += result.quarantined;
}

/** Include/exclude scoping shared by connectors (F-ING-4). Matches by exact value or path prefix. */
export function inScope(candidates: readonly string[], include: readonly string[] | undefined, exclude: readonly string[] | undefined): boolean {
  const matches = (rule: string): boolean => candidates.some((c) => c === rule || c.startsWith(`${rule}/`));
  if (exclude?.some(matches)) return false;
  if (include && include.length > 0) return include.some(matches);
  return true;
}
