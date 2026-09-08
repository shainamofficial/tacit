// Per-user auth on the MCP connection (F-SRV-3). The connection identifies a
// person, and every retrieval is filtered against that person's scopes.
//
// P0 ships a static bearer-token authenticator (tokens issued by the admin
// app, configured through the environment) behind the same interface the
// per-user OAuth flow will implement. Tokens are compared in constant time.
import { createHash, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';

export interface McpUser {
  readonly email: string;
  readonly orgId: string;
}

export interface Authenticator {
  /** The user behind a bearer token, or null when the token is unknown. */
  authenticate(token: string): Promise<McpUser | null>;
}

const TokenEntry = z.object({ token: z.string().min(16), email: z.string().email(), org_id: z.string().min(1) });
export const TokenTable = z.array(TokenEntry);

const digest = (s: string): Buffer => createHash('sha256').update(s).digest();

export class StaticTokenAuthenticator implements Authenticator {
  private readonly entries: readonly { hash: Buffer; user: McpUser }[];

  constructor(entries: readonly z.infer<typeof TokenEntry>[]) {
    this.entries = entries.map((e) => ({ hash: digest(e.token), user: { email: e.email.toLowerCase(), orgId: e.org_id } }));
  }

  /** `TACIT_MCP_TOKENS='[{"token":"…","email":"…","org_id":"…"}]'` */
  static fromEnv(json: string | undefined): StaticTokenAuthenticator {
    if (!json) return new StaticTokenAuthenticator([]);
    return new StaticTokenAuthenticator(TokenTable.parse(JSON.parse(json)));
  }

  async authenticate(token: string): Promise<McpUser | null> {
    const h = digest(token);
    for (const e of this.entries) if (timingSafeEqual(h, e.hash)) return e.user;
    return null;
  }
}
