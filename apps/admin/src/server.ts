// The connect flow (F-ADM-1) as three server-rendered pages on node:http —
// no framework until the dashboard needs one (plan §2 names Next.js; P0 does
// not need it). Every page is behind the admin token; every mutation is a POST.
//
//   GET  /                          sources, their status, scope, and review state
//   GET  /connect/:kind             the scopes about to be requested (F-ING-1) → redirect to the provider
//   GET  /oauth/:kind/callback      signed state → token exchange → sealed credential → source row
//   GET  /sources/:id/scope         include/exclude picker (F-ING-4)      POST saves
//   GET  /sources/:id/permissions   who-can-see-what from captured ACLs    POST approves
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { Catalog } from './catalog';
import type { CredentialStore } from './credentials';
import { ScopeConfig, type AdminDb, type SourceRow } from './db';
import { signState, verifyState, type OAuthProvider, type SourceKind } from './oauth';
import { approvePatch, isApproved, mapPermissions } from './permissions';

export interface AdminDeps {
  readonly orgId: string;
  readonly db: AdminDb;
  readonly credentials: CredentialStore;
  readonly providers: Readonly<Partial<Record<SourceKind, OAuthProvider>>>;
  readonly catalog: Catalog;
  /** Admin bearer token (the champion); also the HMAC secret for OAuth state. */
  readonly adminToken: string;
  /** Public origin for OAuth redirect URIs, e.g. https://admin.example.com */
  readonly publicUrl: string;
  readonly log?: (line: Record<string, unknown>) => void;
}

const esc = (s: string): string => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c);
const KINDS: readonly SourceKind[] = ['slack', 'gdrive', 'github'];
const isKind = (s: string): s is SourceKind => (KINDS as readonly string[]).includes(s);

const CSS = `body{margin:0;background:#fff;font:15px/1.5 -apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#1a1a1a}main{max-width:860px;margin:0 auto;padding:28px 20px 60px}h1{font-size:24px;margin:0 0 4px}h2{font-size:18px;margin:28px 0 8px}
.muted{color:#5f6368}table{border-collapse:collapse;width:100%;margin:8px 0}th,td{text-align:left;padding:8px 10px;border-bottom:1px solid #e3e3e3;vertical-align:top}th{font-size:13px;color:#5f6368}
.btn{display:inline-block;padding:8px 14px;border-radius:6px;background:#0b57d0;color:#fff;text-decoration:none;border:0;font:inherit;cursor:pointer}.btn.secondary{background:#eef2f7;color:#1a1a1a}
.pill{display:inline-block;padding:2px 8px;border-radius:999px;font-size:12px;background:#eef2f7}.pill.ok{background:#e6f4ea;color:#146c2e}.pill.warn{background:#fdecea;color:#b3261e}
ul.scopes{padding-left:20px}code{background:#f6f8fa;padding:1px 4px;border-radius:3px}label{display:block;padding:4px 0}`;

