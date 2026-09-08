// Postgres artifact store over the §8 schema: artifacts, claims, provenance.
// Reads live rows; writes a compiled set with supersede-never-delete
// (CLAUDE.md #5): a new artifact supersedes the live machine-produced one with
// the same title and permission scope. Human-verified artifacts are never
// superseded by the compiler (F-FRS-1) — the new card lands beside them for
// the change-review inbox.
import type pg from 'pg';
import type { ServeArtifact, ServeItem, SourceRef } from './retrieve';
import type { ArtifactSource } from './snapshot';

export interface Queryable {
  query<R extends pg.QueryResultRow = pg.QueryResultRow>(text: string, values?: unknown[]): Promise<pg.QueryResult<R>>;
}

const SCHEMA_VERSION = 'v0';

/** provenance.source_kind allows slack|gdrive|github|zendesk; commits ride on github with a `commit:` prefix. */
export function toRow(ref: SourceRef): { source_kind: string; external_ref: string } {
  return ref.kind === 'github_commit' ? { source_kind: 'github', external_ref: `commit:${ref.ref}` } : { source_kind: ref.kind, external_ref: ref.ref };
}
export function fromRow(source_kind: string, external_ref: string, line: number | null): SourceRef {
  const kind = source_kind === 'github' && external_ref.startsWith('commit:') ? 'github_commit' : (source_kind as SourceRef['kind']);
  const ref = kind === 'github_commit' ? external_ref.slice(7) : external_ref;
  return { kind, ref, ...(line !== null ? { line } : {}) };
}

interface ArtifactRow extends pg.QueryResultRow {
  id: string;
  type: string;
  title: string;
  body_md: string;
  verification_state: ServeArtifact['verification_state'];
  verified_by: string[];
  verified_at: Date | null;
  permission_scope: { require_all: string[] };
}
interface ClaimRow extends pg.QueryResultRow {
  id: string;
  artifact_id: string;
  text: string;
  confidence: number;
}
interface ProvenanceRow extends pg.QueryResultRow {
  claim_id: string;
  source_kind: string;
  external_ref: string;
  line: number | null;
}

export class PgArtifactStore implements ArtifactSource {
  constructor(private readonly db: Queryable) {}

  async artifacts(orgId: string): Promise<readonly ServeArtifact[]> {
    const live = 'a.org_id = $1 and a.superseded_at is null and (a.valid_to is null or a.valid_to > now())';
    const arts = await this.db.query<ArtifactRow>(
      `select a.id, a.type, a.title, a.body_md, a.verification_state, a.verified_by, a.verified_at, a.permission_scope
       from artifacts a where ${live} order by a.recorded_at, a.ctid`,
      [orgId],
    );
    // Claims are positional: an artifact body cites them as [c1], [c2]… Rows are never updated
    // (supersede, never delete), so physical order is insertion order; a proposed `ordinal`
    // column (schema PR) will make this explicit.
    const claims = await this.db.query<ClaimRow>(`select c.id, c.artifact_id, c.text, c.confidence from claims c join artifacts a on a.id = c.artifact_id where ${live} order by c.ctid`, [orgId]);
    const prov = await this.db.query<ProvenanceRow>(
      `select p.claim_id, p.source_kind, p.external_ref, lower(p.span) as line
       from provenance p join claims c on c.id = p.claim_id join artifacts a on a.id = c.artifact_id where ${live} order by p.ctid`,
      [orgId],
    );
    const provByClaim = new Map<string, SourceRef[]>();
    for (const p of prov.rows) {
      const list = provByClaim.get(p.claim_id) ?? [];
      list.push(fromRow(p.source_kind, p.external_ref, p.line));
      provByClaim.set(p.claim_id, list);
    }
    const claimsByArtifact = new Map<string, ServeArtifact['claims'][number][]>();
    for (const c of claims.rows) {
      const list = claimsByArtifact.get(c.artifact_id) ?? [];
      list.push({ text: c.text, confidence: Number(c.confidence), provenance: provByClaim.get(c.id) ?? [] });
      claimsByArtifact.set(c.artifact_id, list);
    }
    return arts.rows.map((a) => ({
      id: a.id,
      type: a.type,
      title: a.title,
      body_md: a.body_md,
      claims: claimsByArtifact.get(a.id) ?? [],
      permission_scope: { require_all: a.permission_scope.require_all },
      verification_state: a.verification_state,
      verified_by: a.verified_by,
      ...(a.verified_at ? { verified_at: a.verified_at.toISOString() } : {}),
    }));
  }

  /**
   * Source items are not served from Postgres yet: sync_items carry no scope
   * key, and the compile-from-database path (Week 6) is what will assign one.
   * Until then get_sources over a Postgres-backed server returns nothing rather
   * than a span whose permission we cannot prove.
   */
  async item(): Promise<ServeItem | undefined> {
    return undefined;
  }

  /**
   * Persist a compiled artifact set. Returns compile id → row id. Callers wrap
   * this in a transaction. Idempotent in effect: re-saving an identical set
   * supersedes the previous rows with equal ones (supersede, never delete).
   */
  async saveCompiled(orgId: string, artifacts: readonly ServeArtifact[]): Promise<Map<string, string>> {
    const ids = new Map<string, string>();
    for (const a of artifacts) {
      const scope = JSON.stringify({ require_all: [...a.permission_scope.require_all].sort() });
      const inserted = await this.db.query<{ id: string }>(
        `insert into artifacts (org_id, type, schema_version, title, body_md, verification_state, permission_scope)
         values ($1, $2, $3, $4, $5, $6, $7::jsonb) returning id`,
        [orgId, a.type, SCHEMA_VERSION, a.title, a.body_md, a.verification_state, scope],
      );
      const newId = inserted.rows[0]?.id;
      if (!newId) throw new Error('artifact insert returned no id');
      ids.set(a.id, newId);
      await this.db.query(
        `update artifacts set superseded_at = now(), superseded_by = $3
         where org_id = $1 and superseded_at is null and title = $2 and permission_scope = $4::jsonb
           and verification_state in ('unverified', 'machine_consistent') and id <> $3`,
        [orgId, a.title, newId, scope],
      );
      for (const c of a.claims) {
        const claim = await this.db.query<{ id: string }>('insert into claims (artifact_id, text, confidence) values ($1, $2, $3) returning id', [newId, c.text, c.confidence]);
        const claimId = claim.rows[0]?.id;
        if (!claimId) throw new Error('claim insert returned no id');
        for (const ref of c.provenance) {
          const row = toRow(ref);
          await this.db.query('insert into provenance (claim_id, source_kind, external_ref, span) values ($1, $2, $3, $4)', [claimId, row.source_kind, row.external_ref, ref.line !== undefined ? `[${ref.line},${ref.line + 1})` : null]);
        }
      }
    }
    return ids;
  }
}
