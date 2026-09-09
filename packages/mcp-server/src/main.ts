// `pnpm mcp` — serve compiled knowledge over MCP.
//   TACIT_MCP_SOURCE  "snapshot" (default) or "pg"
//   TACIT_MCP_DATA    snapshot directory written by `pnpm eval --serve-out=<dir>` (default evals/out/serve)
//   TACIT_ORG_ID      the org to serve when TACIT_MCP_SOURCE=pg
//   TACIT_MCP_TOKENS  JSON array of {token, email, org_id} (per-user bearer tokens)
//   DATABASE_URL      required for pg; when set with a snapshot, query misses are written to the gaps table
//   PORT / HOST       default 3333 / 127.0.0.1 (the container sets HOST=0.0.0.0)
import path from 'node:path';
import pg from 'pg';
import { PgArtifactStore, PgScopeResolver, SnapshotStore, type ArtifactSource, type ScopeResolver } from '@tacit/artifacts';
import { StaticTokenAuthenticator } from './auth';
import { MemoryGapSink, PgGapSink } from './gaps';
import { startHttpServer } from './http';

try {
  process.loadEnvFile(path.resolve(import.meta.dirname, '../../../.env'));
} catch {
  // no .env: rely on the environment
}

const log = (line: Record<string, unknown>): void => console.error(JSON.stringify({ ts: new Date().toISOString(), ...line }));
const mode = process.env.TACIT_MCP_SOURCE ?? 'snapshot';
const auth = StaticTokenAuthenticator.fromEnv(process.env.TACIT_MCP_TOKENS);
const pool = process.env.DATABASE_URL ? new pg.Pool({ connectionString: process.env.DATABASE_URL }) : null;
const gaps = pool ? new PgGapSink(pool) : new MemoryGapSink();

let source: ArtifactSource;
let scopes: ScopeResolver;
let detail: Record<string, unknown>;
if (mode === 'pg') {
  if (!pool) throw new Error('TACIT_MCP_SOURCE=pg needs DATABASE_URL');
  const orgId = process.env.TACIT_ORG_ID;
  if (!orgId) throw new Error('TACIT_MCP_SOURCE=pg needs TACIT_ORG_ID');
  source = new PgArtifactStore(pool);
  scopes = new PgScopeResolver(pool);
  detail = { org_id: orgId, artifacts: (await source.artifacts(orgId)).length };
} else {
  const dataDir = process.env.TACIT_MCP_DATA ?? path.resolve(import.meta.dirname, '../../../evals/out/serve');
  const snapshot = SnapshotStore.load(dataDir);
  source = snapshot;
  scopes = snapshot;
  detail = { org_id: snapshot.snapshot.org_id, artifacts: snapshot.snapshot.artifacts.length, data: dataDir };
}

const { url } = await startHttpServer({ source, scopes, gaps, auth, log }, Number(process.env.PORT ?? 3333), process.env.HOST ?? '127.0.0.1');
log({ event: 'mcp_listening', url, source: mode, ...detail, gap_sink: pool ? 'postgres' : 'memory' });
