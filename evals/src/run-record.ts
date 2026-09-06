// An eval run is a real pipeline_runs row when a database is available, so
// every model call the stages make lands in model_calls with valid FKs and
// the $/compile trail is queryable. Without DATABASE_URL the gateway has no
// logger either, so placeholder ids are fine.
import pg from 'pg';

export interface EvalRun {
  readonly orgId: string;
  readonly runId: string;
  close(status: 'succeeded' | 'failed', spentUsd: number): Promise<void>;
}

const EVAL_ORG_NAME = 'northwind-eval';

export async function openEvalRun(kind: string, budgetUsd: number, databaseUrl = process.env.DATABASE_URL): Promise<EvalRun> {
  if (!databaseUrl) {
    return { orgId: 'northwind', runId: `eval-${kind}`, close: async () => undefined };
  }
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    const existing = await client.query<{ id: string }>('select id from orgs where name = $1 limit 1', [EVAL_ORG_NAME]);
    let orgId = existing.rows[0]?.id;
    if (!orgId) {
      const created = await client.query<{ id: string }>('insert into orgs (name) values ($1) returning id', [EVAL_ORG_NAME]);
      orgId = created.rows[0]?.id;
    }
    if (!orgId) throw new Error('could not create the eval org');
    const run = await client.query<{ id: string }>(
      "insert into pipeline_runs (org_id, kind, status, budget_usd, started_at, detail) values ($1, 'eval', 'running', $2, now(), $3) returning id",
      [orgId, budgetUsd, JSON.stringify({ stage: kind })],
    );
    const runId = run.rows[0]?.id;
    if (!runId) throw new Error('could not create the eval pipeline_runs row');
    return {
      orgId,
      runId,
      async close(status, spentUsd) {
        const c = new pg.Client({ connectionString: databaseUrl });
        await c.connect();
        try {
          await c.query('update pipeline_runs set status = $2, spent_usd = $3, finished_at = now() where id = $1', [runId, status, spentUsd]);
        } finally {
          await c.end();
        }
      },
    };
  } finally {
    await client.end();
  }
}
