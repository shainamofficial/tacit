// Incremental-sync cursors (F-ING-2): opaque strings keyed per source.
import type { Db } from './store';

export class SyncCursors {
  constructor(private readonly db: Db) {}

  async get(sourceId: string, key: string): Promise<string | null> {
    const res = await this.db.query<{ cursor: string }>('select cursor from sync_cursors where source_id = $1 and key = $2', [sourceId, key]);
    return res.rows[0]?.cursor ?? null;
  }

  async set(sourceId: string, key: string, cursor: string): Promise<void> {
    await this.db.query(
      `insert into sync_cursors (source_id, key, cursor) values ($1, $2, $3)
       on conflict (source_id, key) do update set cursor = excluded.cursor, updated_at = now()`,
      [sourceId, key, cursor],
    );
  }
}
