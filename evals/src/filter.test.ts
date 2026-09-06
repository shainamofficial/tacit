import { describe, expect, it } from 'vitest';
import { loadCorpus } from './corpus';
import { mustKeepIds, noiseIds, scoreFilter } from './filter';

describe('filter metrics', () => {
  const corpus = loadCorpus();

  it('derives the must-keep set from every manifest source and the noise set from known chatter', () => {
    const mustKeep = mustKeepIds(corpus);
    const noise = noiseIds(corpus);
    expect(mustKeep.size).toBeGreaterThan(100);
    expect(noise.size).toBeGreaterThan(400);
    for (const id of mustKeep) expect(noise.has(id), id).toBe(false);
    expect([...mustKeep].some((id) => id.startsWith('github:commit:'))).toBe(true);
    expect([...mustKeep].some((id) => id.startsWith('zendesk:ticket:'))).toBe(true);
  });

  it('scores perfect, empty, and unfiltered outputs', () => {
    const noise = noiseIds(corpus);
    const perfect = corpus.items.filter((i) => !noise.has(i.id));
    expect(scoreFilter(corpus, perfect)).toMatchObject({ signal_recall: 1, noise_rejection: 1, dropped_signal: [] });

    const nothing = scoreFilter(corpus, []);
    expect(nothing.signal_recall).toBe(0);
    expect(nothing.noise_rejection).toBe(1);
    expect(nothing.dropped_signal.length).toBe(nothing.must_keep);

    const everything = scoreFilter(corpus, corpus.items);
    expect(everything).toMatchObject({ signal_recall: 1, noise_rejection: 0 });

    expect(scoreFilter(corpus, null)).toMatchObject({ signal_recall: null, noise_rejection: null });
  });
});
