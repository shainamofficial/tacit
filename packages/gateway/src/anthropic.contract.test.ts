// Contract tests against the real Anthropic API. Skipped without credentials.
// Cost: a few cents per run (short prompts, low effort, one ~6k-token cached
// system prompt sent twice to prove cache reads).
import { describe, expect, it } from 'vitest';
import { AnthropicProvider } from './anthropic';
import { createGateway } from './gateway';
import { MemoryLogger } from './logger';

const hasKey = Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);

describe.skipIf(!hasKey)('AnthropicProvider contract (live API)', () => {
  const logger = new MemoryLogger();
  const gw = createGateway({ provider: AnthropicProvider.fromEnv(), logger, onCall: () => undefined });

  it('completes an eval_judge call and returns JSON, usage, and a positive cost', async () => {
    const c = await gw.complete(
      'eval_judge',
      [
        { role: 'system', content: 'You grade claims. Reply with {"supported": boolean, "reason": string}.' },
        { role: 'user', content: 'CLAIM: The refund window is 30 days.\n\nSOURCE: Refunds: 30 days on all plans, no questions asked.' },
      ],
      { json: true, orgId: '00000000-0000-0000-0000-000000000000', runId: 'contract' },
    );
    expect(c.model).toMatch(/^claude-/);
    expect(c.usage.in_tokens).toBeGreaterThan(0);
    expect(c.usage.out_tokens).toBeGreaterThan(0);
    expect(c.cost_usd).toBeGreaterThan(0);
    expect(c.latency_ms).toBeGreaterThan(0);
    const parsed = JSON.parse(c.text) as { supported: boolean };
    expect(parsed.supported).toBe(true);
    expect(logger.calls).toHaveLength(1);
  }, 60_000);

  it('reads the system prompt from cache on the second identical call (F-CMP-5)', async () => {
    // ~6k tokens so the prefix clears the minimum cacheable length on Opus-tier models.
    const filler = Array.from({ length: 400 }, (_, i) => `Policy clause ${i}: warehouse picking arms must be calibrated every ${(i % 9) + 1} weeks and logged in the control plane.`).join('\n');
    const messages = [
      { role: 'system' as const, content: `You answer questions about the following policy document.\n\n${filler}` },
      { role: 'user' as const, content: 'How often must arms be calibrated per clause 7? Answer with the number of weeks only.' },
    ];
    const first = await gw.complete('filter', messages, { runId: 'cache' });
    const second = await gw.complete('filter', messages, { runId: 'cache' });
    expect(first.usage.cache_write_tokens + first.usage.cache_read_tokens).toBeGreaterThan(0);
    expect(second.usage.cache_read_tokens).toBeGreaterThan(1000);
    expect(second.cost_usd).toBeLessThan(first.cost_usd);
    expect(gw.ledger.get('cache')).toBeCloseTo(first.cost_usd + second.cost_usd, 10);
  }, 90_000);
});
