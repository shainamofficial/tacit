// The read path (F-SRV-1..3). Tiered: lookup is a ~100-token index over the
// artifacts a user may see; get_artifact is the full card; get_sources is raw
// spans on explicit request. Everything is permission-filtered at query time
// against the user's scope set: an artifact is visible only when the user
// holds every scope in its permission_scope.require_all (F-SEC-1). A query
// that matches only invisible artifacts is a permission miss — logged as
// such, but indistinguishable from a plain miss to the user (F-SRV-3).
import { buildSearchIndex, excerptWindows, searchIndex, type SearchIndex } from './search';

export interface SourceRef {
  readonly kind: 'gdrive' | 'slack' | 'zendesk' | 'github' | 'github_commit';
  readonly ref: string;
  readonly line?: number;
}
export interface ServeClaim {
  readonly text: string;
  readonly provenance: readonly SourceRef[];
  readonly confidence: number;
}
/** Structurally identical to the pipeline's EvalArtifact and the artifacts table row. */
export interface ServeArtifact {
  readonly id: string;
  readonly type: string;
  readonly title: string;
  readonly body_md: string;
  readonly claims: readonly ServeClaim[];
  readonly permission_scope: { readonly require_all: readonly string[] };
  readonly verification_state: 'unverified' | 'machine_consistent' | 'human_verified' | 'cross_validated';
  readonly verified_by?: readonly string[];
  readonly verified_at?: string;
  readonly meta?: Readonly<Record<string, unknown>>;
}
export interface ServeItem {
  readonly id: string;
  readonly source: SourceRef['kind'];
  readonly external_ref: string;
  readonly title: string;
  readonly content: string;
  readonly scope_key: string;
  readonly modified_at: string;
}

export function canSee(artifact: ServeArtifact, scopes: ReadonlySet<string>): boolean {
  return artifact.permission_scope.require_all.every((s) => scopes.has(s));
}

export interface LookupEntry {
  readonly id: string;
  readonly type: string;
  readonly title: string;
  readonly verification_state: ServeArtifact['verification_state'];
  readonly summary: string;
  readonly sources: number;
  readonly score: number;
}
export type LookupResult = { readonly kind: 'hit'; readonly entries: readonly LookupEntry[] } | { readonly kind: 'query_miss' } | { readonly kind: 'permission_miss' };

export interface SourceSpan {
  readonly ref: SourceRef;
  readonly title: string;
  readonly date: string;
  readonly excerpt: string;
}

const summaryOf = (a: ServeArtifact, chars: number): string => {
  const first = a.body_md.replace(/\s+/g, ' ').replace(/\s*\[[^\]]*\]/g, '').trim();
  return first.length <= chars ? first : `${first.slice(0, chars - 1).trimEnd()}…`;
};

export const refKey = (r: SourceRef): string => `${r.kind}|${r.ref}`;

export class Retriever {
  private readonly index: SearchIndex<{ id: string; text: string; artifact: ServeArtifact }>;
  private readonly byId: ReadonlyMap<string, ServeArtifact>;

  constructor(artifacts: readonly ServeArtifact[]) {
    this.index = buildSearchIndex(artifacts.map((a) => ({ id: a.id, text: `${a.title}\n${a.title}\n${a.body_md}\n${a.claims.map((c) => c.text).join('\n')}`, artifact: a })));
    this.byId = new Map(artifacts.map((a) => [a.id, a] as const));
  }

  /**
   * Index tier: the top matches the user may see, ~100 tokens each at most.
   * A match needs two query terms in the card, or a single rare *strong* term
   * (an identifier-like token: digits, or a long specific word). One shared
   * verb ("planned") or short noun ("year") is noise, not knowledge about the
   * question, and would hide a real miss from the gap log.
   */
  lookup(query: string, scopes: ReadonlySet<string>, limit = 5, summaryChars = 160): LookupResult {
    const strong = (t: string): boolean => /\d/.test(t) || t.length >= 8;
    const hits = searchIndex(this.index, query, Math.max(limit * 4, 20)).filter((h) => h.matched >= 2 || (h.rare >= 1 && h.terms.some(strong)));
    if (hits.length === 0) return { kind: 'query_miss' };
    const visible = hits.filter((h) => canSee(h.doc.artifact, scopes));
    if (visible.length === 0) return { kind: 'permission_miss' };
    return {
      kind: 'hit',
      entries: visible.slice(0, limit).map((h) => ({
        id: h.doc.artifact.id,
        type: h.doc.artifact.type,
        title: h.doc.artifact.title,
        verification_state: h.doc.artifact.verification_state,
        summary: summaryOf(h.doc.artifact, summaryChars),
        sources: new Set(h.doc.artifact.claims.flatMap((c) => c.provenance.map(refKey))).size,
        score: Number(h.score.toFixed(3)),
      })),
    };
  }

  /** Full card, or null when it does not exist or the user may not see it (identical to the user). */
  get(id: string, scopes: ReadonlySet<string>): ServeArtifact | null {
    const a = this.byId.get(id);
    return a && canSee(a, scopes) ? a : null;
  }

  /**
   * Raw source spans behind an artifact's claims, on explicit request only.
   * Each source is re-checked against the user's scopes: a card the user may
   * see never hands out a span from a source they may not.
   */
  sources(artifact: ServeArtifact, scopes: ReadonlySet<string>, lookupItem: (ref: SourceRef) => ServeItem | undefined, contextLines = 3, maxSpans = 12): SourceSpan[] {
    const out: SourceSpan[] = [];
    const seen = new Set<string>();
    for (const c of artifact.claims) {
      for (const ref of c.provenance) {
        const key = `${refKey(ref)}|${ref.line ?? ''}`;
        if (seen.has(key) || out.length >= maxSpans) continue;
        seen.add(key);
        const item = lookupItem(ref);
        if (!item || !scopes.has(item.scope_key)) continue;
        const lines = item.content.split('\n');
        let excerpt: string;
        if (ref.line !== undefined) {
          const start = Math.max(0, ref.line - 1 - contextLines);
          const end = Math.min(lines.length, ref.line + contextLines);
          excerpt = lines
            .slice(start, end)
            .map((l, i) => `${start + i + 1}: ${l}`)
            .join('\n');
        } else {
          excerpt = excerptWindows(item.content, c.text, contextLines, 1)[0]?.text ?? lines.slice(0, contextLines * 2 + 1).map((l, i) => `${i + 1}: ${l}`).join('\n');
        }
        out.push({ ref, title: item.title, date: item.modified_at.slice(0, 10), excerpt });
      }
    }
    return out;
  }
}
