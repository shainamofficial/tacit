import { BudgetExceededError, type CompleteFn, type Completion } from '@tacit/gateway';
import { describe, expect, it } from 'vitest';
import type { EvalSyncItem, StageContext } from '../contract';
import { batchItems, createExtractStage, locateQuote } from './extract';

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

const completion = (text: string): Completion => ({
  text,
  provider: 'fake',
  model: 'fake',
  usage: { in_tokens: 100, out_tokens: 40, cache_read_tokens: 0, cache_write_tokens: 0 },
  cost_usd: 0.03,
  latency_ms: 1,
  stop_reason: 'end_turn',
});

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
    expect(result.notes?.join(' ')).toContain('1 decision(s) referenced unknown item ids');
    expect(result.notes?.join(' ')).toContain('1 quote(s) not found');
  });

  it('yields no claims on unparseable output and notes items without a result', async () => {
    const complete: CompleteFn = async () => completion('nope');
    const result = await createExtractStage({ complete })(ctx([item({ id: 'a' }), item({ id: 'b' })]));
    expect(result.claims).toEqual([]);
    expect(result.notes?.join(' ')).toContain('unparseable');
    expect(result.notes?.join(' ')).toContain('2 item(s) received no extraction result');
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
