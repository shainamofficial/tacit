// End-to-end harness tests on the real corpus: an empty pipeline must fail
// with zero leaks; a pipeline that reproduces the answer key must pass every
// recall metric; a leaky pipeline must be a hard fail regardless of recall.
import { GatewayUnavailableError, type CompleteFn } from '@tacit/gateway';
import type { EvalArtifact, EvalPipeline, ExtractedClaim, Finding, SourceRef } from '@tacit/pipeline';
import { describe, expect, it } from 'vitest';
import type { Location, ManifestDefect } from '../corpus/generator/manifest';
import { Q } from '../corpus/generator/plants';
import { NOISE } from '../corpus/generator/slack';
import { loadCorpus } from './corpus';
import { oracleClaims } from './extract.test';
import { locationKeys } from './match';
import { runEval } from './runner';

function refsFor(loc: Location): SourceRef[] {
  switch (loc.kind) {
    case 'gdrive':
      return [{ kind: 'gdrive', ref: loc.path, line: loc.line }];
    case 'slack':
      return [{ kind: 'slack', ref: `${loc.conversation}:${loc.ts}` }];
    case 'zendesk':
      return [{ kind: 'zendesk', ref: `${loc.object}:${loc.id}` }];
    case 'github':
      return [{ kind: 'github', ref: loc.path, line: loc.line }];
    case 'github_commit':
      return [{ kind: 'github_commit', ref: loc.sha }];
    case 'github_commit_series':
      return loc.commits.map((c) => ({ kind: 'github_commit', ref: c.sha }));
  }
}

/** A pipeline that answers straight from the manifest: the ceiling any real pipeline is graded against. */
function oraclePipeline(defects: readonly ManifestDefect[], distractors: readonly ManifestDefect[]): EvalPipeline {
  const findings: Finding[] = [];
  for (const d of defects) {
    const refs = d.sources.flatMap(refsFor);
    if (d.kind === 'contradiction') findings.push({ kind: 'contradiction', refs, summary: d.topic });
    if (d.kind === 'drift') findings.push({ kind: 'drift', refs, summary: d.topic });
    if (d.kind === 'tribal' && d.expected.gap_kind === 'low_confidence') {
      findings.push({ kind: 'low_confidence', refs, summary: d.topic, suggested_knowers: d.expected.knowers });
    }
  }
  // Perfect draft: one artifact per defect/distractor from the extracted claims of its sources,
  // scoped to every cited source's scope key; tribal claims stay low-confidence.
  const draft = (claims: readonly ExtractedClaim[]): EvalArtifact[] => {
    const corpus = loadCorpus();
    // Anything citing an item that also carries a tribal hint stays low-confidence (must_not_assert).
    const tribalItems = new Set(
      defects.filter((d) => d.kind === 'tribal').flatMap((d) => d.sources.flatMap((loc) => locationKeys(loc)).map((k) => corpus.byRef.get(k)?.id)),
    );
    return [...defects, ...distractors].flatMap((d, i) => {
      const itemIds = new Set(d.sources.flatMap((loc) => locationKeys(loc)).map((k) => corpus.byRef.get(k)?.id).filter((id): id is string => id !== undefined));
      const cs = claims.filter((c) => itemIds.has(c.item_id));
      if (cs.length === 0) return [];
      const artifact: EvalArtifact = {
        id: `art_${i}`,
        type: 'qa_fact',
        title: d.topic,
        body_md: d.topic,
        claims: cs.map((c) => ({ text: c.text, provenance: c.provenance, confidence: d.kind === 'tribal' || tribalItems.has(c.item_id) ? 0.4 : 0.9 })),
        permission_scope: { require_all: [...new Set(cs.map((c) => c.scope_key))].sort() },
        verification_state: 'machine_consistent',
      };
      return [artifact];
    });
  };
  return {
    stages: {
      // A perfect filter: drops exactly the corpus's known chatter.
      filter: async (ctx) => ({ artifacts: [], findings: [], usage: { cost_usd: 0.4, model_calls: 3, in_tokens: 300, out_tokens: 30 }, items: ctx.items.filter((i) => !NOISE.includes(i.content)) }),
      extract: async () => ({ artifacts: [], findings: [], usage: { cost_usd: 0.6, model_calls: 5, in_tokens: 500, out_tokens: 50 }, claims: oracleClaims(loadCorpus()) }),
      contradict: async () => ({ artifacts: [], findings: findings.filter((f) => f.kind !== 'drift'), usage: { cost_usd: 1.25, model_calls: 10, in_tokens: 1000, out_tokens: 100 } }),
      draft: async (ctx) => ({ artifacts: draft(ctx.claims), findings: [], usage: { cost_usd: 0.3, model_calls: 2, in_tokens: 200, out_tokens: 50 } }),
      drift: async () => ({ artifacts: [], findings: findings.filter((f) => f.kind === 'drift'), usage: { cost_usd: 0.5, model_calls: 4, in_tokens: 400, out_tokens: 50 } }),
    },
    serve: async () => ({ answer: 'I do not have information on that.', refs: [], artifact_ids: [] }),
  };
}

