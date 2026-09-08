import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { EncryptedPgCredentialStore, MemoryCredentialStore, masterKeyFromEnv, open, seal } from './credentials';

describe('sealing', () => {
  it('round-trips under the master key and fails closed on tampering or the wrong key', () => {
    const key = randomBytes(32);
    const sealed = seal(key, '{"kind":"slack","access_token":"xoxb-secret","scopes":[]}');
    expect(sealed).not.toContain('xoxb');
    expect(open(key, sealed)).toContain('xoxb-secret');
    expect(() => open(randomBytes(32), sealed)).toThrow();
    const [v, iv, tag, ct] = sealed.split('.');
    expect(() => open(key, `${v}.${iv}.${tag}.${ct?.slice(0, -2)}AA`)).toThrow();
  });

  it('parses the master key from hex or base64 and rejects the wrong length', () => {
    const key = randomBytes(32);
    expect(masterKeyFromEnv(key.toString('hex')).equals(key)).toBe(true);
    expect(masterKeyFromEnv(key.toString('base64')).equals(key)).toBe(true);
    expect(() => masterKeyFromEnv('too-short')).toThrow('32 bytes');
    expect(() => masterKeyFromEnv(undefined)).toThrow('TACIT_MASTER_KEY');
  });
});

describe('stores', () => {
  it('memory store returns a reference, not the token, and honours revocation', async () => {
    const store = new MemoryCredentialStore();
    const ref = await store.put('org', { kind: 'slack', access_token: 'xoxb', scopes: ['channels:read'] });
    expect(ref).not.toContain('xoxb');
    expect((await store.get(ref))?.access_token).toBe('xoxb');
    await store.revoke(ref);
    expect(await store.get(ref)).toBeNull();
  });

  it('pg store writes only ciphertext and reads it back through the key', async () => {
    const key = randomBytes(32);
    const rows = new Map<string, string>();
    const db = {
      async query<R>(text: string, values: unknown[] = []): Promise<{ rows: R[]; rowCount: number }> {
        if (text.startsWith('insert')) {
          expect(String(values[2])).not.toContain('xoxb');
          rows.set('id-1', String(values[2]));
          return { rows: [{ id: 'id-1' } as R], rowCount: 1 };
        }
        if (text.startsWith('select')) return { rows: rows.has(String(values[0])) ? [{ ciphertext: rows.get(String(values[0])) } as R] : [], rowCount: 1 };
        rows.delete(String(values[0]));
        return { rows: [], rowCount: 1 };
      },
    };
    const store = new EncryptedPgCredentialStore(db as never, key);
    const ref = await store.put('org', { kind: 'gdrive', access_token: 'xoxb-like', refresh_token: 'r', scopes: ['drive.readonly'] });
    expect(ref).toBe('pg:id-1');
    expect((await store.get(ref))?.refresh_token).toBe('r');
    await store.revoke(ref);
    expect(await store.get(ref)).toBeNull();
    expect(await store.get('mem:whatever')).toBeNull();
  });
});
