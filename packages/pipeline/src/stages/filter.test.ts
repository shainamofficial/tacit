import { BudgetExceededError, type CompleteFn, type Completion } from '@tacit/gateway';
import { describe, expect, it } from 'vitest';
import type { EvalSyncItem, StageContext } from '../contract';
import { createFilterStage, ruleDecision } from './filter';

const item = (over: Partial<EvalSyncItem> & { id: string; source: EvalSyncItem['source'] }): EvalSyncItem => ({
  external_ref: over.id,
  title: over.id,
  content: 'Some content that is long enough to matter.',
  acl: { kind: 'domain', domain: 'x' },
  scope_key: 'x',
  modified_at: '2026-01-01T00:00:00Z',
  ...over,
});

const ctx = (items: EvalSyncItem[], budget = 5): StageContext => ({ org_id: 'org', run_id: 'run', items, claims: [], artifacts: [], findings: [], budget_usd: budget });

const completion = (text: string): Completion => ({
  text,
  provider: 'fake',
  model: 'fake',
  usage: { in_tokens: 100, out_tokens: 20, cache_read_tokens: 50, cache_write_tokens: 0 },
  cost_usd: 0.01,
  latency_ms: 1,
  stop_reason: 'end_turn',
});

describe('ruleDecision', () => {
  it('keeps documents, code, macros, and channel descriptions without a model call', () => {
    expect(ruleDecision(item({ id: 'd', source: 'gdrive' }))?.keep).toBe(true);
    expect(ruleDecision(item({ id: 'repo/src/auth.ts', source: 'github' }))?.keep).toBe(true);
    expect(ruleDecision(item({ id: 'macro:4', source: 'zendesk', external_ref: 'macro:4' }))?.keep).toBe(true);
    expect(ruleDecision(item({ id: 'c', source: 'slack', kind: 'channel' }))?.keep).toBe(true);
  });
  it('drops changelog filler and acknowledgements', () => {
    expect(ruleDecision(item({ id: 'x', source: 'github', external_ref: 'repo/services/sdk/CHANGELOG.md' }))?.keep).toBe(false);
    for (const text of ['+1', 'thanks!', 'on it', ':+1:', 'ack', 'lol']) {
      expect(ruleDecision(item({ id: text, source: 'slack', content: text }))?.keep, text).toBe(false);
    }
    expect(ruleDecision(item({ id: 's', source: 'slack', content: 'brb' }))?.keep).toBe(false);
  });
  it('defers real messages and tickets to the model, keeps commits by rule', () => {
    expect(ruleDecision(item({ id: 'm', source: 'slack', content: 'Reminder: the deploy freeze is Thu 4pm now.' }))).toBeNull();
    expect(ruleDecision(item({ id: 'ticket:1', source: 'zendesk', external_ref: 'ticket:1' }))).toBeNull();
    expect(ruleDecision(item({ id: 'sha', source: 'github_commit', content: 'tune threshold' }))?.keep).toBe(true);
  });
});

describe('filter stage', () => {
  const items = [
    item({ id: 'doc', source: 'gdrive' }),
    item({ id: 'ack', source: 'slack', content: '+1' }),
    item({ id: 'policy', source: 'slack', content: 'Heads up: the self-approval limit is $250 now.' }),
    item({ id: 'lunch', source: 'slack', content: 'lunch at 12:30? thinking the taco place' }),
    item({ id: 'commit', source: 'github_commit', content: 'remove legacy key auth' }),
  ];

  it('applies rules, sends the rest to the model in one batch, and annotates kept items', async () => {
    const calls: Array<{ ids: string[]; system: string }> = [];
    const complete: CompleteFn = async (stage, messages) => {
      expect(stage).toBe('filter');
      const user = messages.find((m) => m.role === 'user')?.content ?? '';
      const payload = JSON.parse(user.replace(/^Items:\n/, '')) as Array<{ id: string }>;
      calls.push({ ids: payload.map((p) => p.id), system: messages[0]?.content ?? '' });
      return completion(
        JSON.stringify({
          decisions: [
            { id: 'policy', keep: true, reason: 'expense limit', topics: ['expense policy'] },
            { id: 'lunch', keep: false, reason: 'social' },
            { id: 'commit', keep: true, reason: 'auth change', topics: ['auth'] },
          ],
        }),
      );
    };
    const result = await createFilterStage({ complete })(ctx(items));
    expect(calls).toHaveLength(1);
    expect(calls[0]?.ids).toEqual(['policy', 'lunch']);
    expect(calls[0]?.system).toContain('When unsure, KEEP');
    expect(result.items?.map((i) => i.id)).toEqual(['doc', 'policy', 'commit']);
    expect((result.items?.[1]?.meta as { filter: { topics: string[]; by: string } }).filter).toMatchObject({ topics: ['expense policy'], by: 'model' });
    expect((result.items?.[0]?.meta as { filter: { by: string } }).filter.by).toBe('rule');
    expect(result.usage).toEqual({ cost_usd: 0.01, model_calls: 1, in_tokens: 150, out_tokens: 20, cached_calls: 0 });
    expect(result.notes).toBeUndefined();
  });

  it('batches by batchSize and keeps items the model forgot', async () => {
    let n = 0;
    const complete: CompleteFn = async () => {
      n += 1;
      return completion(JSON.stringify({ decisions: [{ id: 'lunch', keep: false, reason: 'social' }] }));
    };
    const result = await createFilterStage({ complete, batchSize: 1 })(ctx(items));
    expect(n).toBe(2);
    expect(result.items?.map((i) => i.id)).toEqual(['doc', 'policy', 'commit']);
    expect(result.notes?.join(' ')).toContain('1 item(s) kept by default');
  });

  it('fails open on unparseable output', async () => {
    const complete: CompleteFn = async () => completion('I cannot help with that.');
    const result = await createFilterStage({ complete })(ctx(items));
    expect(result.items?.map((i) => i.id)).toEqual(['doc', 'policy', 'lunch', 'commit']);
    expect(result.notes?.join(' ')).toContain('unparseable');
  });

  it('keeps the remainder when the budget is exhausted and does not swallow other errors', async () => {
    const budget: CompleteFn = async () => {
      throw new BudgetExceededError('run', 5, 5);
    };
    const result = await createFilterStage({ complete: budget })(ctx(items));
    expect(result.items?.map((i) => i.id)).toEqual(['doc', 'policy', 'lunch', 'commit']);
    expect(result.notes?.join(' ')).toContain('budget reached');

    const boom: CompleteFn = async () => {
      throw new Error('provider down');
    };
    await expect(createFilterStage({ complete: boom })(ctx(items))).rejects.toThrow('provider down');
  });
});
