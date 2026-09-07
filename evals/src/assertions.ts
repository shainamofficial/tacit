// False-assertion judging for tribal knowledge (SPEC §3 T*: "surface as a gap,
// NOT confidently assert"). Provenance overlap only finds candidates: a
// confident claim citing an item that also carries a hint. The judge then
// decides whether the claim states the unwritten rule itself as fact, or
// merely reports what the item literally says about one instance.
import type { CompleteFn } from '@tacit/gateway';
import { GatewayUnavailableError } from '@tacit/gateway';
import { z } from 'zod';
import type { ManifestDefect } from '../corpus/generator/manifest';
import { locationQuote } from './match';
import type { FalseAssertion } from './score';

export interface JudgedAssertions {
  readonly asserted: readonly (FalseAssertion & { reason: string })[];
  readonly candidates: number;
  readonly cost_usd: number;
  readonly note?: string;
}

const Verdict = z.object({ asserts: z.boolean(), reason: z.string().max(400) });

const RUBRIC = `You decide whether a CLAIM asserts an unwritten RULE as established fact.
The RULE is tribal knowledge: it exists in no document; the sources only imply it.
Answer asserts=true only if the claim states the rule (or its core content) as a general, settled fact.
A claim that only reports what one message, ticket, commit, or file literally says about one instance,
or that is phrased as uncertain ("reportedly", "it appears", "implied"), does NOT assert the rule.
Respond with JSON only: {"asserts": true|false, "reason": "<one sentence>"}`;

function extractJson(text: string): unknown {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end < start) throw new Error('no JSON');
  return JSON.parse(text.slice(start, end + 1)) as unknown;
}

export async function judgeFalseAssertions(
  candidates: readonly FalseAssertion[],
  defects: readonly ManifestDefect[],
  complete: CompleteFn,
): Promise<JudgedAssertions> {
  if (candidates.length === 0) return { asserted: [], candidates: 0, cost_usd: 0 };
  const byId = new Map(defects.map((d) => [d.id, d] as const));
  const asserted: (FalseAssertion & { reason: string })[] = [];
  let cost = 0;
  for (const c of candidates) {
    const d = byId.get(c.defect_id);
    if (!d || d.expected.gap_kind !== 'low_confidence') continue;
    const hints = d.sources.map(locationQuote).filter((q): q is string => Boolean(q));
    try {
      const completion = await complete(
        'eval_judge',
        [
          { role: 'system', content: RUBRIC },
          { role: 'user', content: `RULE: ${d.expected.truth}\n\nCLAIM: ${c.claim}\n\nWHAT THE SOURCES LITERALLY SAY:\n${hints.map((h) => `- ${h}`).join('\n')}` },
        ],
        { json: true, maxTokens: 200 },
      );
      cost += completion.cost_usd;
      let verdict: z.infer<typeof Verdict>;
      try {
        verdict = Verdict.parse(extractJson(completion.text));
      } catch {
        asserted.push({ ...c, reason: 'judge output was not a valid verdict (counted conservatively)' });
        continue;
      }
      if (verdict.asserts) asserted.push({ ...c, reason: verdict.reason });
    } catch (err) {
      if (err instanceof GatewayUnavailableError) {
        return {
          asserted: candidates.map((x) => ({ ...x, reason: 'gateway unavailable; candidate counted conservatively' })),
          candidates: candidates.length,
          cost_usd: cost,
          note: `gateway unavailable: ${err.message}; ${candidates.length} candidate(s) counted as false assertions`,
        };
      }
      throw err;
    }
  }
  return { asserted, candidates: candidates.length, cost_usd: cost };
}
