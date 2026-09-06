// Stage 1: filter (implementation-plan §7.2). Signal vs. noise per sync item.
//
// Rules decide the obvious cases with no model call: documents, code, macros
// and channel descriptions are kept; changelog filler and one-word
// acknowledgements are dropped. Everything else goes to the model in batches
// through the gateway's `filter` route with packages/prompts/filter.md.
// Every failure mode fails OPEN (keep): a dropped fact is lost forever, kept
// noise only costs compute.
import { BudgetExceededError, complete as gatewayComplete, type CompleteFn } from '@tacit/gateway';
import { loadPrompt } from '@tacit/prompts';
import { z } from 'zod';
import type { EvalSyncItem, StageContext, StageResult, StageRunner, StageUsage } from '../contract';

export interface FilterDecision {
  readonly keep: boolean;
  readonly reason: string;
  readonly topics: readonly string[];
  readonly by: 'rule' | 'model' | 'default';
}

export interface FilterDeps {
  readonly complete?: CompleteFn;
  readonly batchSize?: number;
  readonly excerptChars?: number;
  readonly concurrency?: number;
  readonly log?: (line: Record<string, unknown>) => void;
}

const ACK_PATTERN = /^\s*(?:\+1|thanks!?|thank you!?|thx|ty|ack|ok|okay|on it|nice|will do|looking|lol|haha|same|yes|no|:[a-z0-9_+-]+:|👍|🎉|🙏)\s*[.!]?\s*$/i;
const MIN_MESSAGE_CHARS = 12;

const keep = (reason: string): FilterDecision => ({ keep: true, reason, topics: [], by: 'rule' });
const drop = (reason: string): FilterDecision => ({ keep: false, reason, topics: [], by: 'rule' });

/** Rule-based decision, or null when the model should decide. */
export function ruleDecision(item: EvalSyncItem): FilterDecision | null {
  switch (item.source) {
    case 'gdrive':
      return keep('document');
    case 'github':
      if (/(^|\/)CHANGELOG\.md$/i.test(item.external_ref)) return drop('changelog filler');
      return keep('code is ground truth');
    case 'zendesk':
      return item.external_ref.startsWith('macro:') ? keep('support macro') : null;
    case 'slack': {
      if (item.kind === 'channel') return keep('channel description');
      const text = item.content.trim();
      if (text.length < MIN_MESSAGE_CHARS) return drop('too short');
      if (ACK_PATTERN.test(text)) return drop('acknowledgement');
      return null;
    }
    case 'github_commit':
      return null;
  }
}

const Decisions = z.object({
  decisions: z.array(
    z.object({
      id: z.string(),
      keep: z.boolean(),
      reason: z.string().max(300).default(''),
      topics: z.array(z.string().max(80)).max(8).default([]),
    }),
  ),
});

function extractJson(text: string): unknown {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end < start) throw new Error('no JSON object in model output');
  return JSON.parse(text.slice(start, end + 1)) as unknown;
}

function excerpt(item: EvalSyncItem, chars: number): string {
  const text = item.content.replace(/\r\n/g, '\n').trim();
  return text.length <= chars ? text : `${text.slice(0, chars)}…`;
}

async function pool<T>(inputs: readonly T[], concurrency: number, fn: (input: T) => Promise<void>): Promise<void> {
  let next = 0;
  const workers = Array.from({ length: Math.min(concurrency, inputs.length) }, async () => {
    while (next < inputs.length) {
      const i = next++;
      const input = inputs[i];
      if (input !== undefined) await fn(input);
    }
  });
  await Promise.all(workers);
}

export function createFilterStage(deps: FilterDeps = {}): StageRunner {
  const complete = deps.complete ?? gatewayComplete;
  const log = deps.log ?? (() => undefined);

  return async (ctx: StageContext): Promise<StageResult> => {
    const prompt = loadPrompt('filter');
    const batchSize = deps.batchSize ?? Number(prompt.params.batch_size ?? 40);
    const excerptChars = deps.excerptChars ?? Number(prompt.params.excerpt_chars ?? 1200);
    const decisions = new Map<string, FilterDecision>();
    const notes: string[] = [];
    const usage = { cost_usd: 0, model_calls: 0, in_tokens: 0, out_tokens: 0 };

    const undecided: EvalSyncItem[] = [];
    for (const item of ctx.items) {
      const rule = ruleDecision(item);
      if (rule) decisions.set(item.id, rule);
      else undecided.push(item);
    }

    const batches: EvalSyncItem[][] = [];
    for (let i = 0; i < undecided.length; i += batchSize) batches.push(undecided.slice(i, i + batchSize));

    let budgetHit = false;
    let parseFailures = 0;
    await pool(batches, deps.concurrency ?? 4, async (batch) => {
      if (budgetHit) return;
      const payload = batch.map((item) => ({ id: item.id, source: item.source, kind: item.kind ?? null, title: item.title, text: excerpt(item, excerptChars) }));
      try {
        const completion = await complete(
          'filter',
          [
            { role: 'system', content: prompt.text },
            { role: 'user', content: `Items:\n${JSON.stringify(payload, null, 0)}` },
          ],
          { json: true, maxTokens: 4096, runId: ctx.run_id, orgId: ctx.org_id, budgetUsd: ctx.budget_usd },
        );
        usage.cost_usd += completion.cost_usd;
        usage.model_calls += 1;
        usage.in_tokens += completion.usage.in_tokens + completion.usage.cache_read_tokens + completion.usage.cache_write_tokens;
        usage.out_tokens += completion.usage.out_tokens;
        let parsed: z.infer<typeof Decisions>;
        try {
          parsed = Decisions.parse(extractJson(completion.text));
        } catch {
          parseFailures += 1;
          return; // fail open below
        }
        const byId = new Map(parsed.decisions.map((d) => [d.id, d] as const));
        for (const item of batch) {
          const d = byId.get(item.id);
          if (d) decisions.set(item.id, { keep: d.keep, reason: d.reason, topics: d.topics, by: 'model' });
        }
      } catch (err) {
        if (err instanceof BudgetExceededError) {
          budgetHit = true;
          return;
        }
        throw err;
      }
    });

    let defaulted = 0;
    const kept: EvalSyncItem[] = [];
    for (const item of ctx.items) {
      let d = decisions.get(item.id);
      if (!d) {
        d = { keep: true, reason: 'no decision; kept by default', topics: [], by: 'default' };
        defaulted += 1;
      }
      if (d.keep) kept.push({ ...item, meta: { ...(item.meta ?? {}), filter: d } });
    }

    if (budgetHit) notes.push('filter: budget reached; remaining undecided items kept by default');
    if (parseFailures > 0) notes.push(`filter: ${parseFailures} batch(es) had unparseable output; their items were kept by default`);
    if (defaulted > 0) notes.push(`filter: ${defaulted} item(s) kept by default without a decision`);
    const dropped = ctx.items.length - kept.length;
    log({ event: 'stage', stage: 'filter', run_id: ctx.run_id, org_id: ctx.org_id, items: ctx.items.length, kept: kept.length, dropped, batches: batches.length, ...usage });

    const finalUsage: StageUsage = usage;
    return { artifacts: [], findings: [], usage: finalUsage, items: kept, ...(notes.length ? { notes } : {}) };
  };
}
