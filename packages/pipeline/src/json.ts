// Parsing model JSON that may be cut off by the output cap. Model output is
// untrusted: everything goes through a zod schema, and a truncated body is
// closed at the last object boundary that still validates so complete
// entries survive. Callers retry whatever was lost.
import type { z } from 'zod';

export interface Salvaged<T> {
  readonly parsed: T | null;
  readonly salvaged: boolean;
}

function tryParse<T>(text: string, schema: z.ZodType<T>): T | null {
  try {
    return schema.parse(JSON.parse(text));
  } catch {
    return null;
  }
}

/**
 * @param suffixes closers to try after each candidate cut point, e.g. `]}` for
 *   `{"items":[{...},{...}` and `]}]}` for a cut inside a nested array.
 */
export function parseWithSalvage<T>(text: string, schema: z.ZodType<T>, suffixes: readonly string[], maxTries = 400): Salvaged<T> {
  const start = text.indexOf('{');
  if (start < 0) return { parsed: null, salvaged: false };
  const body = text.slice(start);
  const end = body.lastIndexOf('}');
  if (end >= 0) {
    const whole = tryParse(body.slice(0, end + 1), schema);
    if (whole) return { parsed: whole, salvaged: false };
  }
  let tries = 0;
  for (let i = body.length - 1; i >= 0 && tries < maxTries; i--) {
    if (body[i] !== '}') continue;
    tries += 1;
    const head = body.slice(0, i + 1);
    for (const suffix of suffixes) {
      const parsed = tryParse(head + suffix, schema);
      if (parsed) return { parsed, salvaged: true };
    }
  }
  return { parsed: null, salvaged: false };
}

/** Run `fn` over a work queue with bounded concurrency; `fn` may push more work. */
export async function drain<T>(queue: T[], concurrency: number, fn: (job: T) => Promise<void>): Promise<void> {
  const workers = Array.from({ length: Math.max(1, concurrency) }, async () => {
    while (queue.length > 0) {
      const job = queue.shift();
      if (job !== undefined) await fn(job);
    }
  });
  await Promise.all(workers);
}
