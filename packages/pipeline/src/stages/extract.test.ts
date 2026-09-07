import { BudgetExceededError, type CompleteFn, type Completion } from '@tacit/gateway';
import { describe, expect, it } from 'vitest';
import type { EvalSyncItem, StageContext } from '../contract';
import { batchItems, createExtractStage, locateQuote, parseOutput } from './extract';

const item = (over: Partial<EvalSyncItem> & { id: string }): EvalSyncItem => ({
  source: 'gdrive',
  external_ref: `drive/${over.id}.md`,
  title: over.id,
  content: 'line one\nRefunds: 30 days on all plans, no questions asked.\nline three',
  acl: { kind: 'domain', domain: 'x' },
  scope_key: 'gdrive:doc:1',
  modified_at: '2026-01-01T00:00:00Z',
  ...over,
});

const ctx = (items: EvalSyncItem[]): StageContext => ({ org_id: 'org', run_id: 'run', items, claims: [], artifacts: [], findings: [], budget_usd: 5 });

const completion = (text: string, stop = 'end_turn'): Completion => ({
  text,
  provider: 'fake',
  model: 'fake',
  usage: { in_tokens: 100, out_tokens: 40, cache_read_tokens: 0, cache_write_tokens: 0 },
  cost_usd: 0.03,
  latency_ms: 1,
  stop_reason: stop,
});

const claim = (text: string, quote?: string) => ({ text, kind: 'policy', subject: 's', confidence: 0.9, ...(quote ? { quote } : {}) });

describe('locateQuote', () => {
  const content = 'Alpha\nBeta gamma   delta\nEpsilon';
  it('finds exact quotes with their line, tolerates whitespace/case, and rejects tiny or absent quotes', () => {
    expect(locateQuote(content, 'Beta gamma')).toEqual({ line: 2, exact: true });
    expect(locateQuote(content, 'beta gamma delta')?.exact).toBe(false);
    expect(locateQuote(content, 'zeta')).toBeNull();
    expect(locateQuote(content, 'Be')).toBeNull();
  });
});

describe('batchItems', () => {
  it('splits by character budget and item count', () => {
    const items = Array.from({ length: 5 }, (_, i) => item({ id: `i${i}`, content: 'x'.repeat(400) }));
    expect(batchItems(items, 1000, 16, 6000).map((b) => b.length)).toEqual([2, 2, 1]);
    expect(batchItems(items, 100000, 2, 6000).map((b) => b.length)).toEqual([2, 2, 1]);
    expect(batchItems(items, 100000, 16, 100).map((b) => b.length)).toEqual([5]);
  });
});

describe('parseOutput', () => {
  const full = JSON.stringify({ items: [{ id: 'a', claims: [claim('one'), claim('two')] }, { id: 'b', claims: [claim('three')] }] });
  it('parses complete output', () => {
    expect(parseOutput(`Sure:\n${full}`)).toMatchObject({ salvaged: false });
    expect(parseOutput(full).parsed?.items).toHaveLength(2);
  });
  it('salvages every complete claim from a cut-off body', () => {
    const cut = full.slice(0, full.indexOf('"three"') + 3); // mid-way through the second item's first claim
    const { parsed, salvaged } = parseOutput(cut);
    expect(salvaged).toBe(true);
    expect(parsed?.items.map((i) => i.id)).toEqual(['a']);
    expect(parsed?.items[0]?.claims).toHaveLength(2);
  });
  it('salvages at an item boundary too', () => {
    const cut = full.slice(0, full.indexOf(',{"id":"b"'));
    expect(parseOutput(cut).parsed?.items.map((i) => i.id)).toEqual(['a']);
  });
  it('gives up on garbage', () => {
    expect(parseOutput('nothing here')).toEqual({ parsed: null, salvaged: false });
  });
});

