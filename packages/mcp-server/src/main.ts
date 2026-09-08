// `pnpm mcp` — serve a compiled snapshot over MCP.
//   TACIT_MCP_DATA    directory written by `pnpm eval --serve-out=<dir>` (default evals/out/serve)
//   TACIT_MCP_TOKENS  JSON array of {token, email, org_id} (per-user bearer tokens)
//   DATABASE_URL      when set, query misses are written to the gaps table; otherwise kept in memory
//   PORT              default 3333
import path from 'node:path';
import pg from 'pg';
import { SnapshotStore } from '@tacit/artifacts';
import { StaticTokenAuthenticator } from './auth';
import { MemoryGapSink, PgGapSink } from './gaps';
import { startHttpServer } from './http';

try {
  process.loadEnvFile(path.resolve(import.meta.dirname, '../../../.env'));
} catch {
  // no .env: rely on the environment
}

const log = (line: Record<string, unknown>): void => console.error(JSON.stringify({ ts: new Date().toISOString(), ...line }));
const dataDir = process.env.TACIT_MCP_DATA ?? path.resolve(import.meta.dirname, '../../../evals/out/serve');
const auth = StaticTokenAuthenticator.fromEnv(process.env.TACIT_MCP_TOKENS);
const pool = process.env.DATABASE_URL ? new pg.Pool({ connectionString: process.env.DATABASE_URL }) : null;
const gaps = pool ? new PgGapSink(pool) : new MemoryGapSink();

const snapshot = SnapshotStore.load(dataDir);
const { url } = await startHttpServer({ source: snapshot, scopes: snapshot, gaps, auth, log }, Number(process.env.PORT ?? 3333));
log({ event: 'mcp_listening', url, org_id: snapshot.snapshot.org_id, artifacts: snapshot.snapshot.artifacts.length, gap_sink: pool ? 'postgres' : 'memory' });
