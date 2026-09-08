// Read-only OAuth per source (F-ING-1): each provider declares the exact scopes
// it will ask for, and the connect page lists them before the redirect. State
// is HMAC-signed so a callback can only complete a connect this server began.
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { DRIVE_READONLY_SCOPE } from '@tacit/connector-gdrive';
import { SLACK_BOT_SCOPES } from '@tacit/connector-slack';
import { z } from 'zod';

export type SourceKind = 'slack' | 'gdrive' | 'github';

export interface Credential {
  readonly kind: SourceKind;
  readonly access_token?: string;
  readonly refresh_token?: string;
  readonly expires_at?: string;
  readonly installation_id?: number;
  /** workspace / account label for the UI */
  readonly account?: string;
  readonly scopes: readonly string[];
}

export interface OAuthProvider {
  readonly kind: SourceKind;
  readonly label: string;
  /** Scopes requested, shown to the admin at connect time (F-ING-1). */
  readonly scopes: readonly string[];
  /** One line on what the scopes allow, in plain words. */
  readonly access: string;
  authorizeUrl(state: string, redirectUri: string): string;
  /** Turn the callback query into a credential. Throws on provider errors. */
  exchange(params: Readonly<Record<string, string>>, redirectUri: string): Promise<Credential>;
}

export type FetchFn = (url: string, init?: RequestInit) => Promise<Response>;

// ---- signed state
const StatePayload = z.object({ org: z.string().min(1), kind: z.enum(['slack', 'gdrive', 'github']), exp: z.number().int(), nonce: z.string().min(8) });
export type StatePayload = z.infer<typeof StatePayload>;

const b64u = (b: Buffer): string => b.toString('base64url');
const sign = (secret: string, body: string): string => b64u(createHmac('sha256', secret).update(body).digest());

export function signState(secret: string, payload: Omit<StatePayload, 'nonce' | 'exp'> & { exp?: number }): string {
  const full: StatePayload = { ...payload, exp: payload.exp ?? Math.floor(Date.now() / 1000) + 15 * 60, nonce: b64u(randomBytes(9)) };
  const body = b64u(Buffer.from(JSON.stringify(full)));
  return `${body}.${sign(secret, body)}`;
}

export function verifyState(secret: string, state: string, now = Math.floor(Date.now() / 1000)): StatePayload | null {
  const [body, sig] = state.split('.');
  if (!body || !sig) return null;
  const expected = Buffer.from(sign(secret, body));
  const given = Buffer.from(sig);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
  try {
    const payload = StatePayload.parse(JSON.parse(Buffer.from(body, 'base64url').toString('utf8')));
    return payload.exp >= now ? payload : null;
  } catch {
    return null;
  }
}

// ---- providers
const form = (fields: Record<string, string>): string => new URLSearchParams(fields).toString();

const SlackAccess = z.object({ ok: z.boolean(), error: z.string().optional(), access_token: z.string().optional(), scope: z.string().optional(), team: z.object({ id: z.string(), name: z.string().optional() }).optional() });

export function slackProvider(cfg: { clientId: string; clientSecret: string }, fetchFn: FetchFn = fetch): OAuthProvider {
  return {
    kind: 'slack',
    label: 'Slack',
    scopes: SLACK_BOT_SCOPES,
    access: 'Read channels the bot is invited to, their membership, and the user directory. No posting, no DMs read unless invited.',
    authorizeUrl: (state, redirectUri) => `https://slack.com/oauth/v2/authorize?${form({ client_id: cfg.clientId, scope: SLACK_BOT_SCOPES.join(','), redirect_uri: redirectUri, state })}`,
    async exchange(params, redirectUri) {
      const code = params.code;
      if (!code) throw new Error(`slack: ${params.error ?? 'no code in callback'}`);
      const res = await fetchFn('https://slack.com/api/oauth.v2.access', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: form({ client_id: cfg.clientId, client_secret: cfg.clientSecret, code, redirect_uri: redirectUri }) });
      const body = SlackAccess.parse(await res.json());
      if (!body.ok || !body.access_token) throw new Error(`slack: ${body.error ?? 'token exchange failed'}`);
      return { kind: 'slack', access_token: body.access_token, scopes: (body.scope ?? '').split(',').filter(Boolean), ...(body.team ? { account: body.team.name ?? body.team.id } : {}) };
    },
  };
}

const GoogleToken = z.object({ access_token: z.string(), refresh_token: z.string().optional(), expires_in: z.number().optional(), scope: z.string().optional(), error: z.string().optional() });

export function googleDriveProvider(cfg: { clientId: string; clientSecret: string }, fetchFn: FetchFn = fetch): OAuthProvider {
  return {
    kind: 'gdrive',
    label: 'Google Drive',
    scopes: [DRIVE_READONLY_SCOPE],
    access: 'Read files, folders, and their sharing settings in the connecting account. Never write or share.',
    authorizeUrl: (state, redirectUri) =>
      `https://accounts.google.com/o/oauth2/v2/auth?${form({ client_id: cfg.clientId, redirect_uri: redirectUri, response_type: 'code', scope: DRIVE_READONLY_SCOPE, access_type: 'offline', prompt: 'consent', include_granted_scopes: 'false', state })}`,
    async exchange(params, redirectUri) {
      const code = params.code;
      if (!code) throw new Error(`google: ${params.error ?? 'no code in callback'}`);
      const res = await fetchFn('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: form({ code, client_id: cfg.clientId, client_secret: cfg.clientSecret, redirect_uri: redirectUri, grant_type: 'authorization_code' }) });
      const body = GoogleToken.parse(await res.json());
      if (body.error) throw new Error(`google: ${body.error}`);
      const granted = (body.scope ?? '').split(' ').filter(Boolean);
      if (granted.length > 0 && !granted.includes(DRIVE_READONLY_SCOPE)) throw new Error('google: drive.readonly scope was not granted');
      return {
        kind: 'gdrive',
        access_token: body.access_token,
        ...(body.refresh_token ? { refresh_token: body.refresh_token } : {}),
        ...(body.expires_in ? { expires_at: new Date(Date.now() + body.expires_in * 1000).toISOString() } : {}),
        scopes: granted.length ? granted : [DRIVE_READONLY_SCOPE],
      };
    },
  };
}

/** GitHub Apps: installing the app is the consent; the callback carries installation_id, no secret exchange. */
export function githubAppProvider(cfg: { appSlug: string; permissions?: readonly string[] }): OAuthProvider {
  const scopes = cfg.permissions ?? ['contents: read', 'metadata: read', 'pull_requests: read'];
  return {
    kind: 'github',
    label: 'GitHub',
    scopes,
    access: 'Read the repositories you select during installation: code, metadata, and merged pull requests. Webhook on merge to main.',
    authorizeUrl: (state) => `https://github.com/apps/${cfg.appSlug}/installations/new?${form({ state })}`,
    async exchange(params) {
      const id = Number(params.installation_id);
      if (!Number.isInteger(id) || id <= 0) throw new Error('github: no installation_id in callback');
      return { kind: 'github', installation_id: id, scopes, ...(params.setup_action ? { account: `installation ${id} (${params.setup_action})` } : {}) };
    },
  };
}
