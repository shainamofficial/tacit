import type { ExtractedClaim } from '@tacit/pipeline';
import { describe, expect, it } from 'vitest';
import type { Location } from '../corpus/generator/manifest';
import { loadCorpus } from './corpus';
import { scoreExtract } from './extract';
import { locationKeys, locationLine } from './match';

function oracleClaims(corpus: ReturnType<typeof loadCorpus>): ExtractedClaim[] {
  const out: ExtractedClaim[] = [];
  const seen = new Set<string>();
  for (const d of [...corpus.manifest.defects, ...corpus.manifest.distractors]) {
    for (const loc of d.sources as Location[]) {
      for (const key of locationKeys(loc)) {
        const item = corpus.byRef.get(key);
        if (!item || seen.has(`${key}:${locationLine(loc) ?? ''}`)) continue;
        seen.add(`${key}:${locationLine(loc) ?? ''}`);
        const line = locationLine(loc);
        out.push({
          id: `${item.id}#${out.length}`,
          item_id: item.id,
          text: d.topic,
          kind: 'policy',
          subject: d.topic.toLowerCase(),
          provenance: [{ kind: item.source, ref: item.external_ref, ...(line !== undefined ? { line } : {}) }],
          confidence: 0.9,
          scope_key: item.scope_key,
          acl: item.acl,
          source: item.source,
          modified_at: item.modified_at,
        });
      }
    }
  }
  return out;
}

describe('extract metric', () => {
  const corpus = loadCorpus();

  it('gives full coverage to oracle claims and zero to none', () => {
    const perfect = scoreExtract(corpus, oracleClaims(corpus));
    expect(perfect.source_coverage).toBe(1);
    expect(perfect.uncovered_sample).toEqual([]);
    expect(perfect.locations).toBeGreaterThan(120);

    const none = scoreExtract(corpus, []);
    expect(none.source_coverage).toBe(0);
    expect(none.uncovered_sample.length).toBe(25);
    expect(scoreExtract(corpus, null).source_coverage).toBeNull();
  });

  it('respects the line tolerance for file locations', () => {
    const claims = oracleClaims(corpus).map((c) => ({ ...c, provenance: c.provenance.map((p) => (p.line ? { ...p, line: p.line + 50 } : p)) }));
    const s = scoreExtract(corpus, claims);
    expect(s.source_coverage).toBeLessThan(1);
    expect(s.source_coverage).toBeGreaterThan(0.3); // slack/zendesk/commit refs have no line and still match
  });
});

export { oracleClaims };
