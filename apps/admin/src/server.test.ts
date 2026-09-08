import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { StaticCatalog } from './catalog';
import { MemoryCredentialStore } from './credentials';
import { MemoryAdminDb } from './db';
import { signState, type OAuthProvider } from './oauth';
import { startAdminServer } from './server';

const ORG = 'org-1';
const TOKEN = 'admin-token-0123456789';

const fakeSlack: OAuthProvider = {
  kind: 'slack',
  label: 'Slack',
  scopes: ['channels:read', 'channels:history'],
  access: 'Read channels.',
  authorizeUrl: (state, redirectUri) => `https://slack.test/authorize?state=${state}&redirect_uri=${encodeURIComponent(redirectUri)}`,
  async exchange(params) {
    if (params.code !== 'good') throw new Error('slack: invalid_code');
    return { kind: 'slack', access_token: 'xoxb-secret', scopes: ['channels:read'], account: 'Northwind' };
  },
};

describe('admin connect flow', () => {
  const db = new MemoryAdminDb({ id: ORG, name: 'Northwind Robotics' });
  const credentials = new MemoryCredentialStore();
  const catalog = new StaticCatalog({ slack: [{ id: 'C1', label: '#billing' }, { id: 'C2', label: '#exec', detail: 'private' }, { id: 'C3', label: '#random' }] });
  let base = '';
  let close: () => void = () => undefined;
  const auth = { cookie: `tacit_admin=${TOKEN}` };
  const get = (path: string, headers: Record<string, string> = auth): Promise<Response> => fetch(`${base}${path}`, { headers, redirect: 'manual' });
  const post = (path: string, body: URLSearchParams): Promise<Response> => fetch(`${base}${path}`, { method: 'POST', headers: { ...auth, 'content-type': 'application/x-www-form-urlencoded' }, body, redirect: 'manual' });

  beforeAll(async () => {
    const started = await startAdminServer({ orgId: ORG, db, credentials, providers: { slack: fakeSlack }, catalog, adminToken: TOKEN, publicUrl: 'https://admin.test' }, 0);
    base = started.url;
    close = () => started.server.close();
  });
  afterAll(() => close());

  it('requires the admin token and sets it as a cookie via /login', async () => {
    expect((await get('/', {})).status).toBe(401);
    expect((await get('/login?token=wrong', {})).status).toBe(401);
    const login = await get(`/login?token=${TOKEN}`, {});
    expect(login.status).toBe(303);
    expect(login.headers.get('set-cookie')).toContain('tacit_admin=');
    expect((await get('/', { authorization: `Bearer ${TOKEN}` })).status).toBe(200);
  });

  it('lists the exact read-only scopes before redirecting to the provider (F-ING-1)', async () => {
    const res = await get('/connect/slack');
    const html = await res.text();
    expect(html).toContain('<code>channels:read</code>');
    expect(html).toContain('<code>channels:history</code>');
    expect(html).toContain('https://slack.test/authorize?state=');
    expect(html).toContain(encodeURIComponent('https://admin.test/oauth/slack/callback'));
    expect((await get('/connect/gdrive')).status).toBe(404);
  });

  it('rejects callbacks with foreign or tampered state, and never stores a token on a failed exchange', async () => {
    expect((await get('/oauth/slack/callback?code=good')).status).toBe(400);
    const foreign = signState('other-secret', { org: ORG, kind: 'slack' });
    expect((await get(`/oauth/slack/callback?code=good&state=${foreign}`)).status).toBe(400);
    const wrongKind = signState(TOKEN, { org: ORG, kind: 'gdrive' });
    expect((await get(`/oauth/slack/callback?code=good&state=${wrongKind}`)).status).toBe(400);
    const bad = await get(`/oauth/slack/callback?code=bad&state=${signState(TOKEN, { org: ORG, kind: 'slack' })}`);
    expect(bad.status).toBe(502);
    expect(await db.listSources(ORG)).toHaveLength(0);
  });

  it('completes the connect: sealed credential, source row, scope picker, permission review, approval bound to the ACL digest', async () => {
    const cb = await get(`/oauth/slack/callback?code=good&state=${signState(TOKEN, { org: ORG, kind: 'slack' })}`);
    expect(cb.status).toBe(303);
    const sources = await db.listSources(ORG);
    expect(sources).toHaveLength(1);
    const src = sources[0]!;
    expect(cb.headers.get('location')).toBe(`/sources/${src.id}/scope`);
    expect(src.oauth_ref).toMatch(/^mem:/);
    expect(JSON.stringify(src)).not.toContain('xoxb');

    const scopeHtml = await (await get(`/sources/${src.id}/scope`)).text();
    expect(scopeHtml).toContain('#billing');
    expect(scopeHtml).toContain('3 channels');
    // Exclude #exec (F-ING-4)
    const saved = await post(`/sources/${src.id}/scope`, new URLSearchParams([['include', 'C1'], ['include', 'C3'], ['include', 'C999']]));
    expect(saved.status).toBe(303);
    expect((await db.source(src.id))?.scope_config).toEqual({ include: ['C1', 'C3'], exclude: ['C2'] });
    expect(await (await get(`/sources/${src.id}/scope`)).text()).toContain('excluded');

    // Permission review from captured ACLs
    db.acls.set(src.id, [
      { acl: { kind: 'domain', domain: 'northwind.example' }, items: 40, samples: ['#billing: refund question'] },
      { acl: { kind: 'users', emails: ['alice.chen@northwind.example', 'tom.nakamura@northwind.example'] }, items: 5, samples: ['#exec: acquisition'] },
    ]);
    const review = await (await get(`/sources/${src.id}/permissions`)).text();
    expect(review).toContain('Everyone at northwind.example');
    expect(review).toContain('2 people');
    expect(review).toContain('alice.chen@northwind.example');
    expect(review).toContain('45 items, 5 restricted');
    expect(review).toContain('>pending<');
    const digest = /name="digest" value="([0-9a-f]+)"/.exec(review)?.[1] ?? '';
    expect(digest).toHaveLength(16);

    expect(await (await post(`/sources/${src.id}/permissions`, new URLSearchParams({ digest: 'stale-digest' }))).text()).toContain('review again');
    const approved = await (await post(`/sources/${src.id}/permissions`, new URLSearchParams({ digest }))).text();
    expect(approved).toContain('Approved. This source may now be compiled.');
    expect(approved).toContain('>approved<');

    // ACLs change after approval → stale on the home page and the review page
    db.acls.set(src.id, [...(db.acls.get(src.id) ?? []), { acl: { kind: 'users', emails: ['x@northwind.example'] }, items: 1, samples: ['new private channel'] }]);
    expect(await (await get('/')).text()).toContain('>stale<');
  });

  it('never exposes another org’s source', async () => {
    db.sources.set('foreign', { id: 'foreign', org_id: 'org-2', kind: 'slack', oauth_ref: null, scope_config: { include: [], exclude: [] }, status: 'connected', created_at: '' });
    expect((await get('/sources/foreign/scope')).status).toBe(404);
    expect((await get('/sources/foreign/permissions')).status).toBe(404);
  });
});
