import { describe, expect, it } from 'vitest';
import { githubAppProvider, googleDriveProvider, signState, slackProvider, verifyState, type FetchFn } from './oauth';

const json = (body: unknown): Response => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });

describe('signed state', () => {
  it('round-trips, rejects tampering, and expires', () => {
    const s = signState('secret', { org: 'org-1', kind: 'slack' });
    expect(verifyState('secret', s)).toMatchObject({ org: 'org-1', kind: 'slack' });
    expect(verifyState('other', s)).toBeNull();
    const [body, sig] = s.split('.');
    expect(verifyState('secret', `${body}x.${sig}`)).toBeNull();
    const expired = signState('secret', { org: 'org-1', kind: 'gdrive', exp: 1 });
    expect(verifyState('secret', expired)).toBeNull();
  });
});

describe('providers', () => {
  it('slack: lists its read-only bot scopes, builds the authorize URL, exchanges the code', async () => {
    const calls: { url: string; body: string }[] = [];
    const fetchFn: FetchFn = async (url, init) => {
      calls.push({ url, body: String(init?.body) });
      return json({ ok: true, access_token: 'xoxb-1', scope: 'channels:read,channels:history', team: { id: 'T1', name: 'Northwind' } });
    };
    const p = slackProvider({ clientId: 'cid', clientSecret: 'sec' }, fetchFn);
    expect(p.scopes).toContain('channels:history');
    expect(p.scopes.some((s) => s.includes('write'))).toBe(false);
    const url = new URL(p.authorizeUrl('st', 'https://admin.test/oauth/slack/callback'));
    expect(url.searchParams.get('scope')).toBe(p.scopes.join(','));
    expect(url.searchParams.get('state')).toBe('st');
    const cred = await p.exchange({ code: 'c0de' }, 'https://admin.test/oauth/slack/callback');
    expect(cred).toEqual({ kind: 'slack', access_token: 'xoxb-1', scopes: ['channels:read', 'channels:history'], account: 'Northwind' });
    expect(calls[0]?.url).toBe('https://slack.com/api/oauth.v2.access');
    expect(calls[0]?.body).toContain('client_secret=sec');
  });

  it('slack: surfaces provider errors instead of storing a bad token', async () => {
    const p = slackProvider({ clientId: 'cid', clientSecret: 'sec' }, async () => json({ ok: false, error: 'invalid_code' }));
    await expect(p.exchange({ code: 'x' }, 'r')).rejects.toThrow('invalid_code');
    await expect(p.exchange({ error: 'access_denied' }, 'r')).rejects.toThrow('access_denied');
  });

  it('google drive: asks for drive.readonly offline, keeps the refresh token, refuses a narrower grant', async () => {
    const p = googleDriveProvider({ clientId: 'g', clientSecret: 's' }, async () => json({ access_token: 'ya29', refresh_token: 'rt', expires_in: 3600, scope: 'https://www.googleapis.com/auth/drive.readonly' }));
    const url = new URL(p.authorizeUrl('st', 'https://admin.test/oauth/gdrive/callback'));
    expect(url.searchParams.get('access_type')).toBe('offline');
    expect(url.searchParams.get('scope')).toBe('https://www.googleapis.com/auth/drive.readonly');
    const cred = await p.exchange({ code: 'c' }, 'https://admin.test/oauth/gdrive/callback');
    expect(cred.refresh_token).toBe('rt');
    expect(cred.expires_at).toBeDefined();
    const narrow = googleDriveProvider({ clientId: 'g', clientSecret: 's' }, async () => json({ access_token: 'ya29', scope: 'openid' }));
    await expect(narrow.exchange({ code: 'c' }, 'r')).rejects.toThrow('not granted');
  });

  it('github app: installation is the consent; the callback carries installation_id', async () => {
    const p = githubAppProvider({ appSlug: 'tacit-dev' });
    expect(p.authorizeUrl('st', 'ignored')).toBe('https://github.com/apps/tacit-dev/installations/new?state=st');
    expect(await p.exchange({ installation_id: '4242', setup_action: 'install' }, 'r')).toMatchObject({ kind: 'github', installation_id: 4242 });
    await expect(p.exchange({}, 'r')).rejects.toThrow('installation_id');
  });
});
