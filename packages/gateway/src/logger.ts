// Cost/latency logging to model_calls (implementation-plan §8). One row per
// provider call; never any prompt or completion content.
import type { Usage } from './provider';

export interface ModelCallRecord {
  readonly run_id: string | null;
  readonly org_id: string | null;
  readonly stage: string;
  readonly provider: string;
  readonly model: string;
  readonly usage: Usage;
  readonly cost_usd: number;
  readonly latency_ms: number;
  readonly edit_rate_signal: string | null;
}

export interface ModelCallLogger {
  log(record: ModelCallRecord): Promise<void>;
}

export class MemoryLogger implements ModelCallLogger {
  readonly calls: ModelCallRecord[] = [];
  async log(record: ModelCallRecord): Promise<void> {
    this.calls.push(record);
  }
}

/** Anything with pg's query(text, values) — a Pool, a Client, or a transaction-scoped client. */
export interface Queryable {
  query(text: string, values?: unknown[]): Promise<unknown>;
}

const INSERT = `
  insert into model_calls
    (run_id, org_id, stage, provider, model, in_tokens, out_tokens,
     cache_read_tokens, cache_write_tokens, cost_usd, latency_ms, edit_rate_signal)
  values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`;

export class PgModelCallLogger implements ModelCallLogger {
  constructor(private readonly db: Queryable) {}

  async log(r: ModelCallRecord): Promise<void> {
    if (!r.org_id) throw new Error('model_calls rows require org_id; pass orgId in CompleteOptions');
    await this.db.query(INSERT, [
      r.run_id,
      r.org_id,
      r.stage,
      r.provider,
      r.model,
      r.usage.in_tokens,
      r.usage.out_tokens,
      r.usage.cache_read_tokens,
      r.usage.cache_write_tokens,
      r.cost_usd,
      r.latency_ms,
      r.edit_rate_signal,
    ]);
  }
}
