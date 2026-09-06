import { describe, expect, it } from 'vitest';
import { BudgetExceededError } from './budget';
import { createGateway, GatewayExhaustedError, GatewayRequestError, type CallLine } from './gateway';
import { MemoryLogger } from './logger';
import { ProviderRetryableError, type Provider, type ProviderRequest, type ProviderResponse } from './provider';
import { parseRouting } from './routing';

const routing = parseRouting(`
version: 1
defaults: { provider: anthropic, max_tokens: 100, effort: high }
models:
  primary:  { input_per_mtok: 10, output_per_mtok: 30, cache_write_per_mtok: 12.5, cache_read_per_mtok: 1 }
  backup:   { input_per_mtok: 2,  output_per_mtok: 6,  cache_write_per_mtok: 2.5,  cache_read_per_mtok: 0.2 }
  served:   { input_per_mtok: 1,  output_per_mtok: 1,  cache_write_per_mtok: 1,    cache_read_per_mtok: 1 }
stages:
  filter:     { model: primary, effort: low, max_tokens: 50, fallbacks: [backup] }
  extract:    { model: primary }
  draft:      { model: primary }
  judge:      { model: primary, fallbacks: [] }
  contradict: { model: primary }
  interview:  { model: primary }
  eval_judge: { model: primary, cache_system: false }
`);

interface Scripted {
  provider: Provider;
  requests: ProviderRequest[];
}

function scripted(script: Array<ProviderResponse | Error>): Scripted {
  const requests: ProviderRequest[] = [];
  let i = 0;
  const provider: Provider = {
    name: 'fake',
    async complete(req) {
      requests.push(req);
      const step = script[i++];
      if (step === undefined) throw new Error('script exhausted');
      if (step instanceof Error) throw step;
      return step;
    },
  };
  return { provider, requests };
}

const ok = (over: Partial<ProviderResponse> = {}): ProviderResponse => ({
  text: '{"answer": 42}',
  model: 'primary',
  usage: { in_tokens: 1000, out_tokens: 200, cache_read_tokens: 4000, cache_write_tokens: 500 },
  stopReason: 'end_turn',
  ...over,
});

const user = [{ role: 'user' as const, content: 'hi' }];

