// Stage 2: extract (implementation-plan §7.2). Schema-constrained extraction
// of atomic claims from each kept item, with provenance down to the line when
// the model's verbatim quote is found in the item.
//
// Output can be long (a policy doc yields a dozen claims), so truncated
// responses are expected: every complete claim is salvaged from a cut-off
// JSON body and the items that got nothing are split into smaller batches
// and retried, down to one item per call.
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
  readonly maxTokens?: number;
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
type ParsedOutput = z.infer<typeof Output>;

function tryParse(text: string): ParsedOutput | null {
  try {
    return Output.parse(JSON.parse(text));
  } catch {
    return null;
  }
}

/**
 * Parse the model's JSON; when it is cut off, keep every complete item/claim
 * by closing the structure at the last object boundary that still parses.
 */
export function parseOutput(text: string): { parsed: ParsedOutput | null; salvaged: boolean } {
  const start = text.indexOf('{');
  if (start < 0) return { parsed: null, salvaged: false };
  const body = text.slice(start);
  const end = body.lastIndexOf('}');
  if (end >= 0) {
    const whole = tryParse(body.slice(0, end + 1));
    if (whole) return { parsed: whole, salvaged: false };
  }
  let tries = 0;
  for (let i = body.length - 1; i >= 0 && tries < 400; i--) {
    if (body[i] !== '}') continue;
    tries += 1;
    const head = body.slice(0, i + 1);
    for (const suffix of [']}]}', ']}']) {
      const parsed = tryParse(head + suffix);
      if (parsed) return { parsed, salvaged: true };
    }
  }
  return { parsed: null, salvaged: false };
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

export function createExtractStage(deps: ExtractDeps = {}): StageRunner {
  const complete = deps.complete ?? gatewayComplete;
  const log = deps.log ?? (() => undefined);

  return async (ctx: StageContext): Promise<StageResult> => {
    const prompt = loadPrompt('extract');
    const maxBatchChars = deps.maxBatchChars ?? Number(prompt.params.max_batch_chars ?? 6000);
    const maxItems = deps.maxItems ?? Number(prompt.params.max_items ?? 8);
    const maxItemChars = deps.maxItemChars ?? Number(prompt.params.max_item_chars ?? 6000);
    const maxTokens = deps.maxTokens ?? Number(prompt.params.max_tokens ?? 16000);
    const notes: string[] = [];
    const usage = { cost_usd: 0, model_calls: 0, in_tokens: 0, out_tokens: 0, cached_calls: 0 };
    const claimsByItem = new Map<string, ExtractedClaim[]>();
    const byId = new Map(ctx.items.map((i) => [i.id, i] as const));

    const queue: EvalSyncItem[][] = batchItems(ctx.items, maxBatchChars, maxItems, maxItemChars);
    const initialBatches = queue.length;
    let budgetHit = false;
    let parseFailures = 0;
    let unknownIds = 0;
    let quotesMissing = 0;
    let truncated = 0;
    let retries = 0;
    let unrecoverable = 0;

    const record = (item: EvalSyncItem, entry: ParsedOutput['items'][number]): void => {
      const claims: ExtractedClaim[] = [];
      entry.claims.forEach((c, n) => {
        const kind = (KINDS as readonly string[]).includes(c.kind) ? (c.kind as ClaimKind) : 'other';
        const located = c.quote ? locateQuote(item.content, c.quote) : null;
        if (c.quote && !located) quotesMissing += 1;
        claims.push({
          id: `${item.id}#${n + 1}`,
          item_id: item.id,
          text: c.text.trim(),
          kind,
          subject: c.subject.trim().toLowerCase(),
          ...(c.value ? { value: c.value.trim() } : {}),
          ...(located ? { quote: c.quote?.trim() ?? '' } : {}),
          provenance: [{ kind: item.source, ref: item.external_ref, ...(located ? { line: located.line } : {}) }],
          confidence: kind === 'hint' ? Math.min(c.confidence, 0.5) : c.confidence,
          scope_key: item.scope_key,
          acl: item.acl,
          source: item.source,
          ...(item.kind ? { item_kind: item.kind } : {}),
          modified_at: item.modified_at,
        });
      });
      claimsByItem.set(item.id, claims);
    };

    const runBatch = async (batch: EvalSyncItem[]): Promise<void> => {
      if (budgetHit) return;
      const payload = batch.map((item) => ({ id: item.id, source: item.source, kind: item.kind ?? null, title: item.title, text: excerpt(item, maxItemChars) }));
      let text: string;
      let cutOff: boolean;
      try {
        const completion = await complete(
          'extract',
          [
            { role: 'system', content: prompt.text },
            { role: 'user', content: `Items:\n${JSON.stringify(payload)}` },
          ],
          { json: true, maxTokens, runId: ctx.run_id, orgId: ctx.org_id, budgetUsd: ctx.budget_usd },
        );
        usage.cost_usd += completion.cost_usd;
        usage.model_calls += 1;
        if (wasCached(completion)) usage.cached_calls += 1;
        usage.in_tokens += completion.usage.in_tokens + completion.usage.cache_read_tokens + completion.usage.cache_write_tokens;
        usage.out_tokens += completion.usage.out_tokens;
        text = completion.text;
        cutOff = completion.stop_reason === 'max_tokens';
      } catch (err) {
        if (err instanceof BudgetExceededError) {
          budgetHit = true;
          return;
        }
        throw err;
      }
      const { parsed, salvaged } = parseOutput(text);
      if (cutOff || salvaged) truncated += 1;
      if (!parsed) parseFailures += 1;
      for (const entry of parsed?.items ?? []) {
        const item = byId.get(entry.id);
        if (!item) {
          unknownIds += 1;
          continue;
        }
        record(item, entry);
      }
      // Items that got nothing from a cut-off or unparseable response: split and retry.
      const missing = batch.filter((item) => !claimsByItem.has(item.id));
      if (missing.length > 0 && (cutOff || salvaged || !parsed)) {
        if (batch.length === 1) {
          unrecoverable += 1;
          return;
        }
        const mid = Math.ceil(missing.length / 2);
        queue.push(missing.slice(0, mid));
        if (mid < missing.length) queue.push(missing.slice(mid));
        retries += 1;
      }
    };

    const workers = Array.from({ length: Math.max(1, deps.concurrency ?? 4) }, async () => {
      while (queue.length > 0) {
        const batch = queue.shift();
        if (batch) await runBatch(batch);
      }
    });
    await Promise.all(workers);

    const claims = ctx.items.flatMap((item) => claimsByItem.get(item.id) ?? []);
    const itemsWithoutResult = ctx.items.filter((i) => !claimsByItem.has(i.id)).length;
    if (budgetHit) notes.push('extract: budget reached; remaining items were not extracted');
    if (truncated > 0) notes.push(`extract: ${truncated} response(s) were cut off; complete claims were salvaged and ${retries} split batch(es) retried`);
    if (unrecoverable > 0) notes.push(`extract: ${unrecoverable} single-item batch(es) still cut off; those items yielded partial or no claims`);
    if (parseFailures > 0) notes.push(`extract: ${parseFailures} response(s) had no parseable JSON`);
    if (unknownIds > 0) notes.push(`extract: ${unknownIds} entries referenced unknown item ids and were ignored`);
    if (itemsWithoutResult > 0) notes.push(`extract: ${itemsWithoutResult} item(s) received no extraction result`);
    if (quotesMissing > 0) notes.push(`extract: ${quotesMissing} quote(s) not found verbatim in their item; provenance recorded without a line`);
    log({ event: 'stage', stage: 'extract', run_id: ctx.run_id, org_id: ctx.org_id, items: ctx.items.length, batches: initialBatches, retries, claims: claims.length, ...usage });

    return { artifacts: [], findings: [], usage, claims, ...(notes.length ? { notes } : {}) };
  };
}