describe('extract stage', () => {
  it('turns model output into claims with line-level provenance and item scope', async () => {
    const complete: CompleteFn = async (stage, messages) => {
      expect(stage).toBe('extract');
      expect(messages[0]?.content).toContain('atomic factual claim');
      return completion(
        JSON.stringify({
          items: [
            {
              id: 'pricing',
              claims: [
                { text: 'The refund window is 30 days on all plans.', kind: 'policy', subject: 'Refund Window', value: '30 days', quote: 'Refunds: 30 days on all plans', confidence: 0.95 },
                { text: 'Something implied.', kind: 'hint', subject: 'x', quote: 'not in the text', confidence: 0.9 },
                { text: 'Weird kind.', kind: 'banana', subject: 'y', confidence: 0.6 },
              ],
            },
            { id: 'ghost', claims: [{ text: 'nope', kind: 'policy', subject: 'z', confidence: 1 }] },
          ],
        }),
      );
    };
    const result = await createExtractStage({ complete })(ctx([item({ id: 'pricing' })]));
    expect(result.claims).toHaveLength(3);
    const [a, b, c] = result.claims ?? [];
    expect(a).toMatchObject({ id: 'pricing#1', item_id: 'pricing', kind: 'policy', subject: 'refund window', value: '30 days', quote: 'Refunds: 30 days on all plans', confidence: 0.95, scope_key: 'gdrive:doc:1', source: 'gdrive' });
    expect(a?.provenance).toEqual([{ kind: 'gdrive', ref: 'drive/pricing.md', line: 2 }]);
    expect(b?.confidence).toBe(0.5); // hints are capped
    expect(b?.provenance).toEqual([{ kind: 'gdrive', ref: 'drive/pricing.md' }]);
    expect(b?.quote).toBeUndefined();
    expect(c?.kind).toBe('other');
    expect(result.usage).toMatchObject({ model_calls: 1, cost_usd: 0.03, cached_calls: 0 });
    expect(result.notes?.join(' ')).toContain('1 entries referenced unknown item ids');
    expect(result.notes?.join(' ')).toContain('1 quote(s) not found');
  });

  it('salvages a cut-off batch and retries the missing items in smaller batches', async () => {
    const items = ['a', 'b', 'c', 'd'].map((id) => item({ id }));
    const calls: string[][] = [];
    const complete: CompleteFn = async (_stage, messages) => {
      const ids = (JSON.parse((messages[1]?.content ?? '').replace(/^Items:\n/, '')) as Array<{ id: string }>).map((p) => p.id);
      calls.push(ids);
      if (ids.length === 4) {
        // first item complete, second cut off mid-claim
        const text = JSON.stringify({ items: [{ id: 'a', claims: [claim('A1', 'line one')] }, { id: 'b', claims: [claim('B1')] }] });
        return completion(text.slice(0, text.indexOf('"B1"') + 2), 'max_tokens');
      }
      return completion(JSON.stringify({ items: ids.map((id) => ({ id, claims: [claim(`${id.toUpperCase()}1`, 'line three')] })) }));
    };
    const result = await createExtractStage({ complete, maxItems: 4, maxBatchChars: 100000 })(ctx(items));
    expect(calls[0]).toEqual(['a', 'b', 'c', 'd']);
    expect(calls.slice(1).map((c) => c.join(',')).sort()).toEqual(['b,c', 'd']);
    expect(result.claims?.map((c) => c.id).sort()).toEqual(['a#1', 'b#1', 'c#1', 'd#1']);
    expect(result.claims?.find((c) => c.id === 'a#1')?.provenance[0]?.line).toBe(1);
    expect(result.usage.model_calls).toBe(3);
    expect(result.notes?.join(' ')).toContain('1 response(s) were cut off');
    expect(result.notes?.join(' ')).toContain('1 split batch(es) retried');
  });

  it('gives up on a single item that is still cut off, and notes items without a result', async () => {
    let n = 0;
    const complete: CompleteFn = async () => {
      n += 1;
      return completion('{"items":[{"id":"a","claims":[{"text":"never closes', 'max_tokens');
    };
    const result = await createExtractStage({ complete })(ctx([item({ id: 'a' })]));
    expect(n).toBe(1);
    expect(result.claims).toEqual([]);
    expect(result.notes?.join(' ')).toContain('1 single-item batch(es) still cut off');
    expect(result.notes?.join(' ')).toContain('1 item(s) received no extraction result');
  });

  it('stops at the budget and propagates other errors', async () => {
    const budget: CompleteFn = async () => {
      throw new BudgetExceededError('run', 5, 5);
    };
    const result = await createExtractStage({ complete: budget })(ctx([item({ id: 'a' })]));
    expect(result.claims).toEqual([]);
    expect(result.notes?.join(' ')).toContain('budget reached');
    const boom: CompleteFn = async () => {
      throw new Error('down');
    };
    await expect(createExtractStage({ complete: boom })(ctx([item({ id: 'a' })]))).rejects.toThrow('down');
  });
});
