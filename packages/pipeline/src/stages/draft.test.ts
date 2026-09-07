import { BudgetExceededError, type CompleteFn, type Completion } from '@tacit/gateway';
import { describe, expect, it } from 'vitest';
import type { ExtractedClaim, StageContext } from '../contract';
import { createDraftStage, mergeClaims, normalizeSubject, variantsFor } from './draft';

const claim = (over: Partial<ExtractedClaim> & { id: string; text: string; subject: string }): ExtractedClaim => ({
  item_id: over.id.split('#')[0] ?? over.id,
  kind: 'policy',
  provenance: [{ kind: 'gdrive', ref: `drive/${over.id.split('#')[0]}.md`, line: 3 }],
  confidence: 0.9,
  scope_key: `gdrive:doc:${over.id.split('#')[0]}`,
  acl: { kind: 'domain', domain: 'x' },
  source: 'gdrive',
  modified_at: '2026-04-04T00:00:00Z',
  ...over,
});

const ctx = (claims: ExtractedClaim[]): StageContext => ({ org_id: 'org', run_id: 'run', items: [], claims, artifacts: [], findings: [], budget_usd: 5 });

const completion = (text: string): Completion => ({
  text,
  provider: 'fake',
  model: 'fake',
  usage: { in_tokens: 100, out_tokens: 40, cache_read_tokens: 0, cache_write_tokens: 0 },
  cost_usd: 0.02,
  latency_ms: 1,
  stop_reason: 'end_turn',
});

const EXEC = { kind: 'users' as const, emails: ['alice@x'] };

describe('grouping helpers', () => {
  it('normalizes subjects', () => {
    expect(normalizeSubject('  Refund   Window! ')).toBe('refund window');
  });

  it('merges identical texts and unions provenance, keeping restricted-ness', () => {
    const merged = mergeClaims([
      claim({ id: 'a#1', text: 'PTO is 20 days.', subject: 'pto', confidence: 0.8 }),
      claim({ id: 'b#1', text: 'pto is 20 days.', subject: 'pto', confidence: 0.9, modified_at: '2026-06-01T00:00:00Z' }),
      claim({ id: 'c#1', text: 'PTO is unlimited.', subject: 'pto', acl: EXEC, scope_key: 'gdrive:doc:c' }),
    ]);
    expect(merged).toHaveLength(2);
    expect(merged[0]).toMatchObject({ text: 'PTO is 20 days.', confidence: 0.9, restricted: false, date: '2026-06-01', scope_keys: ['gdrive:doc:a', 'gdrive:doc:b'] });
    expect(merged[0]?.provenance).toHaveLength(2);
    expect(merged[1]?.restricted).toBe(true);
  });

  it('splits a topic into a public variant and one per restricted scope (F-SEC-1)', () => {
    const merged = mergeClaims([
      claim({ id: 'pub#1', text: 'Public fact.', subject: 'comp' }),
      claim({ id: 'exec#1', text: 'Exec-only fact.', subject: 'comp', acl: EXEC, scope_key: 'gdrive:doc:exec' }),
      claim({ id: 'fin#1', text: 'Finance-only fact.', subject: 'comp', acl: EXEC, scope_key: 'gdrive:doc:fin' }),
    ]);
    const variants = variantsFor('comp', merged);
    expect(variants.map((v) => v.scope)).toEqual(['public', 'gdrive:doc:exec', 'gdrive:doc:fin']);
    expect(variants[0]?.claims.map((c) => c.text)).toEqual(['Public fact.']);
    expect(variants[1]?.claims.map((c) => c.text)).toEqual(['Exec-only fact.', 'Public fact.']);
    expect(variants[2]?.claims.map((c) => c.text)).toEqual(['Finance-only fact.', 'Public fact.']);
    expect(variantsFor('only', mergeClaims([claim({ id: 'x#1', text: 'r', subject: 'only', acl: EXEC })])).map((v) => v.scope)).toEqual(['gdrive:doc:x']);
  });
});