function page(title: string, body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)} — Tacit admin</title><style>${CSS}</style></head><body><main><p class="muted"><a href="/">Tacit admin</a></p>${body}</main></body></html>`;
}

function send(res: ServerResponse, status: number, html: string, headers: Record<string, string> = {}): void {
  res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', ...headers });
  res.end(html);
}
function redirect(res: ServerResponse, to: string, extra: Record<string, string> = {}): void {
  res.writeHead(303, { location: to, ...extra });
  res.end();
}

function cookies(req: IncomingMessage): Record<string, string> {
  return Object.fromEntries((req.headers.cookie ?? '').split(';').map((c) => c.trim().split('=')).filter((kv) => kv[0]).map(([k, ...v]) => [k as string, decodeURIComponent(v.join('='))]));
}
function bearer(req: IncomingMessage): string | null {
  const m = /^Bearer\s+(.+)$/i.exec(req.headers.authorization ?? '');
  return m?.[1]?.trim() || null;
}
async function readForm(req: IncomingMessage): Promise<URLSearchParams> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return new URLSearchParams(Buffer.concat(chunks).toString('utf8'));
}

const statusPill = (s: SourceRow['status']): string => `<span class="pill ${s === 'connected' ? 'ok' : s === 'error' ? 'warn' : ''}">${esc(s)}</span>`;

export function createAdminHandler(deps: AdminDeps): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  const log = deps.log ?? (() => undefined);
  const redirectUri = (kind: SourceKind): string => `${deps.publicUrl.replace(/\/$/, '')}/oauth/${kind}/callback`;

  const home = async (res: ServerResponse): Promise<void> => {
    const org = await deps.db.org(deps.orgId);
    const sources = await deps.db.listSources(deps.orgId);
    const rows = await Promise.all(
      sources.map(async (s) => {
        const mapping = mapPermissions(await deps.db.aclGroups(s.id));
        const review = isApproved(org?.settings ?? {}, s.id, mapping);
        const scope = s.scope_config.include.length ? `${s.scope_config.include.length} included` : 'everything';
        return `<tr><td>${esc(deps.providers[s.kind]?.label ?? s.kind)}</td><td>${statusPill(s.status)}</td><td><a href="/sources/${esc(s.id)}/scope">${esc(scope)}</a>${s.scope_config.exclude.length ? ` <span class="muted">(${s.scope_config.exclude.length} excluded)</span>` : ''}</td><td><a href="/sources/${esc(s.id)}/permissions"><span class="pill ${review === 'approved' ? 'ok' : review === 'stale' ? 'warn' : ''}">${review}</span></a> <span class="muted">${mapping.items} items, ${mapping.restrictedItems} restricted</span></td></tr>`;
      }),
    );
    const connect = KINDS.filter((k) => deps.providers[k]).map((k) => `<a class="btn secondary" href="/connect/${k}">Connect ${esc(deps.providers[k]?.label ?? k)}</a>`).join(' ');
    send(res, 200, page('Sources', `<h1>${esc(org?.name ?? 'Organization')}</h1><p class="muted">Connect sources read-only, choose what to include, review who can see what. The first compile runs only for sources whose review is approved.</p>
<h2>Sources</h2>${rows.length ? `<table><tr><th>Source</th><th>Status</th><th>Scope</th><th>Permission review</th></tr>${rows.join('')}</table>` : '<p class="muted">No sources connected yet.</p>'}
<h2>Connect</h2><p>${connect || '<span class="muted">No providers configured (set the OAuth client ids in the environment).</span>'}</p>`));
  };

  const connectPage = (res: ServerResponse, kind: SourceKind): void => {
    const p = deps.providers[kind];
    if (!p) return send(res, 404, page('Not configured', `<h1>${esc(kind)} is not configured</h1>`));
    const state = signState(deps.adminToken, { org: deps.orgId, kind });
    send(res, 200, page(`Connect ${p.label}`, `<h1>Connect ${esc(p.label)}</h1><p>${esc(p.access)}</p><p>Tacit will ask ${esc(p.label)} for exactly these read-only permissions:</p><ul class="scopes">${p.scopes.map((s) => `<li><code>${esc(s)}</code></li>`).join('')}</ul>
