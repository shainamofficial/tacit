import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { CompleteFn, Completion } from '@tacit/gateway';
import { afterEach, describe, expect, it } from 'vitest';
import { FileCompletionCache, cacheKey, cachedGatewayComplete, wasCached } from './cache';

const completion = (text: string): Completion => ({
  text,
  provider: 'fake',
  model: 'fake',
  usage: { in_tokens: 10, out_tokens: 5, cache_read_tokens: 0, cache_write_tokens: 0 },
  cost_usd: 0.02,
  latency_ms: 1,
  stop_reason: 'end_turn',
});

describe('FileCompletionCache', () => {
  let dir: string;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    delete process.env.TACIT_STAGE_CACHE_DIR;
  });

  it('serves identical requests from disk with the original cost, and misses on any change', async () => {
    dir = mkdtempSync(path.join(tmpdir(), 'tacit-cache-'));
    let calls = 0;
    const complete: CompleteFn = async () => {
      calls += 1;
      return completion(`answer ${calls}`);
    };
    const cached = new FileCompletionCache(dir).wrap(complete);
    const msgs = [{ role: 'user' as const, content: 'hi' }];

    const a = await cached('filter', msgs, { json: true });
    const b = await cached('filter', msgs, { json: true });
    expect(calls).toBe(1);
    expect(b.text).toBe('answer 1');
    expect(b.cost_usd).toBe(0.02);
    expect(wasCached(a)).toBe(false);
    expect(wasCached(b)).toBe(true);

    await cached('filter', msgs, { json: false });
    await cached('extract', msgs, { json: true });
    await cached('filter', [{ role: 'user', content: 'hi!' }], { json: true });
    expect(calls).toBe(4);
    expect(cacheKey('filter', msgs, { json: true, runId: 'x' })).toBe(cacheKey('filter', msgs, { json: true, runId: 'y' }));
  });

  it('cachedGatewayComplete bypasses the cache unless TACIT_STAGE_CACHE_DIR is set', async () => {
    dir = mkdtempSync(path.join(tmpdir(), 'tacit-cache-'));
    let calls = 0;
    const complete: CompleteFn = async () => {
      calls += 1;
      return completion('x');
    };
    const fn = cachedGatewayComplete(complete);
    const msgs = [{ role: 'user' as const, content: 'q' }];
    await fn('filter', msgs);
    await fn('filter', msgs);
    expect(calls).toBe(2);
    process.env.TACIT_STAGE_CACHE_DIR = dir;
    await fn('filter', msgs);
    await fn('filter', msgs);
    expect(calls).toBe(3);
  });
});
