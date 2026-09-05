// Plain SQL migration runner. Boring on purpose: files in ./migrations named
// NNNN_name.sql, applied in order inside a transaction each, tracked in
// schema_migrations with a content checksum so an applied file can never be
// silently edited (write a new migration instead).
import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import type pg from 'pg';

export const MIGRATIONS_DIR = path.resolve(import.meta.dirname, '../migrations');

// Session-level advisory lock so two runners (e.g. two workers booting) serialize.
const LOCK_KEY = 7_400_001;

export interface Migration {
  readonly name: string;
  readonly sql: string;
  readonly checksum: string;
}

export interface MigrateResult {
  readonly applied: readonly string[];
  readonly skipped: readonly string[];
}

export function checksum(sql: string): string {
  // Normalize line endings so Windows checkouts and Linux CI agree.
  return createHash('sha256').update(sql.replace(/\r\n/g, '\n')).digest('hex');
}

export async function loadMigrations(dir: string = MIGRATIONS_DIR): Promise<Migration[]> {
  const names = (await readdir(dir)).filter((f) => /^\d{4}_[a-z0-9_]+\.sql$/.test(f)).sort();
  return Promise.all(
    names.map(async (name) => {
      const sql = await readFile(path.join(dir, name), 'utf8');
      return { name, sql, checksum: checksum(sql) };
    }),
  );
}

export async function migrate(
  client: pg.Client,
  migrations?: readonly Migration[],
): Promise<MigrateResult> {
  const todo = migrations ?? (await loadMigrations());
  await client.query(`
    create table if not exists schema_migrations (
      name        text primary key,
      checksum    text not null,
      applied_at  timestamptz not null default now()
    )`);

  await client.query('select pg_advisory_lock($1)', [LOCK_KEY]);
  const applied: string[] = [];
  const skipped: string[] = [];
  try {
    const { rows } = await client.query<{ name: string; checksum: string }>(
      'select name, checksum from schema_migrations',
    );
    const done = new Map(rows.map((r) => [r.name, r.checksum] as const));

    for (const m of todo) {
      const previous = done.get(m.name);
      if (previous !== undefined) {
        if (previous !== m.checksum) {
          throw new Error(
            `Migration ${m.name} was modified after it was applied (checksum mismatch). ` +
              'Write a new migration instead of editing an applied one.',
          );
        }
        skipped.push(m.name);
        continue;
      }

      await client.query('begin');
      try {
        await client.query(m.sql);
        await client.query('insert into schema_migrations (name, checksum) values ($1, $2)', [
          m.name,
          m.checksum,
        ]);
        await client.query('commit');
      } catch (err) {
        await client.query('rollback');
        const reason = err instanceof Error ? err.message : String(err);
        throw new Error(`Migration ${m.name} failed: ${reason}`, { cause: err });
      }
      applied.push(m.name);
    }
  } finally {
    await client.query('select pg_advisory_unlock($1)', [LOCK_KEY]);
  }
  return { applied, skipped };
}

/** Drops everything in `public` (local/dev only — the CLI guards non-local URLs). */
export async function resetSchema(client: pg.Client): Promise<void> {
  await client.query('drop schema if exists public cascade');
  await client.query('create schema public');
}