<p><a class="btn" href="${esc(p.authorizeUrl(state, redirectUri(kind)))}">Continue to ${esc(p.label)}</a> <a class="btn secondary" href="/">Cancel</a></p><p class="muted">After connecting you will choose what to include, then review who can see what before anything is compiled.</p>`));
  };

  const callback = async (res: ServerResponse, kind: SourceKind, params: Record<string, string>): Promise<void> => {
    const p = deps.providers[kind];
    if (!p) return send(res, 404, page('Not configured', `<h1>${esc(kind)} is not configured</h1>`));
    const state = params.state ? verifyState(deps.adminToken, params.state) : null;
    if (!state || state.kind !== kind || state.org !== deps.orgId) {
      log({ event: 'admin_oauth_rejected', kind, reason: 'bad_state' });
      return send(res, 400, page('Rejected', '<h1>This connect attempt did not start here</h1><p>The state token is missing, expired, or for another organization. <a href="/">Start again</a>.</p>'));
    }
    try {
      const credential = await p.exchange(params, redirectUri(kind));
      const ref = await deps.credentials.put(deps.orgId, credential);
      const id = await deps.db.createSource(deps.orgId, kind, ref);
      log({ event: 'admin_source_connected', kind, source_id: id, scopes: credential.scopes.length, account: credential.account ?? null });
      redirect(res, `/sources/${id}/scope`);
    } catch (err) {
      log({ event: 'admin_oauth_failed', kind, message: err instanceof Error ? err.message : String(err) });
      send(res, 502, page('Connect failed', `<h1>${esc(p.label)} did not complete the connection</h1><p>${esc(err instanceof Error ? err.message : String(err))}</p><p><a href="/connect/${kind}">Try again</a></p>`));
    }
  };

  const scopePage = async (res: ServerResponse, source: SourceRow): Promise<void> => {
    const credential = source.oauth_ref ? await deps.credentials.get(source.oauth_ref) : null;
    const entries = credential ? await deps.catalog.list(source.kind, credential) : [];
    const inc = new Set(source.scope_config.include);
    const exc = new Set(source.scope_config.exclude);
    const noun = source.kind === 'slack' ? 'channels' : source.kind === 'gdrive' ? 'top-level folders' : 'repositories';
    const items = entries.map((e) => `<label><input type="checkbox" name="include" value="${esc(e.id)}" ${inc.size === 0 || inc.has(e.id) ? 'checked' : ''} ${exc.has(e.id) ? 'disabled' : ''}> ${esc(e.label)}${e.detail ? ` <span class="muted">${esc(e.detail)}</span>` : ''}${exc.has(e.id) ? ' <span class="pill">excluded</span>' : ''}</label>`).join('');
    send(res, 200, page('Scope', `<h1>What to include</h1><p class="muted">${esc(deps.providers[source.kind]?.label ?? source.kind)} · ${entries.length} ${noun} visible to the connection. Unticked ${noun} are excluded before the first compile (F-ING-4).</p>
<form method="post" action="/sources/${esc(source.id)}/scope">${items || `<p class="muted">${credential ? `Nothing listed — the connection can see no ${noun}.` : 'No credential on file for this source.'}</p>`}
<p><button class="btn" type="submit">Save scope</button> <a class="btn secondary" href="/sources/${esc(source.id)}/permissions">Review permissions →</a></p></form>`));
  };

  const permissionsPage = async (res: ServerResponse, source: SourceRow, notice = ''): Promise<void> => {
    const org = await deps.db.org(deps.orgId);
    const mapping = mapPermissions(await deps.db.aclGroups(source.id));
    const review = isApproved(org?.settings ?? {}, source.id, mapping);
    const rows = mapping.rows.map((r) => `<tr><td>${esc(r.label)}${r.members.length ? `<br><span class="muted">${esc(r.members.join(', '))}</span>` : ''}</td><td>${r.items}</td><td class="muted">${esc(r.samples.join(' · '))}</td></tr>`).join('');
    send(res, 200, page('Permission review', `<h1>Who can see what</h1><p class="muted">${esc(deps.providers[source.kind]?.label ?? source.kind)} · derived from the sharing settings captured on every synced item, not from assumptions. Tacit serves each fact only to people who could already read every source behind it.</p>
