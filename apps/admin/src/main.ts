// `pnpm admin` — the connect flow (F-ADM-1) for one org.
//   TACIT_ORG_ID          the org this admin instance manages
//   TACIT_ADMIN_TOKEN     champion's admin token (and OAuth state secret)
//   TACIT_PUBLIC_URL      public origin for OAuth redirect URIs (default http://127.0.0.1:3400)
//   TACIT_MASTER_KEY      32-byte key sealing stored tokens (source_credentials table, schema PR 0004);
//                         without it tokens are kept in memory for the life of the process
//   DATABASE_URL          sources/orgs/sync_items
//   SLACK_CLIENT_ID / SLACK_CLIENT_SECRET, GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET, GITHUB_APP_SLUG (+ GITHUB_APP_ID / GITHUB_APP_PRIVATE_KEY for the catalog)
//   PORT / HOST           default 3400 / 127.0.0.1 (the container sets HOST=0.0.0.0)
import path from 'node:path';
import pg from 'pg';
import { EncryptedPgCredentialStore, MemoryCredentialStore, masterKeyFromEnv } from './credentials';
import { PgAdminDb } from './db';
import { githubAppProvider, googleDriveProvider, slackProvider, type OAuthProvider, type SourceKind } from './oauth';
import { startAdminServer } from './server';
import { connectorCatalog } from './wiring';

try {
  process.loadEnvFile(path.resolve(import.meta.dirname, '../../../.env'));
} catch {
  // no .env: rely on the environment
}
const env = process.env;
const need = (k: string): string => {
  const v = env[k];
  if (!v) throw new Error(`${k} is required`);
  return v;
};
const log = (line: Record<string, unknown>): void => console.error(JSON.stringify({ ts: new Date().toISOString(), ...line }));

const pool = new pg.Pool({ connectionString: need('DATABASE_URL') });
const providers: Partial<Record<SourceKind, OAuthProvider>> = {};
if (env.SLACK_CLIENT_ID && env.SLACK_CLIENT_SECRET) providers.slack = slackProvider({ clientId: env.SLACK_CLIENT_ID, clientSecret: env.SLACK_CLIENT_SECRET });
if (env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET) providers.gdrive = googleDriveProvider({ clientId: env.GOOGLE_CLIENT_ID, clientSecret: env.GOOGLE_CLIENT_SECRET });
if (env.GITHUB_APP_SLUG) providers.github = githubAppProvider({ appSlug: env.GITHUB_APP_SLUG });

const credentials = env.TACIT_MASTER_KEY ? new EncryptedPgCredentialStore(pool, masterKeyFromEnv(env.TACIT_MASTER_KEY)) : new MemoryCredentialStore();
if (!env.TACIT_MASTER_KEY) log({ event: 'admin_credentials_in_memory', note: 'set TACIT_MASTER_KEY to seal tokens into source_credentials' });

const { url } = await startAdminServer(
  {
    orgId: need('TACIT_ORG_ID'),
    db: new PgAdminDb(pool),
    credentials,
    providers,
    catalog: connectorCatalog({
      google: env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET ? { clientId: env.GOOGLE_CLIENT_ID, clientSecret: env.GOOGLE_CLIENT_SECRET } : null,
      githubApp: env.GITHUB_APP_ID && env.GITHUB_APP_PRIVATE_KEY ? { appId: env.GITHUB_APP_ID, privateKey: env.GITHUB_APP_PRIVATE_KEY } : null,
    }),
    adminToken: need('TACIT_ADMIN_TOKEN'),
    publicUrl: env.TACIT_PUBLIC_URL ?? `http://127.0.0.1:${env.PORT ?? 3400}`,
    log,
  },
  Number(env.PORT ?? 3400),
  env.HOST ?? '127.0.0.1',
);
log({ event: 'admin_listening', url, providers: Object.keys(providers), credential_store: env.TACIT_MASTER_KEY ? 'postgres-sealed' : 'memory' });
