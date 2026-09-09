// The compiler's view of the sync store: every live item of an org's
// connected sources as the EvalSyncItem the stages consume. The scope key is
// whatever the connector recorded at ingest (meta.scope_key); an item without
// one is skipped and counted, never served under a guessed scope (F-SEC-1).
import { scopeKeyOf, type Acl, type Db } from '@tacit/connector-core';
import type { EvalSyncItem } from './contract';

interface Row {
  id: string;
  source_id: string;
  source_kind: 'slack' | 'gdrive' | 'github' | 'zendesk';
  external_id: string;
  kind: string;
  title: string;
  acl: Acl;
  meta: Record<string, unknown>;
  updated_at: Date;
  content: string | null;
}

export interface LoadedItems {
  readonly items: EvalSyncItem[];
  readonly skipped_no_scope: number;
  readonly skipped_no_content: number;
  readonly by_source: Readonly<Record<string, number>>;
}

/** Live items for the given sources (all connected sources of the org when omitted). */
export async function loadItems(db: Db, orgId: string, sourceIds?: readonly string[]): Promise<LoadedItems> {
  const r = await db.query<Row>(
    `select i.id, i.source_id, s.kind as source_kind, i.external_id, i.kind, i.title, i.acl, i.meta, i.updated_at, c.content
     from sync_items i
     join sources s on s.id = i.source_id
     left join sync_item_content c on c.sync_item_id = i.id
     where s.org_id = $1 and i.deleted_at is null and s.status <> 'disconnected'
       and ($2::uuid[] is null or i.source_id = any($2::uuid[]))
     order by s.kind, i.external_id`,
    [orgId, sourceIds ? [...sourceIds] : null],
  );
  const items: EvalSyncItem[] = [];
  const by_source: Record<string, number> = {};
  let skipped_no_scope = 0;
  let skipped_no_content = 0;
  for (const row of r.rows) {
    const scope = scopeKeyOf(row.meta);
    if (!scope) {
      skipped_no_scope += 1;
      continue;
    }
    if (row.content === null || row.content.length === 0) {
      skipped_no_content += 1;
      continue;
    }
    items.push({
      id: row.id,
      source: row.source_kind === 'github' && row.kind === 'commit' ? 'github_commit' : row.source_kind,
      kind: row.kind,
      external_ref: row.external_id,
      title: row.title,
      content: row.content,
      acl: row.acl,
      scope_key: scope,
      modified_at: row.updated_at.toISOString(),
      meta: row.meta,
    });
    by_source[row.source_id] = (by_source[row.source_id] ?? 0) + 1;
  }
  return { items, skipped_no_scope, skipped_no_content, by_source };
}
