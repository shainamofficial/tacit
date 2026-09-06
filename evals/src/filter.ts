// Filter-stage metrics: every item the answer key points at must survive
// (signal recall); the corpus's known chatter should not (noise rejection).
import type { EvalSyncItem } from '@tacit/pipeline';
import { NOISE } from '../corpus/generator/slack';
import type { LoadedCorpus } from './corpus';
import { locationKeys } from './match';

export interface FilterScore {
  readonly signal_recall: number | null;
  readonly noise_rejection: number | null;
  readonly must_keep: number;
  readonly must_keep_kept: number;
  readonly noise: number;
  readonly noise_kept: number;
  readonly dropped_signal: readonly string[];
  /** A sample of chatter the filter let through, for prompt iteration. */
  readonly kept_noise_sample: readonly string[];
}

export function mustKeepIds(corpus: LoadedCorpus): Set<string> {
  const ids = new Set<string>();
  for (const d of [...corpus.manifest.defects, ...corpus.manifest.distractors]) {
    for (const loc of d.sources) {
      for (const key of locationKeys(loc)) {
        const item = corpus.byRef.get(key);
        if (item) ids.add(item.id);
      }
    }
  }
  return ids;
}

export function noiseIds(corpus: LoadedCorpus): Set<string> {
  const noise = new Set<string>(NOISE);
  return new Set(corpus.items.filter((i) => i.source === 'slack' && noise.has(i.content)).map((i) => i.id));
}

export function scoreFilter(corpus: LoadedCorpus, kept: readonly EvalSyncItem[] | null): FilterScore {
  const mustKeep = mustKeepIds(corpus);
  const noise = noiseIds(corpus);
  if (kept === null) {
    return { signal_recall: null, noise_rejection: null, must_keep: mustKeep.size, must_keep_kept: 0, noise: noise.size, noise_kept: 0, dropped_signal: [], kept_noise_sample: [] };
  }
  const keptIds = new Set(kept.map((i) => i.id));
  const keptSignal = [...mustKeep].filter((id) => keptIds.has(id));
  const keptNoise = [...noise].filter((id) => keptIds.has(id));
  const byId = new Map(kept.map((i) => [i.id, i] as const));
  const keptNoiseTexts = [...new Set(keptNoise.map((id) => byId.get(id)?.content ?? ''))].sort();
  return {
    signal_recall: mustKeep.size === 0 ? null : keptSignal.length / mustKeep.size,
    noise_rejection: noise.size === 0 ? null : 1 - keptNoise.length / noise.size,
    must_keep: mustKeep.size,
    must_keep_kept: keptSignal.length,
    noise: noise.size,
    noise_kept: keptNoise.length,
    dropped_signal: [...mustKeep].filter((id) => !keptIds.has(id)).sort(),
    kept_noise_sample: keptNoiseTexts.slice(0, 25),
  };
}
