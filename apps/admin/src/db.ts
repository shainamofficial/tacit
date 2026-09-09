// The admin app's slice of the §8 schema: orgs, sources, and the ACLs the sync
// store captured (F-ING-3). Scope choices live in `sources.scope_config`
// (F-ING-4); permission-review approvals live in `orgs.settings` (F-ADM-1).
import type { Queryable } from '@tacit/artifacts';
import type { Acl } from '@tacit/connector-core';
import { z } from 'zod';
import type { SourceKind } from './oauth';

export const ScopeConfig = z.object({ include: z.array(z.string()).default([]), exclude: z.array(z.string()).default([]) });
export type ScopeConfig = z.infer<typeof ScopeConfig>;

export type SourceStatus = 'connected' | 'syncing' | 'error' | 'disconnected';

export interface SourceRow {
  readonly id: string;
  readonly org_id: string;
  readonly kind: SourceKind;
  readonly oauth_ref: string | null;
  readonly scope_config: ScopeConfig;
  readonly status: SourceStatus;
  readonly created_at: string;
}
export interface OrgRow {
  readonly id: string;
  readonly name: string;
  readonly settings: Readonly<Record<string, unknown>>;
}
/** One distinct ACL captured on a source's items, with how many items carry it. */
export interface AclGroup {
  readonly acl: Acl;
  readonly items: number;
  readonly samples: readonly string[];
}

export interface AdminDb {
  org(orgId: string): Promise<OrgRow | null>;
  listSources(orgId: string): Promise<SourceRow[]>;
  source(id: string): Promise<SourceRow | null>;
  createSource(orgId: string, kind: SourceKind, oauthRef: string): Promise<string>;
  setScope(id: string, scope: ScopeConfig): Promise<void>;
  setStatus(id: string, status: SourceStatus): Promise<void>;
  aclGroups(sourceId: string): Promise<AclGroup[]>;
  /** Shallow-merge into orgs.settings. */
  patchOrgSettings(orgId: string, patch: Readonly<Record<string, unknown>>): Promise<void>;
}

export class MemoryAdminDb implements AdminDb {
  readonly orgs = new Map<string, { id: string; name: string; settings: Record<string, unknown> }>();
  readonly sources = new Map<string, { id: string; org_id: string; kind: SourceKind; oauth_ref: string | null; scope_config: ScopeConfig; status: SourceStatus; created_at: string }>();
  readonly acls = new Map<string, AclGroup[]>();
  private n = 0;

  constructor(org: { id: string; name: string }) {
    this.orgs.set(org.id, { ...org, settings: {} });
  }
  async org(orgId: string): Promise<OrgRow | null> {
    return this.orgs.get(orgId) ?? null;
  }
  async listSources(orgId: string): Promise<SourceRow[]> {
    return [...this.sources.values()].filter((s) => s.org_id === orgId);
  }
  async source(id: string): Promise<SourceRow | null> {
    return this.sources.get(id) ?? null;
  }
  async createSource(orgId: string, kind: SourceKind, oauthRef: string): Promise<string> {
    const id = `src-${++this.n}`;
    this.sources.set(id, { id, org_id: orgId, kind, oauth_ref: oauthRef, scope_config: { include: [], exclude: [] }, status: 'connected', created_at: new Date().toISOString() });
    return id;
  }
  async setScope(id: string, scope: ScopeConfig): Promise<void> {
    const s = this.sources.get(id);
    if (s) s.scope_config = scope;
  }
  async setStatus(id: string, status: SourceStatus): Promise<void> {
    const s = this.sources.get(id);
    if (s) s.status = status;
  }
  async aclGroups(sourceId: string): Promise<AclGroup[]> {
    return this.acls.get(sourceId) ?? [];
  }
  async patchOrgSettings(orgId: string, patch: Readonly<Record<string, unknown>>): Promise<void> {
    const o = this.orgs.get(orgId);
    if (o) o.settings = { ...o.settings, ...patch };
  }
}

export class PgAdminDb implements AdminDb {
  constructor(private readonly db: Queryable) {}
  async org(orgId: string): Promise<OrgRow | null> {
    const r = await this.db.query<{ id: string; name: string; settings: Record<string, unknown> }>('select id, name, settings from orgs where id = $1', [orgId]);
    return r.rows[0] ?? null;
  }
  async listSources(orgId: string): Promise<SourceRow[]> {
    const r = await this.db.query<SourceRow & { created_at: Date; scope_config: unknown }>('select id, org_id, kind, oauth_ref, scope_config, status, created_at from sources where org_id = $1 order by created_at', [orgId]);
    return r.rows.map((row) => ({ ...row, scope_config: ScopeConfig.parse(row.scope_config ?? {}), created_at: row.created_at.toISOString() }));
  }
  async source(id: string): Promise<SourceRow | null> {
    const r = await this.db.query<SourceRow & { created_at: Date; scope_config: unknown }>('select id, org_id, kind, oauth_ref, scope_config, status, created_at from sources where id = $1', [id]);
    const row = r.rows[0];
    return row ? { ...row, scope_config: ScopeConfig.parse(row.scope_config ?? {}), created_at: row.created_at.toISOString() } : null;
  }
  async createSource(orgId: string, kind: SourceKind, oauthRef: string): Promise<string> {
    const r = await this.db.query<{ id: string }>("insert into sources (org_id, kind, oauth_ref, status) values ($1, $2, $3, 'connected') returning id", [orgId, kind, oauthRef]);
    const id = r.rows[0]?.id;
    if (!id) throw new Error('source insert returned no id');
    return id;
  }
  async setScope(id: string, scope: ScopeConfig): Promise<void> {
    await this.db.query('update sources set scope_config = $2::jsonb where id = $1', [id, JSON.stringify(scope)]);
  }
  async setStatus(id: string, status: SourceStatus): Promise<void> {
    await this.db.query('update sources set status = $2 where id = $1', [id, status]);
  }
  async aclGroups(sourceId: string): Promise<AclGroup[]> {
    const r = await this.db.query<{ acl: Acl; items: string; samples: string[] }>(
      `select acl, count(*)::text as items, (array_agg(title order by title))[1:3] as samples
       from sync_items where source_id = $1 and deleted_at is null group by acl order by count(*) desc`,
      [sourceId],
    );
    return r.rows.map((row) => ({ acl: row.acl, items: Number(row.items), samples: row.samples }));
  }
  async patchOrgSettings(orgId: string, patch: Readonly<Record<string, unknown>>): Promise<void> {
    await this.db.query('update orgs set settings = settings || $2::jsonb where id = $1', [orgId, JSON.stringify(patch)]);
  }
}
