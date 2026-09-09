// `pnpm compile --org=<id or name> [--budget=<usd>] [--source=<id>]... [--json]`
// One compile run for an org from the database (F-CMP-2): approved sources
// only, budget-capped, artifacts and gaps written back. The stage cache
// (TACIT_STAGE_CACHE_DIR) makes an unchanged re-run free of model spend.
import path from 'node:path';
import pg from 'pg';
import { COMPILE_BUDGETS } from '@tacit/config/compile-budgets';
import { compileOrg } from '@tacit/pipeline';

try {
  process.loadEnvFile(path.resolve(import.meta.dirname, '../../../.env'));
} catch {
  // rely on the environment
}
process.env.TACIT_STAGE_CACHE_DIR ??= path.resolve(import.meta.dirname, '../../../evals/out/stage-cache');

const args = process.argv.slice(2);
const arg = (name: string): string | undefined => args.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const all = (name: string): string[] => args.filter((a) => a.startsWith(`--${name}=`)).map((a) => a.slice(name.length + 3));
const org = arg('org');
if (!org) {
  console.error('usage: pnpm compile --org=<id or name> [--budget=<usd>] [--source=<id>]... [--json]');
  process.exit(2);
}
const budget = Number(arg('budget') ?? COMPILE_BUDGETS.initialCompileUsd);
const json = args.includes('--json');
const log = (line: Record<string, unknown>): void => console.error(JSON.stringify({ ts: new Date().toISOString(), ...line }));

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error('DATABASE_URL is required');
  process.exit(2);
}
const pool = new pg.Pool({ connectionString: databaseUrl });
try {
  const found = await pool.query<{ id: string }>('select id from orgs where id::text = $1 or name = $1 limit 1', [org]);
  const orgId = found.rows[0]?.id;
  if (!orgId) {
    console.error(`no org matches "${org}"`);
    process.exit(2);
  }
  const sourceIds = all('source');
  const result = await compileOrg({ db: pool, orgId, budgetUsd: budget, ...(sourceIds.length ? { sourceIds } : {}), log });
  if (json) console.log(JSON.stringify(result, null, 2));
  else {
    console.log(`compile ${result.runId}: ${result.status} — ${result.items} items → ${result.artifacts} artifacts, ${result.findings} gaps, $${result.cost_usd.toFixed(2)} of $${budget.toFixed(2)}`);
    for (const s of result.stages) console.log(`  ${s.stage.padEnd(10)} ${s.error ? `FAILED: ${s.error}` : `${s.artifacts} artifacts, ${s.findings} findings, ${s.calls} calls (${s.cached} cached), $${s.cost_usd.toFixed(2)}`}`);
    for (const n of result.notes) console.log(`  note: ${n}`);
  }
  process.exitCode = result.status === 'succeeded' ? 0 : 1;
} finally {
  await pool.end();
}
