// Extract-stage metric: every manifest source location (a planted quote) must
// be covered by at least one extracted claim whose provenance points at it.
import type { ExtractedClaim } from '@tacit/pipeline';
import type { Location } from '../corpus/generator/manifest';
import type { LoadedCorpus } from './corpus';
import { locationKeys, refMatchesLocation } from './match';

export interface ExtractScore {
  readonly source_coverage: number | null;
  readonly locations: number;
  readonly covered: number;
  readonly claims: number;
  readonly claims_with_line: number;
  readonly uncovered_sample: readonly string[];
}

function describe(defectId: string, loc: Location): string {
  return `${defectId} ${locationKeys(loc)[0] ?? loc.kind}`;
}

export function scoreExtract(corpus: LoadedCorpus, claims: readonly ExtractedClaim[] | null): ExtractScore {
  const targets: Array<{ defectId: string; loc: Location }> = [];
  for (const d of [...corpus.manifest.defects, ...corpus.manifest.distractors]) {
    for (const loc of d.sources) if (loc.kind !== 'github_commit_series') targets.push({ defectId: d.id, loc });
  }
  if (claims === null) return { source_coverage: null, locations: targets.length, covered: 0, claims: 0, claims_with_line: 0, uncovered_sample: [] };

  const refs = claims.flatMap((c) => c.provenance);
  const uncovered: string[] = [];
  let covered = 0;
  for (const t of targets) {
    if (refs.some((ref) => refMatchesLocation(ref, t.loc))) covered += 1;
    else uncovered.push(describe(t.defectId, t.loc));
  }
  return {
    source_coverage: targets.length === 0 ? null : covered / targets.length,
    locations: targets.length,
    covered,
    claims: claims.length,
    claims_with_line: claims.filter((c) => c.provenance.some((r) => r.line !== undefined)).length,
    uncovered_sample: uncovered.slice(0, 25),
  };
}
