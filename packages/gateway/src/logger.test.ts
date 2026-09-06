// Integration: a PgModelCallLogger row lands in model_calls with the schema's
// FK constraints satisfied. Runs inside a transaction that is rolled back.
import pg from 'pg';
import { describe, expect, it } from 'vitest';
import { PgModelCallLogger } from './logger';

const url = process.env.DATABASE_URL;

describe.skipIf(!url)('PgModelCallLogger (integration; needs DATABASE_URL, migrated)', () => {
  it('inserts a model_calls row linked to an org and run', async () => {
    const client = new pg.Client({ connectionString: url });
    await client.connect();
    try {
      await client.query('begin');
      const org = await client.query<{ id: string }>("insert into orgs (name) values ('gateway-test') returning id");
      const orgId = org.rows[0]?.id ?? '';
      const run = await client.query<{ id: string }>(
        "insert into pipeline_runs (org_id, kind, budget_usd) values ($1, 'eval', 5) returning id",
        [orgId],
      );
      const runId = run.rows[0]?.id ?? '';

      const logger = new PgModelCallLogger(client);
      await logger.log({
        run_id: runId,
        org_id: orgId,
        stage: 'judge',
        provider: 'anthropic',
        model: 'claude-opus-5',
        usage: { in_tokens: 1200, out_tokens: 80, cache_read_tokens: 1000, cache_write_tokens: 0 },
        cost_usd: 0.0035,
        latency_ms: 812,
        edit_rate_signal: 'approve',
      });

      const rows = await client.query<{ model: string; in_tokens: number; cache_read_tokens: number; cost_usd: string; edit_rate_signal: string }>(
        'select model, in_tokens, cache_read_tokens, cost_usd, edit_rate_signal from model_calls where run_id = $1',
        [runId],
      );
      expect(rows.rowCount).toBe(1);
      expect(rows.rows[0]).toMatchObject({ model: 'claude-opus-5', in_tokens: 1200, cache_read_tokens: 1000, edit_rate_signal: 'approve' });
      expect(Number(rows.rows[0]?.cost_usd)).toBeCloseTo(0.0035, 6);

      await expect(logger.log({ run_id: null, org_id: null, stage: 'judge', provider: 'x', model: 'y', usage: { in_tokens: 0, out_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0 }, cost_usd: 0, latency_ms: 0, edit_rate_signal: null })).rejects.toThrow(/org_id/);
    } finally {
      await client.query('rollback');
      await client.end();
    }
  });
});
