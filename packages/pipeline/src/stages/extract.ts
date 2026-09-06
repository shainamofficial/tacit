// Stage 2: extract (implementation-plan §7.2). Schema-constrained extraction
// of atomic claims from each kept item, with provenance down to the line when
// the model's verbatim quote is found in the item.
import { BudgetExceededError, complete as gatewayComplete, type CompleteFn } from '@tacit/gateway';
import { loadPrompt } from '@tacit/prompts';
import { z } from 'zod';
import { wasCached } from '../cache';
import type { ClaimKind, EvalSyncItem, ExtractedClaim, StageContext, StageResult, StageRunner } from '../contract';

export interface ExtractDeps {
  readonly complete?: CompleteFn;
  readonly maxBatchChars?: number;
  readonly maxItems?: number;
  readonly maxItemChars?: number;
  readonly concurrency?: number;
  readonly log?: (line: Record<string, unknown>) => void;
}

const KINDS: readonly ClaimKind[] = ['policy', 'number', 'date', 'owner', 'decision', 'behavior', 'process', 'customer', 'hint', 'other'];

const Output = z.object({
  items: z.array(
    z.object({
      id: z.string(),
      claims: z
        .array(
          z.object({
            text: z.string().min(1).max(600),
            kind: z.string().default('other'),
            subject: z.string().min(1).max(120).default('unspecified'),
            value: z.string().max(200).optional(),
            quote: z.string().max(400).optional(),
            confidence: z.number().min(0).max(1).default(0.5),
          }),
        )
        .default([]),
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

/** 1-based line of the first occurrence of `quote` in `content`, or null. */
export function locateQuote(content: string, quote: string): { line: number; exact: boolean } | null {
  const needle = quote.trim();
  if (needle.length < 4) return null;
  let index = content.indexOf(needle);
  let exact = true;
  if (index < 0) {
    const squash = (s: string): string => s.toLowerCase().replace(/\s+/g, ' ');
    const hay = squash(content);
    const i = hay.indexOf(squash(needle));
    if (i < 0) return null;
    // map the squashed offset back approximately by counting newlines in the original up to a proportional point
    index = Math.min(content.length - 1, Math.round((i / Math.max(1, hay.length)) * content.length));
    exact = false;
  }
  return { line: content.slice(0, index).split('\n').length, exact };
}

export function batchItems(items: readonly EvalSyncItem[], maxBatchChars: number, maxItems: number, maxItemChars: number): EvalSyncItem[][] {
  const batches: EvalSyncItem[][] = [];
  let current: EvalSyncItem[] = [];
  let chars = 0;
  for (const item of items) {
    const size = Math.min(item.content.length, maxItemChars);
    if (current.length > 0 && (chars + size > maxBatchChars || current.length >= maxItems)) {
      batches.push(current);
      current = [];
      chars = 0;
    }
    current.push(item);
    chars += size;
  }
  if (current.length > 0) batches.push(current);
  return batches;
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

export function createExtractStage(deps: ExtractDeps = {}): StageRunner {
  const complete = deps.complete ?? gatewayComplete;
  const log = deps.log ?? (() => undefined);

  return async (ctx: StageContext): Promise<StageResult> => {
    const prompt = loadPrompt('extract');
    const maxBatchChars = deps.maxBatchChars ?? Number(prompt.params.max_batch_chars ?? 9000);
    const maxItems = deps.maxItems ?? Number(prompt.params.max_items ?? 16);
    const maxItemChars = deps.maxItemChars ?? Number(prompt.params.max_item_chars ?? 6000);
    const notes: string[] = [];
    const usage = { cost_usd: 0, model_calls: 0, in_tokens: 0, out_tokens: 0, cached_calls: 0 };
    const claimsByItem = new Map<string, ExtractedClaim[]>();
    const byId = new Map(ctx.items.map((i) => [i.id, i] as const));

    const batches = batchItems(ctx.items, maxBatchChars, maxItems, maxItemChars);
    let budgetHit = false;
    let parseFailures = 0;
    let unknownIds = 0;
    let quotesMissing = 0;

    await pool(batches, deps.concurrency ?? 4, async (batch) => {
      if (budgetHit) return;
      const payload = batch.map((item) => ({ id: item.id, source: item.source, kind: item.kind ?? null, title: item.title, text: excerpt(item, maxItemChars) }));
      let text: string;
      try {
        const completion = await complete(
          'extract',
          [
            { role: 'system', content: prompt.text },
            { role: 'user', content: `Items:\n${JSON.stringify(payload)}` },
          ],
          { json: true, maxTokens: 8192, runId: ctx.run_id, orgId: ctx.org_id, budgetUsd: ctx.budget_usd },
        );
        usage.cost_usd += completion.cost_usd;
        usage.model_calls += 1;
        if (wasCached(completion)) usage.cached_calls += 1;
        usage.in_tokens += completion.usage.in_tokens + completion.usage.cache_read_tokens + completion.usage.cache_write_tokens;
        usage.out_tokens += completion.usage.out_tokens;
        text = completion.text;
      } catch (err) {
        if (err instanceof BudgetExceededError) {
          budgetHit = true;
          return;
        }
        throw err;
      }
      let parsed: z.infer<typeof Output>;
      try {
        parsed = Output.parse(extractJson(text));
      } catch {
        parseFailures += 1;
        return;
      }
      for (const entry of parsed.items) {
        const item = byId.get(entry.id);
        if (!item) {
          unknownIds += 1;
          continue;
        }
        const claims: ExtractedClaim[] = [];
        entry.claims.forEach((c, n) => {
          const kind = (KINDS as readonly string[]).includes(c.kind) ? (c.kind as ClaimKind) : 'other';
          const located = c.quote ? locateQuote(item.content, c.quote) : null;
          if (c.quote && !located) quotesMissing += 1;
          const provenance = [{ kind: item.source, ref: item.external_ref, ...(located ? { line: located.line } : {}) }];
          claims.push({
            id: `${item.id}#${n + 1}`,
            item_id: item.id,
            text: c.text.trim(),
            kind,
            subject: c.subject.trim().toLowerCase(),
            ...(c.value ? { value: c.value.trim() } : {}),
            ...(located ? { quote: c.quote?.trim() ?? '' } : {}),
            provenance,
            confidence: kind === 'hint' ? Math.min(c.confidence, 0.5) : c.confidence,
            scope_key: item.scope_key,
            acl: item.acl,
            source: item.source,
            ...(item.kind ? { item_kind: item.kind } : {}),
            modified_at: item.modified_at,
          });
        });
        claimsByItem.set(item.id, claims);
      }
    });

    const claims = ctx.items.flatMap((item) => claimsByItem.get(item.id) ?? []);
    const itemsWithoutDecision = ctx.items.filter((i) => !claimsByItem.has(i.id)).length;
    if (budgetHit) notes.push('extract: budget reached; remaining items were not extracted');
    if (parseFailures > 0) notes.push(`extract: ${parseFailures} batch(es) had unparseable output; their items yielded no claims`);
    if (unknownIds > 0) notes.push(`extract: ${unknownIds} decision(s) referenced unknown item ids and were ignored`);
    if (itemsWithoutDecision > 0) notes.push(`extract: ${itemsWithoutDecision} item(s) received no extraction result`);
    if (quotesMissing > 0) notes.push(`extract: ${quotesMissing} quote(s) not found verbatim in their item; provenance recorded without a line`);
    log({ event: 'stage', stage: 'extract', run_id: ctx.run_id, org_id: ctx.org_id, items: ctx.items.length, batches: batches.length, claims: claims.length, ...usage });

    return { artifacts: [], findings: [], usage, claims, ...(notes.length ? { notes } : {}) };
  };
}
