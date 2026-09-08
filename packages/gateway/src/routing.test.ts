import { describe, expect, it } from 'vitest';
import { loadRouting, parseRouting, resolveRoute, STAGES } from './routing';

describe('routing.yaml', () => {
  const routing = loadRouting();

  it('parses and prices every stage and fallback', () => {
    for (const stage of STAGES) {
      const route = resolveRoute(routing, stage);
      expect(routing.models[route.model], `${stage} model`).toBeDefined();
      for (const fb of route.fallbacks) expect(routing.models[fb], `${stage} fallback ${fb}`).toBeDefined();
      expect(route.maxTokens).toBeGreaterThan(0);
    }
  });

  it('routes everything to Claude for now (plan §1.3) with no fallback on judgment stages', () => {
    for (const stage of STAGES) expect(resolveRoute(routing, stage).model).toMatch(/^claude-/);
    for (const stage of ['judge', 'contradict', 'interview'] as const) {
      expect(resolveRoute(routing, stage).fallbacks).toEqual([]);
    }
  });

  it('applies defaults for effort and max_tokens', () => {
    const r = parseRouting(`
version: 1
defaults: { provider: anthropic, max_tokens: 999, effort: medium }
models: { m: { input_per_mtok: 1, output_per_mtok: 2, cache_write_per_mtok: 1.25, cache_read_per_mtok: 0.1 } }
stages:
  filter: { model: m }
  extract: { model: m }
  draft: { model: m }
  judge: { model: m }
  contradict: { model: m, effort: max, max_tokens: 5 }
  contradict_verify: { model: m }
  interview: { model: m }
  eval_judge: { model: m }
`);
    expect(resolveRoute(r, 'filter')).toMatchObject({ model: 'm', effort: 'medium', maxTokens: 999, cacheSystem: true });
    expect(resolveRoute(r, 'contradict')).toMatchObject({ effort: 'max', maxTokens: 5 });
  });

  it('rejects a stage whose model or fallback has no pricing', () => {
    const base = `
version: 1
defaults: { provider: anthropic, max_tokens: 10, effort: low }
models: { m: { input_per_mtok: 1, output_per_mtok: 2, cache_write_per_mtok: 1.25, cache_read_per_mtok: 0.1 } }
stages:
  filter: { model: m }
  extract: { model: m }
  draft: { model: m }
  judge: { model: m }
  contradict: { model: m }
  contradict_verify: { model: m }
  interview: { model: m }
`;
    expect(() => parseRouting(`${base}  eval_judge: { model: unknown-model }\n`)).toThrow(/no pricing entry/);
    expect(() => parseRouting(`${base}  eval_judge: { model: m, fallbacks: [ghost] }\n`)).toThrow(/no pricing entry/);
  });

  it('rejects a missing stage', () => {
    expect(() =>
      parseRouting(`
version: 1
defaults: { provider: anthropic, max_tokens: 10, effort: low }
models: { m: { input_per_mtok: 1, output_per_mtok: 2, cache_write_per_mtok: 1.25, cache_read_per_mtok: 0.1 } }
stages: { filter: { model: m } }
`),
    ).toThrow();
  });
});