describe('draft stage', () => {
  const claims = [
    claim({ id: 'pricing#1', text: 'The refund window is 30 days on all plans.', subject: 'refund window', quote: 'Refunds: 30 days' }),
    claim({ id: 'macro#1', text: 'Refunds are available within 14 days of purchase.', subject: 'refund policy', source: 'zendesk', provenance: [{ kind: 'zendesk', ref: 'macro:4' }], scope_key: 'zendesk:all', modified_at: '2025-11-10T00:00:00Z' }),
    claim({ id: 'comp#1', text: 'Engineering L4 band is $168,000 to $204,000.', subject: 'compensation bands', acl: EXEC, scope_key: 'gdrive:doc:exec' }),
    claim({ id: 'hint#1', text: 'Enterprise invoices may follow special Globex terms.', subject: 'enterprise invoice terms', kind: 'hint', confidence: 0.4, source: 'slack', provenance: [{ kind: 'slack', ref: 'billing:1.000001' }], scope_key: 'slack:channel:C4' }),
  ];

  function fakeComplete(): { complete: CompleteFn; calls: string[] } {
    const calls: string[] = [];
    const complete: CompleteFn = async (_stage, messages) => {
      const system = messages[0]?.content ?? '';
      const user = messages[1]?.content ?? '';
      calls.push(system.startsWith('You will receive a list of subjects') ? 'cluster' : 'draft');
      if (system.startsWith('You will receive a list of subjects')) {
        return completion(JSON.stringify({ topics: [{ topic: 'refund window', subjects: ['refund window', 'refund policy'] }, { topic: 'compensation bands', subjects: ['compensation bands'] }, { topic: 'invoice terms', subjects: ['enterprise invoice terms'] }] }));
      }
      const groups = JSON.parse(user.replace(/^Groups:\n/, '')) as Array<{ group: string; topic: string; claims: Array<{ id: string; text: string }> }>;
      return completion(
        JSON.stringify({
          artifacts: groups.map((g) => {
            if (g.topic === 'refund window') {
              return { group: g.group, type: 'qa_fact', title: 'Refund window', body_md: `The pricing sheet says 30 days [${g.claims[0]?.id}]; macro #4 says 14 days [${g.claims[1]?.id}].`, used: g.claims.map((c) => c.id), conflicts: [[g.claims[0]?.id, g.claims[1]?.id]] };
            }
            if (g.topic === 'invoice terms') {
              return { group: g.group, type: 'qa_fact', title: 'Enterprise invoice terms', body_md: `Reportedly, enterprise invoices follow Globex terms [${g.claims[0]?.id}].`, used: [g.claims[0]?.id], uncertain: [g.claims[0]?.id] };
            }
            return { group: g.group, type: 'entity_card', title: g.topic, body_md: `${g.claims[0]?.text} [${g.claims[0]?.id}]`, used: [g.claims[0]?.id, 'c99'], dropped: [{ id: 'c42', reason: 'noise' }] };
          }),
        }),
      );
    };
    return { complete, calls };
  }

  it('clusters, groups, drafts, and scopes artifacts to the union of cited scope keys', async () => {
    const { complete, calls } = fakeComplete();
    const result = await createDraftStage({ complete })(ctx(claims));
    expect(calls[0]).toBe('cluster');
    expect(result.artifacts).toHaveLength(3);
    const refund = result.artifacts.find((a) => a.title === 'Refund window');
    expect(refund?.claims).toHaveLength(2);
    expect(refund?.permission_scope.require_all).toEqual(['gdrive:doc:pricing', 'zendesk:all']);
    expect((refund?.meta as { conflicts: string[][] }).conflicts).toEqual([['pricing#1', 'macro#1']]);
    expect(refund?.body_md).toContain('30 days');

    const comp = result.artifacts.find((a) => a.type === 'entity_card');
    expect(comp?.permission_scope.require_all).toEqual(['gdrive:doc:exec']);
    expect(comp?.claims.map((c) => c.text)).toEqual(['Engineering L4 band is $168,000 to $204,000.']);
    expect((comp?.meta as { scope: string }).scope).toBe('gdrive:doc:exec');

    const hint = result.artifacts.find((a) => a.title === 'Enterprise invoice terms');
    expect(hint?.claims[0]?.confidence).toBe(0.4);
    expect((hint?.meta as { uncertain: string[] }).uncertain).toEqual(['hint#1']);
    expect(result.usage.model_calls).toBe(2);
    expect(result.artifacts.every((a) => a.verification_state === 'unverified')).toBe(true);
  });

  it('salvages a cut-off draft response and retries the lost groups', async () => {
    let drafts = 0;
    const complete: CompleteFn = async (_stage, messages) => {
      const system = messages[0]?.content ?? '';
      if (system.startsWith('You will receive a list of subjects')) return completion('{"topics":[]}');
      drafts += 1;
      const groups = JSON.parse((messages[1]?.content ?? '').replace(/^Groups:\n/, '')) as Array<{ group: string; topic: string; claims: Array<{ id: string }> }>;
      const full = JSON.stringify({ artifacts: groups.map((g) => ({ group: g.group, title: g.topic, body_md: `x [${g.claims[0]?.id}]`, used: [g.claims[0]?.id] })) });
      if (groups.length > 1) return completion(full.slice(0, full.indexOf('"g2"') + 2)); // second group cut off
      return completion(full);
    };
    const result = await createDraftStage({ complete, maxGroups: 10, maxBatchChars: 100000 })(ctx(claims));
    expect(result.artifacts).toHaveLength(4); // every subject its own topic; all drafted after retries
    expect(drafts).toBeGreaterThan(1);
    expect(result.notes?.join(' ')).toContain('cut off');
  });

  it('stops at the budget with a note and propagates other errors', async () => {
    const budget: CompleteFn = async () => {
      throw new BudgetExceededError('run', 5, 5);
    };
    const result = await createDraftStage({ complete: budget })(ctx(claims));
    expect(result.artifacts).toEqual([]);
    expect(result.notes?.join(' ')).toContain('budget reached');
    const boom: CompleteFn = async () => {
      throw new Error('down');
    };
    await expect(createDraftStage({ complete: boom })(ctx(claims))).rejects.toThrow('down');
  });
});