describe('gateway', () => {
  it('prices calls from the routing table including cache tokens', async () => {
    const { provider } = scripted([ok()]);
    const lines: CallLine[] = [];
    const gw = createGateway({ provider, routing, onCall: (l) => lines.push(l), now: () => 0 });
    const c = await gw.complete('filter', user);
    // 1000*10 + 200*30 + 500*12.5 + 4000*1 = 10000 + 6000 + 6250 + 4000 = 26250 / 1e6
    expect(c.cost_usd).toBeCloseTo(0.02625, 10);
    expect(c.text).toBe('{"answer": 42}');
    expect(c.model).toBe('primary');
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ event: 'model_call', stage: 'filter', ok: true, cost_usd: c.cost_usd });
    expect(JSON.stringify(lines[0])).not.toContain('hi');
  });

  it('routes system messages, effort, max_tokens, cache flag, and json instruction to the provider', async () => {
    const { provider, requests } = scripted([ok(), ok()]);
    const gw = createGateway({ provider, routing, onCall: () => undefined });
    await gw.complete('filter', [{ role: 'system', content: 'S1' }, { role: 'system', content: 'S2' }, ...user], { json: true });
    expect(requests[0]).toMatchObject({ model: 'primary', effort: 'low', maxTokens: 50, cacheSystem: true });
    expect(requests[0]?.system).toContain('S1\n\nS2');
    expect(requests[0]?.system).toContain('single JSON object');
    expect(requests[0]?.messages).toEqual([{ role: 'user', content: 'hi' }]);

    await gw.complete('eval_judge', user, { maxTokens: 7 });
    expect(requests[1]).toMatchObject({ maxTokens: 7, cacheSystem: false, system: undefined });
  });

  it('rejects malformed conversations before spending anything', async () => {
    const { provider, requests } = scripted([]);
    const gw = createGateway({ provider, routing, onCall: () => undefined });
    await expect(gw.complete('filter', [{ role: 'system', content: 'only system' }])).rejects.toThrow(GatewayRequestError);
    await expect(gw.complete('filter', [{ role: 'assistant', content: 'first' }])).rejects.toThrow(GatewayRequestError);
    expect(requests).toHaveLength(0);
  });

  it('fails over to the fallback model on a transient error and prices by the served model', async () => {
    const { provider, requests } = scripted([new ProviderRetryableError('529 overloaded', 529), ok({ model: 'backup' })]);
    const lines: CallLine[] = [];
    const gw = createGateway({ provider, routing, onCall: (l) => lines.push(l) });
    const c = await gw.complete('filter', user);
    expect(requests.map((r) => r.model)).toEqual(['primary', 'backup']);
    expect(c.model).toBe('backup');
    expect(c.cost_usd).toBeCloseTo((1000 * 2 + 200 * 6 + 500 * 2.5 + 4000 * 0.2) / 1e6, 10);
    expect(lines.map((l) => l.ok)).toEqual([false, true]);
    expect(lines[0]?.error).toContain('529');
  });

  it('uses the served model pricing under server-side fallback', async () => {
    const { provider } = scripted([ok({ model: 'served' })]);
    const gw = createGateway({ provider, routing, onCall: () => undefined });
    const c = await gw.complete('filter', user);
    expect(c.model).toBe('served');
    expect(c.cost_usd).toBeCloseTo((1000 + 200 + 500 + 4000) / 1e6, 10);
  });

  it('throws GatewayExhaustedError when every candidate fails transiently, and no fallback on judge', async () => {
    const { provider } = scripted([new ProviderRetryableError('429', 429), new ProviderRetryableError('500', 500)]);
    const gw = createGateway({ provider, routing, onCall: () => undefined });
    await expect(gw.complete('filter', user)).rejects.toThrow(GatewayExhaustedError);

    const judge = scripted([new ProviderRetryableError('429', 429)]);
    const gw2 = createGateway({ provider: judge.provider, routing, onCall: () => undefined });
    await expect(gw2.complete('judge', user)).rejects.toThrow(GatewayExhaustedError);
    expect(judge.requests).toHaveLength(1);
  });

  it('propagates non-transient provider errors without failing over', async () => {
    const { provider, requests } = scripted([new Error('400 bad request')]);
    const gw = createGateway({ provider, routing, onCall: () => undefined });
    await expect(gw.complete('filter', user)).rejects.toThrow('400 bad request');
    expect(requests).toHaveLength(1);
  });

  it('enforces the per-run budget as a hard stop', async () => {
    const { provider, requests } = scripted([ok(), ok(), ok()]);
    const gw = createGateway({ provider, routing, onCall: () => undefined });
    const opts = { runId: 'run-1', budgetUsd: 0.03 };
    await gw.complete('filter', user, opts); // spends 0.02625
    await expect(gw.complete('filter', user, opts)).resolves.toBeDefined(); // 0.0525 > cap, but checked before the call
    await expect(gw.complete('filter', user, opts)).rejects.toThrow(BudgetExceededError);
    expect(requests).toHaveLength(2);
    expect(gw.ledger.get('run-1')).toBeCloseTo(0.0525, 10);
    expect(gw.ledger.get('other')).toBe(0);
  });

  it('logs a model_calls record only when an org is known', async () => {
    const { provider } = scripted([ok(), ok()]);
    const logger = new MemoryLogger();
    const gw = createGateway({ provider, routing, logger, onCall: () => undefined, now: () => 5 });
    await gw.complete('filter', user);
    expect(logger.calls).toHaveLength(0);
    await gw.complete('judge', user, { orgId: 'org-1', runId: 'run-9', editRateSignal: 'approve' });
    expect(logger.calls).toHaveLength(1);
    expect(logger.calls[0]).toMatchObject({ org_id: 'org-1', run_id: 'run-9', stage: 'judge', provider: 'fake', model: 'primary', edit_rate_signal: 'approve', latency_ms: 0 });
    expect(logger.calls[0]?.usage).toEqual(ok().usage);
  });
});
