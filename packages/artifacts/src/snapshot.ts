// Where served artifacts come from, and who may see what.
//
// ArtifactSource and ScopeResolver are the seams the MCP server reads through.
// SnapshotStore is the local/dev implementation: a directory the eval writes
// (`pnpm eval --serve-out=<dir>`) with the compiled artifacts, the source items
// (for get_sources), and the scope membership captured from connector ACLs.
// The Postgres implementation is in ./pg.ts.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { ReportPerson, ServeFinding } from './report';
import { refKey, type ServeArtifact, type ServeItem, type SourceRef } from './retrieve';

export interface ArtifactSource {
  /** Live (not superseded, not expired) artifacts of an org. */
  artifacts(orgId: string): Promise<readonly ServeArtifact[]>;
  /** The source item behind a provenance ref, for get_sources. */
  item(orgId: string, ref: SourceRef): Promise<ServeItem | undefined>;
}

export interface ScopeResolver {
  /** Every scope key the user holds: domain-wide scopes plus the restricted ones they are a member of. */
  scopesFor(orgId: string, email: string): Promise<ReadonlySet<string>>;
}

export interface ServeSnapshot {
  readonly org_id: string;
  readonly org_name?: string;
  readonly artifacts: readonly ServeArtifact[];
  readonly items: readonly ServeItem[];
  /** scope key → member emails, or null when the scope is domain-wide */
  readonly scopes: Readonly<Record<string, readonly string[] | null>>;
  /** the run's gaps (contradictions, drift, implied knowledge) for the scan report */
  readonly findings?: readonly ServeFinding[];
  /** org directory, for naming knowers */
  readonly people?: readonly ReportPerson[];
}

const FILES = { artifacts: 'artifacts.json', items: 'items.json', scopes: 'scopes.json', findings: 'findings.json', people: 'people.json', meta: 'meta.json' } as const;

export function writeSnapshot(dir: string, snapshot: ServeSnapshot): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, FILES.meta), `${JSON.stringify({ org_id: snapshot.org_id, org_name: snapshot.org_name ?? null, artifacts: snapshot.artifacts.length, items: snapshot.items.length, scopes: Object.keys(snapshot.scopes).length, findings: snapshot.findings?.length ?? 0, written_at: new Date().toISOString() }, null, 2)}\n`);
  writeFileSync(path.join(dir, FILES.findings), JSON.stringify(snapshot.findings ?? []));
  writeFileSync(path.join(dir, FILES.people), JSON.stringify(snapshot.people ?? []));
  writeFileSync(path.join(dir, FILES.artifacts), JSON.stringify(snapshot.artifacts));
  writeFileSync(path.join(dir, FILES.items), JSON.stringify(snapshot.items));
  writeFileSync(path.join(dir, FILES.scopes), JSON.stringify(snapshot.scopes));
}

export class SnapshotStore implements ArtifactSource, ScopeResolver {
  private readonly byRef: ReadonlyMap<string, ServeItem>;

  constructor(readonly snapshot: ServeSnapshot) {
    this.byRef = new Map(snapshot.items.map((i) => [refKey({ kind: i.source, ref: i.external_ref }), i] as const));
  }

  static load(dir: string): SnapshotStore {
    const read = <T>(name: string): T => JSON.parse(readFileSync(path.join(dir, name), 'utf8')) as T;
    const meta = read<{ org_id: string; org_name?: string | null }>(FILES.meta);
    const optional = <T>(name: string): T | undefined => (existsSync(path.join(dir, name)) ? read<T>(name) : undefined);
    const findings = optional<ServeFinding[]>(FILES.findings);
    const people = optional<ReportPerson[]>(FILES.people);
    return new SnapshotStore({ org_id: meta.org_id, ...(meta.org_name ? { org_name: meta.org_name } : {}), artifacts: read(FILES.artifacts), items: read(FILES.items), scopes: read(FILES.scopes), ...(findings ? { findings } : {}), ...(people ? { people } : {}) });
  }

  async artifacts(orgId: string): Promise<readonly ServeArtifact[]> {
    return orgId === this.snapshot.org_id ? this.snapshot.artifacts : [];
  }

  async item(orgId: string, ref: SourceRef): Promise<ServeItem | undefined> {
    return orgId === this.snapshot.org_id ? this.byRef.get(refKey(ref)) : undefined;
  }

  async scopesFor(orgId: string, email: string): Promise<ReadonlySet<string>> {
    if (orgId !== this.snapshot.org_id) return new Set();
    const e = email.toLowerCase();
    return new Set(Object.entries(this.snapshot.scopes).filter(([, members]) => members === null || members.some((m) => m.toLowerCase() === e)).map(([scope]) => scope));
  }
}
