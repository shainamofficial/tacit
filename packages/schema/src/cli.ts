// pnpm db:migrate            -> apply pending migrations
// pnpm db:reset [--seed=X]   -> drop + recreate public schema, migrate, (seed: Phase 0)
import path from 'node:path';
import pg from 'pg';
import { migrate, resetSchema } from './migrate';

const USAGE = 'usage: tsx packages/schema/src/cli.ts <migrate | reset [--seed=<name>] [--force]>';

function loadEnv(): void {
  try {
    process.loadEnvFile(path.resolve(import.meta.dirname, '../../../.env'));
  } catch {
    // no .env at the repo root: rely on the process environment
  }
}

function isLocal(databaseUrl: string): boolean {
  const host = new URL(databaseUrl).hostname;
  return host === 'localhost' || host === '127.0.0.1' || host === '[::1]';
}

function redact(databaseUrl: string): string {
  return databaseUrl.replace(/\/\/([^:/@]+):[^@]*@/, '//$1:***@');
}

async function main(argv: readonly string[]): Promise<number> {
  loadEnv();
  const [command = '', ...rest] = argv;
  const flags = new Map<string, string>();
  for (const arg of rest) {
    const match = /^--([a-z][a-z-]*)(?:=(.*))?$/.exec(arg);
    const [, key, value] = match ?? [];
    if (!key) {
      console.error(`unknown argument: ${arg}\n${USAGE}`);
      return 2;
    }
    flags.set(key, value ?? 'true');
  }
  if (command !== 'migrate' && command !== 'reset') {
    console.error(USAGE);
    return 2;
  }

  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error('DATABASE_URL is not set. Copy .env.example to .env or export it.');
    return 2;
  }
  if (command === 'reset' && !isLocal(databaseUrl) && flags.get('force') !== 'true') {
    console.error(
      `refusing to reset non-local database ${redact(databaseUrl)} (pass --force to override)`,
    );
    return 2;
  }

  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    if (command === 'reset') {
      await resetSchema(client);
      console.log(`schema reset on ${redact(databaseUrl)}`);
    }
    const result = await migrate(client);
    console.log(
      `migrations: ${result.applied.length} applied, ${result.skipped.length} already applied`,
    );
    for (const name of result.applied) console.log(`  + ${name}`);

    const seed = flags.get('seed');
    if (seed !== undefined) {
      console.error(
        `seed '${seed}' is not available yet: seeding lands with the Northwind corpus ` +
          'in Phase 0 (docs/implementation-plan.md §4).',
      );
      return 1;
    }
    return 0;
  } finally {
    await client.end();
  }
}

process.exitCode = await main(process.argv.slice(2));
