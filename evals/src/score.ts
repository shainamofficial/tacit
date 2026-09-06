// Per-defect-class scoring against the manifest (SPEC §5).
import type { EvalArtifact, Finding } from '@tacit/pipeline';
import type { ManifestDefect } from '../corpus/generator/manifest';
import { PEOPLE, type PersonKey } from '../corpus/generator/world';
import { coveredLocations, isCodeSide, isDocSide, refMatchesLocation } from './match';

export interface DefectHit {
  readonly id: string;
  readonly matched: boolean;
  /** indexes into the findings array */
  readonly by: readonly number[];
}

export interface ContradictionScore {
  readonly recall: number;
  readonly precision: number | null;
  readonly defects: number;
  readonly matched: number;
  readonly findings: number;
  readonly true_positives: number;
  readonly false_positives: number;
  readonly hits: readonly DefectHit[];
}

export function scoreContradictions(defects: readonly ManifestDefect[], findings: readonly Finding[]): ContradictionScore {
  const cs = defects.filter((d) => d.kind === 'contradiction');
  const indexed = findings.map((f, i) => ({ f, i })).filter((x) => x.f.kind === 'contradiction');
  const hits: DefectHit[] = cs.map((d) => {
    const by = indexed.filter(({ f }) => coveredLocations(f.refs, d.sources).length >= 2).map((x) => x.i);
    return { id: d.id, matched: by.length > 0, by };
  });
  const tp = new Set(hits.flatMap((h) => h.by));
  const matched = hits.filter((h) => h.matched).length;
  return {
    recall: cs.length === 0 ? 0 : matched / cs.length,
    precision: indexed.length === 0 ? null : tp.size / indexed.length,
    defects: cs.length,
    matched,
    findings: indexed.length,
    true_positives: tp.size,
    false_positives: indexed.length - tp.size,
    hits,
  };
}

export interface DriftScore {
  readonly recall: number;
  readonly defects: number;
  readonly matched: number;
  readonly findings: number;
  readonly hits: readonly DefectHit[];
}

export function scoreDrift(defects: readonly ManifestDefect[], findings: readonly Finding[]): DriftScore {
  const ds = defects.filter((d) => d.kind === 'drift');
  const indexed = findings.map((f, i) => ({ f, i })).filter((x) => x.f.kind === 'drift');
  const hits: DefectHit[] = ds.map((d) => {
    const by = indexed
      .filter(({ f }) => {
        const covered = coveredLocations(f.refs, d.sources);
        return covered.some(isDocSide) && covered.some(isCodeSide);
      })
      .map((x) => x.i);
    return { id: d.id, matched: by.length > 0, by };
  });
  const matched = hits.filter((h) => h.matched).length;
  return { recall: ds.length === 0 ? 0 : matched / ds.length, defects: ds.length, matched, findings: indexed.length, hits };
}

export interface FalseAssertion {
  readonly defect_id: string;
  readonly artifact_id: string;
  readonly claim: string;
  readonly confidence: number;
}

export interface TribalScore {
  /** fraction surfaced as a gap with a correct suggested knower */
  readonly surfaced_with_knower: number;
  readonly defects: number;
  readonly surfaced: number;
  readonly with_knower: number;
  readonly false_assertions: readonly FalseAssertion[];
  readonly hits: readonly (DefectHit & { knower_ok: boolean })[];
}

/** A high-confidence claim whose provenance is only a tribal hint is asserting tribal knowledge as fact. */
const ASSERTION_CONFIDENCE = 0.8;

function knowerMatches(expected: readonly PersonKey[], suggested: readonly string[] | undefined): boolean {
  if (!suggested || suggested.length === 0) return false;
  const wanted = expected.map((k) => PEOPLE.find((p) => p.key === k)).filter((p) => p !== undefined);
  return suggested.some((s) => {
    const needle = s.trim().toLowerCase();
    return wanted.some((p) => needle === p.key || needle === p.email || needle === p.name.toLowerCase() || needle === p.handle || needle.includes(p.email));
  });
}

export function scoreTribal(defects: readonly ManifestDefect[], findings: readonly Finding[], artifacts: readonly EvalArtifact[]): TribalScore {
  const ts = defects.filter((d) => d.kind === 'tribal');
  const indexed = findings.map((f, i) => ({ f, i })).filter((x) => x.f.kind === 'low_confidence' || x.f.kind === 'query_miss');
  const hits = ts.map((d) => {
    const expectedKnowers = d.expected.gap_kind === 'low_confidence' ? d.expected.knowers : [];
    const matching = indexed.filter(({ f }) => coveredLocations(f.refs, d.sources).length >= 1);
    const knower_ok = matching.some(({ f }) => knowerMatches(expectedKnowers, f.suggested_knowers));
    return { id: d.id, matched: matching.length > 0, by: matching.map((x) => x.i), knower_ok };
  });
  const false_assertions: FalseAssertion[] = [];
  for (const d of ts) {
    for (const a of artifacts) {
      for (const c of a.claims) {
        if (c.confidence < ASSERTION_CONFIDENCE) continue;
        const touchesHint = c.provenance.some((ref) => d.sources.some((loc) => refMatchesLocation(ref, loc)));
        if (touchesHint) false_assertions.push({ defect_id: d.id, artifact_id: a.id, claim: c.text, confidence: c.confidence });
      }
    }
  }
  const surfaced = hits.filter((h) => h.matched).length;
  const with_knower = hits.filter((h) => h.matched && h.knower_ok).length;
  return {
    surfaced_with_knower: ts.length === 0 ? 0 : with_knower / ts.length,
    defects: ts.length,
    surfaced,
    with_knower,
    false_assertions,
    hits,
  };
}