${notice ? `<p class="pill ok">${esc(notice)}</p>` : ''}
${mapping.rows.length ? `<table><tr><th>Readable by</th><th>Items</th><th>Examples</th></tr>${rows}</table>` : '<p class="muted">Nothing synced yet for this source — run the first sync, then review.</p>'}
<p>${mapping.items} items, ${mapping.restrictedItems} restricted to named people. Review state: <span class="pill ${review === 'approved' ? 'ok' : review === 'stale' ? 'warn' : ''}">${review}</span>${review === 'stale' ? ' <span class="muted">— the sharing settings changed since the last approval</span>' : ''}</p>
<form method="post" action="/sources/${esc(source.id)}/permissions"><input type="hidden" name="digest" value="${esc(mapping.digest)}"><button class="btn" type="submit" ${mapping.rows.length ? '' : 'disabled'}>Approve this mapping</button> <a class="btn secondary" href="/">Back</a></form>`));
  };

  return async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const params = Object.fromEntries(url.searchParams.entries());
    // ---- admin auth: bearer, or a cookie set by /login?token=
    if (url.pathname === '/healthz') return send(res, 200, 'ok', { 'content-type': 'text/plain' });
    if (url.pathname === '/login') {
      if (params.token === deps.adminToken) return redirect(res, '/', { 'set-cookie': `tacit_admin=${encodeURIComponent(deps.adminToken)}; HttpOnly; SameSite=Lax; Path=/` });
      return send(res, 401, page('Sign in', '<h1>Admin token required</h1><p>Open <code>/login?token=…</code> with the admin token from the environment.</p>'));
    }
    const token = bearer(req) ?? cookies(req).tacit_admin ?? null;
    if (token !== deps.adminToken) {
      log({ event: 'admin_auth_rejected', path: url.pathname });
      return send(res, 401, page('Sign in', '<h1>Admin token required</h1><p>Open <code>/login?token=…</code> with the admin token from the environment.</p>'));
    }

    const parts = url.pathname.split('/').filter(Boolean);
    try {
      if (parts.length === 0) return await home(res);
      if (parts[0] === 'connect' && parts[1] && isKind(parts[1]) && parts.length === 2) return connectPage(res, parts[1]);
      if (parts[0] === 'oauth' && parts[1] && isKind(parts[1]) && parts[2] === 'callback') return await callback(res, parts[1], params);
      if (parts[0] === 'sources' && parts[1] && parts[2]) {
        const source = await deps.db.source(parts[1]);
        if (!source || source.org_id !== deps.orgId) return send(res, 404, page('Not found', '<h1>No such source</h1>'));
        if (parts[2] === 'scope') {
          if (req.method === 'POST') {
            const form = await readForm(req);
            const credential = source.oauth_ref ? await deps.credentials.get(source.oauth_ref) : null;
            const all = credential ? (await deps.catalog.list(source.kind, credential)).map((e) => e.id) : [];
            const include = form.getAll('include').filter((id) => all.includes(id));
            const scope = ScopeConfig.parse({ include: include.length === all.length ? [] : include, exclude: all.filter((id) => !include.includes(id)) });
            await deps.db.setScope(source.id, scope);
            log({ event: 'admin_scope_saved', source_id: source.id, included: include.length, of: all.length });
            return redirect(res, `/sources/${source.id}/permissions`);
          }
          return await scopePage(res, source);
        }
        if (parts[2] === 'permissions') {
          if (req.method === 'POST') {
            const form = await readForm(req);
            const org = await deps.db.org(deps.orgId);
            const mapping = mapPermissions(await deps.db.aclGroups(source.id));
            if (form.get('digest') !== mapping.digest) return await permissionsPage(res, source, 'The mapping changed while you were reviewing it — please review again.');
            await deps.db.patchOrgSettings(deps.orgId, approvePatch(org?.settings ?? {}, source.id, mapping.digest, 'admin'));
            await deps.db.setStatus(source.id, 'connected');
            log({ event: 'admin_permissions_approved', source_id: source.id, digest: mapping.digest, items: mapping.items, restricted: mapping.restrictedItems });
            return await permissionsPage(res, source, 'Approved. This source may now be compiled.');
          }
          return await permissionsPage(res, source);
        }
      }
      send(res, 404, page('Not found', '<h1>Not found</h1>'));
    } catch (err) {
      log({ event: 'admin_error', path: url.pathname, message: err instanceof Error ? err.message : String(err) });
      if (!res.headersSent) send(res, 500, page('Error', '<h1>Something went wrong</h1>'));
    }
  };
}

export async function startAdminServer(deps: AdminDeps, port: number, host = '127.0.0.1'): Promise<{ server: Server; port: number; url: string }> {
  const handler = createAdminHandler(deps);
  const server = createServer((req, res) => {
    void handler(req, res);
  });
  await new Promise<void>((resolve) => server.listen(port, host, resolve));
  const address = server.address();
  const actualPort = typeof address === 'object' && address ? address.port : port;
  return { server, port: actualPort, url: `http://${host}:${actualPort}` };
}
