// Content-addressed completion cache (F-CMP-5: never re-process unchanged
// content). Keyed by stage + full message list + the options that change the
// answer, so a prompt or model-route edit misses and re-runs. Cached hits
// return the original Completion — including its cost_usd — so $/compile
// still reports what a fresh compile would cost; callers count hits via
// `wasCached`.
//
// The eval harness uses a file cache under evals/out; the workers will use
// the database keyed by content hash the same way.
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { CompleteFn, CompleteOptions, Completion, Message, Stage } from '@tacit/gateway';

const CACHED = new WeakSet<Completion>();

export function wasCached(completion: Completion): boolean {
  return CACHED.has(completion);
}

export function cacheKey(stage: Stage, messages: readonly Message[], opts: CompleteOptions | undefined): string {
  const material = JSON.stringify({ stage, messages, json: opts?.json ?? false, maxTokens: opts?.maxTokens ?? null });
  return createHash('sha256').update(material).digest('hex');
}

export class FileCompletionCache {
  constructor(private readonly dir: string) {
    mkdirSync(dir, { recursive: true });
  }

  private file(key: string): string {
    return path.join(this.dir, `${key.slice(0, 2)}`, `${key}.json`);
  }

  get(key: string): Completion | null {
    try {
      const parsed = JSON.parse(readFileSync(this.file(key), 'utf8')) as Completion;
      CACHED.add(parsed);
      return parsed;
    } catch {
      return null;
    }
  }

  set(key: string, completion: Completion): void {
    const file = this.file(key);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(completion));
  }

  /** Wrap a CompleteFn so identical requests are served from disk. */
  wrap(complete: CompleteFn): CompleteFn {
    return async (stage, messages, opts) => {
      const key = cacheKey(stage, messages, opts);
      const hit = this.get(key);
      if (hit) return hit;
      const fresh = await complete(stage, messages, opts);
      this.set(key, fresh);
      return fresh;
    };
  }
}

/**
 * The gateway's complete(), cached on disk when TACIT_STAGE_CACHE_DIR is set.
 * Resolved per call so callers may set the variable after import.
 */
export function cachedGatewayComplete(complete: CompleteFn): CompleteFn {
  const caches = new Map<string, FileCompletionCache>();
  return async (stage, messages, opts) => {
    const dir = process.env.TACIT_STAGE_CACHE_DIR;
    if (!dir) return complete(stage, messages, opts);
    let cache = caches.get(dir);
    if (!cache) {
      cache = new FileCompletionCache(dir);
      caches.set(dir, cache);
    }
    return cache.wrap(complete)(stage, messages, opts);
  };
}
