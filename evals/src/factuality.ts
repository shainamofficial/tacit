// Artifact factuality, rubric-judged through the gateway at low effort
// (SPEC §5: ≥95% of sampled claims supported by their cited provenance).
// Model output is untrusted input: parsed with zod, never cast.
import type { EvalArtifact, EvalClaim, SourceRef } from '@tacit/pipeline';
import { GatewayUnavailableError, type CompleteFn } from '@tacit/gateway';
import { z } from 'zod';
import { Rng } from '../corpus/generator/rng';
import type { LoadedCorpus } from './corpus';
import { refKey } from './match';

export interface FactualityResult {
  /** supported / judged, or null when nothing could be judged */
  readonly value: number | null;
  readonly judged: number;
  readonly supported: number;
  readonly unsupported: ReadonlyArray<{ artifact_id: string; claim: string; reason: string }>;
  readonly cost_usd: number;
  readonly note?: string;
}

const Verdict = z.object({
  supported: z.boolean(),
  reason: z.string().max(500),
});

const RUBRIC = `You grade whether a CLAIM is supported by its cited SOURCE text.
Rules:
- "supported" only if the source states the claim or directly entails it.
- Numbers, names, dates, and units must match exactly. Paraphrase is fine; changed facts are not.
- Partial support, extrapolation, or support from anything outside the SOURCE counts as unsupported.
Respond with JSON only: {"supported": true|false, "reason": "<one sentence>"}`;

function sourceWindow(corpus: LoadedCorpus, ref: SourceRef): string | null {
  const item = corpus.byRef.get(refKey(ref));
  if (!item) return null;
  if (ref.line === undefined) return item.content.slice(0, 6000);
  const lines = item.content.split('\n');
  const start = Math.max(0, ref.line - 1 - 40);
  return lines.slice(start, ref.line - 1 + 40).join('\n');
}

function extractJson(text: string): unknown {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end < start) throw new Error('judge returned no JSON object');
  return JSON.parse(text.slice(start, end + 1)) as unknown;
}

export interface FactualityOptions {
  readonly sample: number;
  readonly seed: number;
  readonly complete: CompleteFn;
}

export async function judgeFactuality(
  artifacts: readonly EvalArtifact[],
  corpus: LoadedCorpus,
  opts: FactualityOptions,
): Promise<FactualityResult> {
  const pool: Array<{ artifact: EvalArtifact; claim: EvalClaim }> = artifacts.flatMap((artifact) =>
    artifact.claims.filter((c) => c.provenance.length > 0).map((claim) => ({ artifact, claim })),
  );
  if (pool.length === 0) {
    return { value: null, judged: 0, supported: 0, unsupported: [], cost_usd: 0, note: 'no artifacts with cited claims to judge' };
  }
  const rng = new Rng(opts.seed).fork('factuality');
  const sample = rng.shuffle(pool).slice(0, opts.sample);

  let judged = 0;
  let supported = 0;
  let cost = 0;
  const unsupported: Array<{ artifact_id: string; claim: string; reason: string }> = [];
  for (const { artifact, claim } of sample) {
    const sources = claim.provenance
      .map((ref) => {
        const text = sourceWindow(corpus, ref);
        return text === null ? null : `SOURCE (${ref.kind} ${ref.ref}${ref.line ? `:${ref.line}` : ''}):\n${text}`;
      })
      .filter((s): s is string => s !== null);
    if (sources.length === 0) {
      unsupported.push({ artifact_id: artifact.id, claim: claim.text, reason: 'provenance refs do not resolve to any corpus item' });
      judged += 1;
      continue;
    }
    try {
      const completion = await opts.complete(
        'eval_judge',
        [
          { role: 'system', content: RUBRIC },
          { role: 'user', content: `CLAIM: ${claim.text}\n\n${sources.join('\n\n')}` },
        ],
        { json: true, maxTokens: 200 },
      );
      cost += completion.cost_usd;
      judged += 1;
      let verdict: z.infer<typeof Verdict>;
      try {
        verdict = Verdict.parse(extractJson(completion.text));
      } catch {
        // Model output is untrusted: an unparseable verdict counts against the claim, never crashes the run.
        unsupported.push({ artifact_id: artifact.id, claim: claim.text, reason: 'judge output was not a valid verdict' });
        continue;
      }
      if (verdict.supported) supported += 1;
      else unsupported.push({ artifact_id: artifact.id, claim: claim.text, reason: verdict.reason });
    } catch (err) {
      if (err instanceof GatewayUnavailableError) {
        return { value: null, judged: 0, supported: 0, unsupported: [], cost_usd: cost, note: `gateway unavailable: ${err.message}` };
      }
      throw err;
    }
  }
  return { value: judged === 0 ? null : supported / judged, judged, supported, unsupported, cost_usd: cost };
}