const alwaysSupported: CompleteFn = async () => ({
  text: '{"supported": true, "reason": "stated verbatim"}',
  provider: 'fake',
  model: 'fake',
  usage: { in_tokens: 10, out_tokens: 5, cache_read_tokens: 0, cache_write_tokens: 0 },
  cost_usd: 0.001,
  latency_ms: 1,
  stop_reason: 'end_turn',
});

describe('eval runner', () => {
  it('fails with zero leaks when no stages are implemented (the intended red CI state)', async () => {
    const sc = await runEval({ runId: 'test-run', pipeline: { stages: {} } });
    expect(sc.pass).toBe(false);
    expect(sc.leaks).toHaveLength(0);
    expect(sc.cost_usd).toBe(0);
    expect(sc.stages.every((s) => !s.implemented)).toBe(true);
    expect(sc.metrics.find((m) => m.key === 'contradiction_recall')?.value).toBe(0);
    expect(sc.metrics.find((m) => m.key === 'factuality')?.value).toBeNull();
    expect(sc.notes.join(' ')).toContain('no artifacts with cited claims');
    expect(sc.failures.length).toBeGreaterThanOrEqual(4);
  }, 60_000);

  it('reports factuality as unavailable (and fails) when the gateway has no credentials', async () => {
    const corpus = loadCorpus();
    // Injected rather than relying on the environment: a developer with a key set must not make real calls here.
    const noCredentials: CompleteFn = async () => {
      throw new GatewayUnavailableError('gateway unavailable: no Anthropic credentials');
    };
    const sc = await runEval({ runId: 'test-run', pipeline: oraclePipeline(corpus.manifest.defects, corpus.manifest.distractors), complete: noCredentials });
    const factuality = sc.metrics.find((m) => m.key === 'factuality');
    expect(factuality?.value).toBeNull();
    expect(factuality?.note).toContain('gateway unavailable');
    expect(sc.pass).toBe(false);
    expect(sc.failures).toHaveLength(1);
    expect(sc.leaks).toHaveLength(0);
  }, 60_000);

  it('passes for an oracle pipeline with a supportive judge', async () => {
    const corpus = loadCorpus();
    const sc = await runEval({ runId: 'test-run', pipeline: oraclePipeline(corpus.manifest.defects, corpus.manifest.distractors), complete: alwaysSupported });
    const byKey = new Map(sc.metrics.map((m) => [m.key, m]));
    expect(byKey.get('filter_signal_recall')?.value).toBe(1);
    expect(byKey.get('filter_noise_rejection')?.value).toBe(1);
    expect(byKey.get('extract_source_coverage')?.value).toBe(1);
    expect(byKey.get('draft_source_coverage')?.value).toBe(1);
    expect(sc.stages.find((s) => s.name === 'draft')?.artifacts).toBeGreaterThan(50);
    expect(sc.stages.find((s) => s.name === 'extract')?.claims).toBeGreaterThan(100);
    expect(sc.stages.find((s) => s.name === 'filter')?.kept).toBeLessThan(sc.corpus.items);
    expect(byKey.get('contradiction_recall')?.value).toBe(1);
    expect(byKey.get('contradiction_precision')?.value).toBe(1);
    expect(byKey.get('drift_recall')?.value).toBe(1);
    expect(byKey.get('tribal_surfaced_with_knower')?.value).toBe(1);
    expect(byKey.get('false_assertions')?.value).toBe(0);
    expect(byKey.get('permission_leaks')?.value).toBe(0);
    expect(byKey.get('factuality')?.value).toBe(1);
    expect(sc.detail.serve_probes).toBe(5);
    expect(sc.cost_usd).toBeGreaterThan(1.75);
    expect(sc.pass, sc.failures.join('; ')).toBe(true);
  }, 60_000);

  it('a stage that throws is reported, fails the run, and skips later stages', async () => {
    const corpus = loadCorpus();
    const oracle = oraclePipeline(corpus.manifest.defects, corpus.manifest.distractors);
    const broken: EvalPipeline = {
      stages: {
        ...oracle.stages,
        extract: async () => {
          throw new Error('extract exploded');
        },
      },
    };
    const sc = await runEval({ runId: 'test-run', pipeline: broken, complete: alwaysSupported });
    expect(sc.pass).toBe(false);
    expect(sc.stages.find((s) => s.name === 'extract')?.error).toBe('extract exploded');
    expect(sc.stages.find((s) => s.name === 'contradict')?.ran).toBe(false);
    expect(sc.failures.join(' ')).toContain('stage extract failed');
    expect(sc.metrics.find((m) => m.key === 'filter_signal_recall')?.value).toBe(1);
  }, 60_000);

  it('--stage=contradict scores only contradiction/tribal metrics', async () => {
    const corpus = loadCorpus();
    const sc = await runEval({ runId: 'test-run', stage: 'contradict', pipeline: oraclePipeline(corpus.manifest.defects, corpus.manifest.distractors), complete: alwaysSupported });
    expect(sc.stages.find((s) => s.name === 'drift')?.ran).toBe(false);
    expect(sc.metrics.find((m) => m.key === 'drift_recall')?.scored).toBe(false);
    expect(sc.metrics.find((m) => m.key === 'factuality')?.scored).toBe(false);
    expect(sc.metrics.find((m) => m.key === 'contradiction_recall')?.scored).toBe(true);
    expect(sc.pass).toBe(true);
  }, 60_000);

  it('a permission leak is a hard fail even when every other metric passes', async () => {
    const corpus = loadCorpus();
    const oracle = oraclePipeline(corpus.manifest.defects, corpus.manifest.distractors);
    const p01 = corpus.manifest.defects.find((d) => d.id === 'P01');
    const restrictedDoc = p01?.sources.find((s) => s.kind === 'gdrive');
    if (!restrictedDoc || restrictedDoc.kind !== 'gdrive') throw new Error('P01 doc missing');

    const leakyArtifact: EvalArtifact = {
      id: 'leak',
      type: 'entity_card',
      title: 'Compensation',
      body_md: Q.P01_DOC,
      claims: [{ text: Q.P01_DOC, provenance: [{ kind: 'gdrive', ref: restrictedDoc.path, line: restrictedDoc.line }], confidence: 0.9 }],
      permission_scope: { require_all: ['github:repo:northwind'] }, // wrong: must require the exec doc
      verification_state: 'unverified',
    };
    // Correctly scoped, but the serve path hands it to a user outside the scope.
    const scopedArtifact: EvalArtifact = {
      ...leakyArtifact,
      id: 'scoped',
      permission_scope: { require_all: [`gdrive:doc:${restrictedDoc.doc_id}`] },
    };
    const leaky: EvalPipeline = {
      stages: {
        ...oracle.stages,
        judge: async () => ({ artifacts: [leakyArtifact, scopedArtifact], findings: [], usage: { cost_usd: 0, model_calls: 0, in_tokens: 0, out_tokens: 0 } }),
      },
      serve: async (req) =>
        req.query.includes('compensation')
          ? { answer: Q.P01_DOC, refs: [{ kind: 'gdrive', ref: restrictedDoc.path }], artifact_ids: ['leak', 'scoped'] }
          : { answer: '', refs: [], artifact_ids: [] },
    };
    const sc = await runEval({ runId: 'test-run', pipeline: leaky, complete: alwaysSupported });
    expect(sc.pass).toBe(false);
    const kinds = new Set(sc.leaks.map((l) => l.kind));
    expect(kinds.has('artifact_scope')).toBe(true);
    expect(kinds.has('artifact_content')).toBe(true);
    expect(kinds.has('serve_ref')).toBe(true);
    expect(kinds.has('serve_content')).toBe(true);
    expect(kinds.has('serve_artifact')).toBe(true);
  }, 60_000);

  it('a properly scoped artifact from a restricted source is not a leak, and a privileged reader may see it', async () => {
    const corpus = loadCorpus();
    const p01 = corpus.manifest.defects.find((d) => d.id === 'P01');
    const doc = p01?.sources.find((s) => s.kind === 'gdrive');
    if (!doc || doc.kind !== 'gdrive') throw new Error('P01 doc missing');
    const scoped: EvalArtifact = {
      id: 'scoped',
      type: 'entity_card',
      title: 'Compensation',
      body_md: Q.P01_DOC,
      claims: [{ text: Q.P01_DOC, provenance: [{ kind: 'gdrive', ref: doc.path, line: doc.line }], confidence: 0.9 }],
      permission_scope: { require_all: [`gdrive:doc:${doc.doc_id}`] },
      verification_state: 'unverified',
    };
    const pipeline: EvalPipeline = {
      stages: { judge: async () => ({ artifacts: [scoped], findings: [], usage: { cost_usd: 0, model_calls: 0, in_tokens: 0, out_tokens: 0 } }) },
      serve: async (req) => (req.user.email.startsWith('alice') ? { answer: Q.P01_DOC, refs: [], artifact_ids: ['scoped'] } : { answer: 'no', refs: [], artifact_ids: [] }),
    };
    const sc = await runEval({ runId: 'test-run', pipeline, complete: alwaysSupported });
    expect(sc.leaks).toHaveLength(0);
  }, 60_000);
});
