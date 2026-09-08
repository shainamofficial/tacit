// Query-miss logging (F-SRV-4, F-GAP-1c). A question the Brain could not
// answer becomes a gap row, not a log line, so it can be routed to a knower.
// A permission miss (matches exist, none visible to this user) is recorded
// with its reason so the admin can tell the two apart; the user cannot.
// Never stores served content — only the user's own query and identity.
import type { Queryable } from '@tacit/artifacts';

export interface QueryMiss {
  readonly orgId: string;
  readonly email: string;
  readonly query: string;
  readonly reason: 'query_miss' | 'permission_miss';
}

export interface GapSink {
  queryMiss(miss: QueryMiss): Promise<void>;
}

export class MemoryGapSink implements GapSink {
  readonly misses: QueryMiss[] = [];
  async queryMiss(miss: QueryMiss): Promise<void> {
    this.misses.push(miss);
  }
}

export class PgGapSink implements GapSink {
  constructor(private readonly db: Queryable) {}
  async queryMiss(miss: QueryMiss): Promise<void> {
    await this.db.query("insert into gaps (org_id, kind, detail) values ($1, 'query_miss', $2::jsonb)", [
      miss.orgId,
      JSON.stringify({ query: miss.query.slice(0, 1000), user: miss.email, reason: miss.reason, at: new Date().toISOString() }),
    ]);
  }
}
