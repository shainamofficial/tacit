// Where OAuth tokens live. `sources.oauth_ref` is a reference, never the
// token: tokens are sealed with AES-256-GCM under a master key and stored in
// `source_credentials` (schema PR 0004, proposed alongside this session). The
// admin server works with the in-memory store until that table exists.
import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from 'node:crypto';
import type { Queryable } from '@tacit/artifacts';
import { z } from 'zod';
import type { Credential } from './oauth';

export interface CredentialStore {
  /** Seal and store; returns the reference to keep on the source row. */
  put(orgId: string, credential: Credential): Promise<string>;
  get(ref: string): Promise<Credential | null>;
  revoke(ref: string): Promise<void>;
}

const CredentialSchema = z.object({
  kind: z.enum(['slack', 'gdrive', 'github']),
  access_token: z.string().optional(),
  refresh_token: z.string().optional(),
  expires_at: z.string().optional(),
  installation_id: z.number().int().optional(),
  account: z.string().optional(),
  scopes: z.array(z.string()),
});

export class MemoryCredentialStore implements CredentialStore {
  private readonly rows = new Map<string, { orgId: string; credential: Credential; revoked: boolean }>();
  async put(orgId: string, credential: Credential): Promise<string> {
    const ref = `mem:${randomUUID()}`;
    this.rows.set(ref, { orgId, credential, revoked: false });
    return ref;
  }
  async get(ref: string): Promise<Credential | null> {
    const row = this.rows.get(ref);
    return row && !row.revoked ? row.credential : null;
  }
  async revoke(ref: string): Promise<void> {
    const row = this.rows.get(ref);
    if (row) row.revoked = true;
  }
}

// ---- sealing
export function masterKeyFromEnv(value: string | undefined): Buffer {
  if (!value) throw new Error('TACIT_MASTER_KEY is required to store credentials (32 bytes, hex or base64)');
  const buf = /^[0-9a-fA-F]{64}$/.test(value) ? Buffer.from(value, 'hex') : Buffer.from(value, 'base64');
  if (buf.length !== 32) throw new Error('TACIT_MASTER_KEY must decode to 32 bytes');
  return buf;
}

export function seal(key: Buffer, plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return `v1.${iv.toString('base64url')}.${cipher.getAuthTag().toString('base64url')}.${ct.toString('base64url')}`;
}

export function open(key: Buffer, sealed: string): string {
  const [v, iv, tag, ct] = sealed.split('.');
  if (v !== 'v1' || !iv || !tag || !ct) throw new Error('sealed credential has an unknown format');
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64url'));
  decipher.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([decipher.update(Buffer.from(ct, 'base64url')), decipher.final()]).toString('utf8');
}

/** Targets the proposed `source_credentials(id, org_id, kind, ciphertext, created_at, revoked_at)` table. */
export class EncryptedPgCredentialStore implements CredentialStore {
  constructor(
    private readonly db: Queryable,
    private readonly key: Buffer,
  ) {}
  async put(orgId: string, credential: Credential): Promise<string> {
    const row = await this.db.query<{ id: string }>('insert into source_credentials (org_id, kind, ciphertext) values ($1, $2, $3) returning id', [orgId, credential.kind, seal(this.key, JSON.stringify(credential))]);
    const id = row.rows[0]?.id;
    if (!id) throw new Error('credential insert returned no id');
    return `pg:${id}`;
  }
  async get(ref: string): Promise<Credential | null> {
    if (!ref.startsWith('pg:')) return null;
    const row = await this.db.query<{ ciphertext: string }>('select ciphertext from source_credentials where id = $1 and revoked_at is null', [ref.slice(3)]);
    const sealed = row.rows[0]?.ciphertext;
    if (!sealed) return null;
    const p = CredentialSchema.parse(JSON.parse(open(this.key, sealed)));
    return {
      kind: p.kind,
      scopes: p.scopes,
      ...(p.access_token !== undefined ? { access_token: p.access_token } : {}),
      ...(p.refresh_token !== undefined ? { refresh_token: p.refresh_token } : {}),
      ...(p.expires_at !== undefined ? { expires_at: p.expires_at } : {}),
      ...(p.installation_id !== undefined ? { installation_id: p.installation_id } : {}),
      ...(p.account !== undefined ? { account: p.account } : {}),
    };
  }
  async revoke(ref: string): Promise<void> {
    if (ref.startsWith('pg:')) await this.db.query('update source_credentials set revoked_at = now() where id = $1 and revoked_at is null', [ref.slice(3)]);
  }
}
