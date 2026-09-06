// The sync store: one row per source item, content-hash dedup (F-ING-6), ACL
// captured on every write (F-ING-3), secrets quarantined by id (F-ING-5).
// Every write is atomic and idempotent: re-running an unchanged sync touches
// nothing; a partial failure leaves no half-written item.
import { createHash } from 'node:crypto';
import pg from 'pg';
import { aclEquals, normalizeAcl, type Acl } from './acl';
import { redact, scanSecrets, type SecretSpan } from './secrets';

export type Db = pg.Pool | pg.ClientBase;

export function contentHash(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

/**
 * Run `fn` atomically. A Pool gets a dedicated client and a real transaction;
 * a client that is already inside a caller-managed transaction gets a savepoint.
 */
export async function atomic<T>(db: Db, fn: (client: pg.ClientBase) => Promise<T>): Promise<T> {
  if (db instanceof pg.Pool) {
    const client = await db.connect();
    try {
      await client.query('begin');
      const result = await fn(client);
      await client.query('commit');
      return result;
    } catch (err) {
      await client.query('rollback');
      throw err;
    } finally {
      client.release();
    }
  }
  await db.query('savepoint tacit_sync');
  try {
    const result = await fn(db);
    await db.query('release savepoint tacit_sync');
    return result;
  } catch (err) {
    await db.query('rollback to savepoint tacit_sync');
    throw err;
  }
}

export interface UpsertInput {
  readonly sourceId: string;
  readonly externalId: string;
  readonly kind: string;
  readonly title: string;
  readonly content: string;
  readonly acl: Acl;
  readonly meta?: Record<string, unknown>;
  readonly updatedAt?: Date;
}

export type UpsertOutcome = 'inserted' | 'updated' | 'unchanged';

export interface UpsertResult {
  readonly outcome: UpsertOutcome;
  readonly itemId: string;
  readonly quarantined: number;
}

export interface StoredItem {
  readonly id: string;
  readonly externalId: string;
  readonly kind: string;
  readonly title: string;
  readonly contentHash: string;
  readonly acl: Acl;
  readonly meta: Record<string, unknown>;
  readonly content: string;
  readonly redactedSpans: number;
  readonly updatedAt: Date;
  readonly deletedAt: Date | null;
}

interface ItemRow {
  id: string;
  content_hash: string;
  acl: Acl;
  title: string;
  kind: string;
  deleted_at: Date | null;
}

export class SyncStore {
  constructor(
    private readonly db: Db,
    private readonly scanner: (content: string) => SecretSpan[] = scanSecrets,
  ) {}

  async upsert(input: UpsertInput): Promise<UpsertResult> {
    const hash = contentHash(input.content);
    const acl = normalizeAcl(input.acl);
    const meta = input.meta ?? {};
    const updatedAt = input.updatedAt ?? new Date();

    return atomic(this.db, async (c) => {
      const existing = await c.query<ItemRow>(
        'select id, content_hash, acl, title, kind, deleted_at from sync_items where source_id = $1 and external_id = $2',
        [input.sourceId, input.externalId],
      );
      const row = existing.rows[0];

      if (row && row.content_hash === hash) {
        const metaChanged = !aclEquals(row.acl, acl) || row.title !== input.title || row.kind !== input.kind || row.deleted_at !== null;
        if (!metaChanged) return { outcome: 'unchanged', itemId: row.id, quarantined: 0 };
        await c.query(
          'update sync_items set acl = $2, title = $3, kind = $4, meta = $5, updated_at = $6, deleted_at = null where id = $1',
          [row.id, JSON.stringify(acl), input.title, input.kind, JSON.stringify(meta), updatedAt],
        );
        return { outcome: 'updated', itemId: row.id, quarantined: 0 };
      }

      let itemId: string;
      if (row) {
        await c.query(
          'update sync_items set content_hash = $2, acl = $3, title = $4, kind = $5, meta = $6, updated_at = $7, deleted_at = null where id = $1',
          [row.id, hash, JSON.stringify(acl), input.title, input.kind, JSON.stringify(meta), updatedAt],
        );
        itemId = row.id;
      } else {
        const inserted = await c.query<{ id: string }>(
          `insert into sync_items (source_id, external_id, content_hash, acl, title, kind, meta, updated_at)
           values ($1, $2, $3, $4, $5, $6, $7, $8) returning id`,
          [input.sourceId, input.externalId, hash, JSON.stringify(acl), input.title, input.kind, JSON.stringify(meta), updatedAt],
        );
        itemId = inserted.rows[0]?.id ?? '';
        if (!itemId) throw new Error('sync_items insert returned no id');
      }

      const spans = this.scanner(input.content);
      const ids: string[] = [];
      for (const s of spans) {
        const q = await c.query<{ id: string }>(
          'insert into quarantined_spans (sync_item_id, detector, span, content_hash) values ($1, $2, int4range($3, $4), $5) returning id',
          [itemId, s.detector, s.start, s.end, hash],
        );
        const id = q.rows[0]?.id;
        if (!id) throw new Error('quarantined_spans insert returned no id');
        ids.push(id);
      }
      const stored = redact(input.content, spans, ids);
      await c.query(
        `insert into sync_item_content (sync_item_id, content, byte_length, redacted_spans)
         values ($1, $2, $3, $4)
         on conflict (sync_item_id) do update
           set content = excluded.content, byte_length = excluded.byte_length,
               redacted_spans = excluded.redacted_spans, updated_at = now()`,
        [itemId, stored, Buffer.byteLength(stored, 'utf8'), spans.length],
      );
      return { outcome: row ? 'updated' : 'inserted', itemId, quarantined: spans.length };
    });
  }

  /** Soft-delete. Returns true if the item was live. */
  async markDeleted(sourceId: string, externalId: string, at: Date = new Date()): Promise<boolean> {
    const res = await this.db.query(
      'update sync_items set deleted_at = $3, updated_at = $3 where source_id = $1 and external_id = $2 and deleted_at is null',
      [sourceId, externalId, at],
    );
    return (res.rowCount ?? 0) > 0;
  }

  async listActive(sourceId: string, kind?: string): Promise<Array<{ externalId: string; contentHash: string }>> {
    const res = await this.db.query<{ external_id: string; content_hash: string }>(
      `select external_id, content_hash from sync_items
       where source_id = $1 and deleted_at is null and ($2::text is null or kind = $2)
       order by external_id`,
      [sourceId, kind ?? null],
    );
    return res.rows.map((r) => ({ externalId: r.external_id, contentHash: r.content_hash }));
  }

  async get(sourceId: string, externalId: string): Promise<StoredItem | null> {
    const res = await this.db.query<{
      id: string;
      external_id: string;
      kind: string;
      title: string;
      content_hash: string;
      acl: Acl;
      meta: Record<string, unknown>;
      content: string | null;
      redacted_spans: number | null;
      updated_at: Date;
      deleted_at: Date | null;
    }>(
      `select i.id, i.external_id, i.kind, i.title, i.content_hash, i.acl, i.meta, i.updated_at, i.deleted_at,
              c.content, c.redacted_spans
       from sync_items i left join sync_item_content c on c.sync_item_id = i.id
       where i.source_id = $1 and i.external_id = $2`,
      [sourceId, externalId],
    );
    const r = res.rows[0];
    if (!r) return null;
    return {
      id: r.id,
      externalId: r.external_id,
      kind: r.kind,
      title: r.title,
      contentHash: r.content_hash,
      acl: r.acl,
      meta: r.meta,
      content: r.content ?? '',
      redactedSpans: r.redacted_spans ?? 0,
      updatedAt: r.updated_at,
      deletedAt: r.deleted_at,
    };
  }
}
