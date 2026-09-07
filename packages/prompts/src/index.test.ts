import { describe, expect, it } from 'vitest';
import { loadPrompt, parsePrompt } from './index';

describe('prompts', () => {
  it('loads filter.md with its front matter', () => {
    const p = loadPrompt('filter');
    expect(p.stage).toBe('filter');
    expect(p.version).toBe(2);
    expect(p.params).toMatchObject({ batch_size: 40 });
    expect(p.text).toContain('When unsure, KEEP');
    expect(p.text).toContain('"decisions"');
  });

  it('rejects prompts without front matter or body', () => {
    expect(() => parsePrompt('x', 'no front matter')).toThrow(/front matter/);
    expect(() => parsePrompt('x', '---\nstage: x\nversion: 1\n---\n\n')).toThrow(/empty body/);
    expect(() => parsePrompt('x', '---\nstage: x\n---\nbody')).toThrow();
  });
});
