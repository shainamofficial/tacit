import { BudgetExceededError, type CompleteFn, type Completion } from '@tacit/gateway';
import { describe, expect, it } from 'vitest';
import type { EvalArtifact, EvalSyncItem, StageContext } from '../contract';
import { createJudgeStage, itemAuthors, sourceExcerpt } from './judge';

const item = (over: Partial<EvalSyncItem> & { id: string }): EvalSyncItem => ({
  source: 'gdrive',
  external_ref: `drive/${over.id}.md`,
  title: over.id,
  content: 'l1\nl2\nRefunds: 30 days on all plans, no questions asked.\nl4\nl5',
  acl: { kind: 'domain', domain: 'x' },
  scope_key: `gdrive:doc:${over.id}`,
  modified_at: '2026-04-04T00:00:00Z',
  ...over,
});

const artifact = (over: Partial<EvalArtifact> & { id: string }): EvalArtifact => ({
  type: 'qa_fact',
  title: over.id,
  body_md: 'The refund window is 30 days [c1]. Refunds are always instant [c2].',
  claims: [
    { text: 'The refund window is 30 days on all plans.', provenance: [{ kind: 'gdrive', ref: 'drive/pricing.md', line: 3 }], confidence: 0.9 },
    { text: 'Refunds are always processed instantly.', provenance: [{ kind: 'gdrive', ref: 'drive/pricing.md', line: 3 }], confidence: 0.9 },
  ],
  permission_scope: { require_all: ['gdrive:doc:pricing'] },
  verification_state: 'unverified',
  ...over,
});

const ctx = (artifacts: EvalArtifact[], items: EvalSyncItem[] = [item({ id: 'pricing' })]): StageContext => ({ org_id: 'org', run_id: 'run', items, claims: [], artifacts, findings: [], budget_usd: 5 });

const completion = (text: string): Completion => ({ text, provider: 'fake', model: 'fake', usage: { in_tokens: 100, out_tokens: 40, cache_read_tokens: 0, cache_write_tokens: 0 }, cost_usd: 0.05, latency_ms: 1, stop_reason: 'end_turn' });

describe('helpers', () => {
  it('extracts authors from slack titles, commit bodies, and doc owners', () => {
    expect(itemAuthors(item({ id: 'm', source: 'slack', title: '#billing marcus.webb@northwind.example', content: 'hi' }))).toEqual(['marcus.webb@northwind.example']);
    expect(itemAuthors(item({ id: 'c', source: 'github_commit', title: '#93 tune threshold', content: 'tune threshold\n\nAuthor: dev.patel@northwind.example\nDate: x' }))).toEqual(['dev.patel@northwind.example']);
    expect(itemAuthors(item({ id: 'd', content: '# Pricing\n\n_Owner: Sofia Reyes · Last updated: 2026-04-04_\n' }))).toEqual(['Sofia Reyes']);
  });
  it('excerpts around a line with numbers, or the head without one', () => {
    expect(sourceExcerpt(item({ id: 'p' }), { kind: 'gdrive', ref: 'x', line: 3 }, 1)).toBe('2: l2\n3: Refunds: 30 days on all plans, no questions asked.\n4: l4');
    expect(sourceExcerpt(item({ id: 'p' }), { kind: 'gdrive', ref: 'x' }, 1)).toContain('l1');
  });
});

