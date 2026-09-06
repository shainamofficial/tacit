// @tacit/connector-core — shared connector plumbing: sync store, secrets
// scanner + quarantine, ACL helpers (F-ING-3, F-ING-5, F-ING-6).
export { AclSchema, aclAllows, aclEquals, aclIntersect, normalizeAcl, type Acl } from './acl';
export { redact, scanSecrets, shannonEntropy, type SecretSpan } from './secrets';
import type { UpsertResult } from './store';

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