describe('judge stage', () => {
  it('applies approve / edit / escalate, replaces artifacts, and turns uncertainty into gaps with knowers', async () => {
    const arts = [artifact({ id: 'a-ok', title: 'ok' }), artifact({ id: 'a-edit', title: 'edit' }), artifact({ id: 'a-esc', title: 'esc' })];
    const calls: string[] = [];
    const complete: CompleteFn = async (_stage, messages, opts) => {
      calls.push(opts?.editRateSignal ?? '');
      const packs = JSON.parse((messages[1]?.content ?? '').replace(/^Artifacts:\n/, '')) as Array<{ id: string; title: string; claims: Array<{ id: string; excerpts: string[] }> }>;
      expect(packs[0]?.claims[0]?.excerpts[0]).toMatch(/\d+: Refunds: 30 days/);
      return completion(
        JSON.stringify({
          reviews: packs.map((p) => {
            if (p.title === 'ok') return { id: p.id, decision: 'approve' };
            if (p.title === 'edit') return { id: p.id, decision: 'edit', edits: ['unsupported_claim', 'over_generalization'], drop: ['c2'], demote: ['c1'], body_md: 'Reportedly the refund window is 30 days [c1].', note: 'c2 invented' };
            return { id: p.id, decision: 'escalate', gap: 'contradiction', reason: 'sources disagree' };
          }),
        }),
      );
    };
    const result = await createJudgeStage({ complete })(ctx(arts, [item({ id: 'pricing', content: '# Pricing\n\n_Owner: Sofia Reyes · x_\nRefunds: 30 days on all plans, no questions asked.' })]));
    expect(result.replace_artifacts).toBe(true);
    expect(result.artifacts.map((a) => a.id)).toEqual(['a-ok', 'a-edit', 'a-esc']);
    const [ok, edited, esc] = result.artifacts;
    expect(ok?.verification_state).toBe('machine_consistent');
    expect(ok?.claims).toHaveLength(2);
    expect(edited?.claims).toHaveLength(1);
    expect(edited?.claims[0]?.confidence).toBe(0.5);
    expect(edited?.body_md).toBe('Reportedly the refund window is 30 days [c1].');
    expect(edited?.verification_state).toBe('machine_consistent');
    expect((edited?.meta as { judge: { edits: string[] } }).judge.edits).toEqual(['unsupported_claim', 'over_generalization']);
    expect(esc?.verification_state).toBe('unverified');
    expect(result.stats).toMatchObject({ approve: 1, edit: 1, escalate: 1, dropped_claims: 1, demoted_claims: 1, unreviewed: 0 });
    expect(result.stats?.edit_rate).toBeCloseTo(2 / 3, 5);
    const kinds = result.findings.map((f) => f.kind);
    expect(kinds).toContain('contradiction'); // escalation
    expect(kinds.filter((k) => k === 'low_confidence')).toHaveLength(1); // the demoted claim
    expect(result.findings.find((f) => f.kind === 'low_confidence')?.suggested_knowers).toEqual(['Sofia Reyes']);
    expect(result.notes?.join(' ')).toContain('edit rate 66.7%');
    expect(calls[0]).toBe('pending');
  });

  it('leaves unreviewed artifacts unverified on garbage output, retries cut-off batches, and stops at the budget', async () => {
    const arts = [artifact({ id: 'x' }), artifact({ id: 'y' })];
    const garbage: CompleteFn = async () => completion('nope');
    const r1 = await createJudgeStage({ complete: garbage, maxBatch: 1 })(ctx(arts));
    expect(r1.artifacts.every((a) => a.verification_state === 'unverified')).toBe(true);
    expect(r1.stats?.unreviewed).toBe(2);

    let n = 0;
    const cut: CompleteFn = async (_s, messages) => {
      n += 1;
      const packs = JSON.parse((messages[1]?.content ?? '').replace(/^Artifacts:\n/, '')) as Array<{ id: string }>;
      const full = JSON.stringify({ reviews: packs.map((p) => ({ id: p.id, decision: 'approve' })) });
      return completion(packs.length > 1 ? full.slice(0, full.indexOf('"a2"') + 2) : full);
    };
    const r2 = await createJudgeStage({ complete: cut, maxBatch: 2 })(ctx(arts));
    expect(r2.stats?.approve).toBe(2);
    expect(n).toBe(2);

    const budget: CompleteFn = async () => {
      throw new BudgetExceededError('run', 5, 5);
    };
    const r3 = await createJudgeStage({ complete: budget })(ctx(arts));
    expect(r3.notes?.join(' ')).toContain('budget reached');
    expect(r3.artifacts).toHaveLength(2);
  });
});
