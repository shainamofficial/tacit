import { BudgetExceededError, type CompleteFn, type Completion } from '@tacit/gateway';
import { describe, expect, it } from 'vitest';
import type { EvalArtifact, EvalSyncItem, ExtractedClaim, Finding, StageContext } from '../contract';
import { capClaims, createContradictStage, groupByTopic, isCodeRef, resolveKnower } from './contradict';
import { mergeClaims } from './draft';

const PEOPLE = [
  { name: 'Priya Sharma', email: 'priya.sharma@x.example', title: 'Head of Support', handle: 'priya-sharma' },
  { name: 'Marcus Webb', email: 'marcus.webb@x.example', title: 'Staff Engineer, Billing' },
  { name: 'Maya Lindqvist', email: 'maya.lindqvist@x.example', title: 'Support Engineer' },
];

const item = (id: string, over: Partial<EvalSyncItem> = {}): EvalSyncItem => ({
  id,
  source: 'gdrive',
  external_ref: `drive/${id}.md`,
  title: id,
  content: 'l1\nl2\nl3\nl4\nl5',
  acl: { kind: 'domain', domain: 'x' },
  scope_key: `gdrive:doc:${id}`,
  modified_at: '2026-04-04T00:00:00Z',
  ...over,
});

const claim = (id: string, itemId: string, text: string, over: Partial<ExtractedClaim> = {}): ExtractedClaim => ({
  id,
  item_id: itemId,
  text,
  kind: 'policy',
  subject: 'refund window',
  provenance: [{ kind: 'gdrive', ref: `drive/${itemId}.md`, line: 3 }],
  confidence: 0.9,
  scope_key: `gdrive:doc:${itemId}`,
  acl: { kind: 'domain', domain: 'x' },
  source: 'gdrive',
  modified_at: '2026-04-04T00:00:00Z',
  ...over,
});

const completion = (text: string): Completion => ({ text, provider: 'fake', model: 'fake', usage: { in_tokens: 100, out_tokens: 40, cache_read_tokens: 0, cache_write_tokens: 0 }, cost_usd: 0.05, latency_ms: 1, stop_reason: 'end_turn' });

describe('helpers', () => {
  it('tells code refs from prose refs', () => {
    expect(isCodeRef({ kind: 'github', ref: 'repo/services/cp/src/auth.ts' })).toBe(true);
    expect(isCodeRef({ kind: 'github', ref: 'repo/docs/api.md' })).toBe(false);
    expect(isCodeRef({ kind: 'github_commit', ref: 'abc' })).toBe(true);
    expect(isCodeRef({ kind: 'gdrive', ref: 'drive/x.md' })).toBe(false);
  });

  it('resolves knowers through the directory and passes unknowns through', () => {
    expect(resolveKnower('Priya Sharma', PEOPLE)).toBe('priya.sharma@x.example');
    expect(resolveKnower('@priya-sharma', PEOPLE)).toBe('priya.sharma@x.example');
    expect(resolveKnower('marcus', PEOPLE)).toBe('marcus.webb@x.example');
    expect(resolveKnower('Priya Sharma (Head of Support)', PEOPLE)).toBe('priya.sharma@x.example');
    expect(resolveKnower('someone in finance', PEOPLE)).toBe('someone in finance');
  });

  it('groups claims by the draft topics, drops judge-dropped claims, and flags cross-source/uncertain topics', () => {
    const claims = [
      claim('c1', 'pricing', 'Refunds are 30 days.', { subject: 'refund window' }),
      claim('c2', 'macro4', 'Refunds are 14 days.', { subject: 'refund period' }),
      claim('c3', 'pricing', 'Invented claim.', { subject: 'refund window' }),
      claim('c4', 'billing', 'Enterprise is on the usual Globex terms.', { subject: 'enterprise invoice terms', kind: 'hint', confidence: 0.4 }),
      claim('c5', 'other', 'Unclustered fact.', { subject: 'Node  Version!' }),
    ];
    const art: EvalArtifact = {
      id: 'a1', type: 'qa_fact', title: 'Refunds', body_md: 'x', permission_scope: { require_all: [] }, verification_state: 'machine_consistent',
      claims: [{ text: 'Refunds are 30 days.', provenance: [], confidence: 0.9 }, { text: 'Refunds are 14 days.', provenance: [], confidence: 0.9 }],
      meta: { topic: 'refund window', claim_ids: ['c1', 'c2', 'c3'], conflicts: [['c1', 'c2']] },
    };
    const topics = groupByTopic(claims, [art]);
    expect(topics.map((t) => t.name)).toEqual(['enterprise invoice terms', 'node version', 'refund window']);
    const refund = topics.find((t) => t.name === 'refund window');
    expect(refund?.claims.map((c) => c.text)).toEqual(['Refunds are 30 days.', 'Refunds are 14 days.']); // c3 dropped by the judge
    expect(refund?.crossSource).toBe(true);
    expect(refund?.uncertain).toBe(false);
    expect(topics.find((t) => t.name === 'enterprise invoice terms')).toMatchObject({ crossSource: false, uncertain: true });
  });

  it('caps claims per topic keeping one per item first', () => {
    const merged = mergeClaims([claim('a', 'i1', 'one'), claim('b', 'i1', 'two'), claim('c', 'i2', 'three'), claim('d', 'i3', 'four')]);
    expect(capClaims(merged, 3).map((c) => c.text)).toEqual(['one', 'three', 'four']);
  });
});

describe('contradict stage', () => {
  const items = [
    item('pricing', { title: 'Pricing sheet', content: 'l1\nl2\nRefunds: 30 days on all plans.\nl4' }),
    item('macro4', { source: 'zendesk', external_ref: 'macro:4', title: 'Macro #4: Refunds', scope_key: 'zendesk:all', content: 'Per our refund policy, refunds are available within 14 days.', modified_at: '2025-11-10T00:00:00Z' }),
    item('apidoc', { source: 'github', external_ref: 'repo/docs/api.md', title: 'repo/docs/api.md', scope_key: 'github:repo:nw', content: 'l1\nRate limit: 60 requests per minute.\nl3' }),
    item('ratelimit', { source: 'github', external_ref: 'repo/services/cp/src/rateLimit.ts', title: 'repo/services/cp/src/rateLimit.ts', scope_key: 'github:repo:nw', content: 'export const LIMIT = 120;' }),
    item('billing', { source: 'slack', external_ref: 'billing:1.0', title: '#billing maya.lindqvist@x.example', scope_key: 'slack:channel:C1', content: 'Could you attach a photo of the damaged unit before we approve the RMA?' }),
  ];
  const claims = [
    claim('c1', 'pricing', 'Refunds are 30 days on all plans.', { provenance: [{ kind: 'gdrive', ref: 'drive/pricing.md', line: 3 }] }),
    claim('c2', 'macro4', 'Refunds are available within 14 days.', { subject: 'refund period', provenance: [{ kind: 'zendesk', ref: 'macro:4' }], source: 'zendesk', modified_at: '2025-11-10T00:00:00Z' }),
    claim('c3', 'apidoc', 'Rate limit is 60 requests per minute.', { subject: 'api rate limit', kind: 'number', provenance: [{ kind: 'github', ref: 'repo/docs/api.md', line: 2 }], source: 'github' }),
    claim('c4', 'ratelimit', 'LIMIT is 120 per minute.', { subject: 'rate limit constant', kind: 'behavior', provenance: [{ kind: 'github', ref: 'repo/services/cp/src/rateLimit.ts', line: 1 }], source: 'github' }),
    claim('c5', 'billing', 'Agents ask for a photo before approving an RMA.', { subject: 'rma photo', kind: 'hint', confidence: 0.4, provenance: [{ kind: 'slack', ref: 'billing:1.0' }], source: 'slack' }),
    claim('c6', 'pricing', 'Pricing is in USD.', { subject: 'pricing currency', provenance: [{ kind: 'gdrive', ref: 'drive/pricing.md', line: 1 }] }),
  ];
  const artifacts: EvalArtifact[] = [
    { id: 'a1', type: 'qa_fact', title: 'Refund window', body_md: 'x', permission_scope: { require_all: [] }, verification_state: 'unverified', claims: [{ text: claims[0]!.text, provenance: claims[0]!.provenance, confidence: 0.9 }, { text: claims[1]!.text, provenance: claims[1]!.provenance, confidence: 0.9 }], meta: { topic: 'refund window', claim_ids: ['c1', 'c2'], conflicts: [['c1', 'c2']], judge: { decision: 'escalate', gap: 'contradiction' } } },
    { id: 'a2', type: 'qa_fact', title: 'Rate limit', body_md: 'x', permission_scope: { require_all: [] }, verification_state: 'machine_consistent', claims: [{ text: claims[2]!.text, provenance: claims[2]!.provenance, confidence: 0.9 }, { text: claims[3]!.text, provenance: claims[3]!.provenance, confidence: 0.9 }], meta: { topic: 'api rate limit', claim_ids: ['c3', 'c4'], conflicts: [] } },
    { id: 'a3', type: 'qa_fact', title: 'RMA', body_md: 'x', permission_scope: { require_all: [] }, verification_state: 'machine_consistent', claims: [{ text: claims[4]!.text, provenance: claims[4]!.provenance, confidence: 0.4 }], meta: { topic: 'rma photo', claim_ids: ['c5'], conflicts: [] } },
    { id: 'a4', type: 'qa_fact', title: 'Currency', body_md: 'x', permission_scope: { require_all: [] }, verification_state: 'unverified', claims: [{ text: claims[5]!.text, provenance: claims[5]!.provenance, confidence: 0.9 }], meta: { topic: 'pricing currency', claim_ids: ['c6'], conflicts: [], judge: { decision: 'escalate', gap: 'contradiction' } } },
  ];
  const priorFindings: Finding[] = [
    { kind: 'contradiction', refs: claims[0]!.provenance, summary: 'Escalated: Refund window' },
    { kind: 'contradiction', refs: claims[5]!.provenance, summary: 'Escalated: Currency' },
  ];
  const ctx = (over: Partial<StageContext> = {}): StageContext => ({ org_id: 'org', run_id: 'run', items, claims, artifacts, findings: priorFindings, budget_usd: 5, people: PEOPLE, ...over });

  it('discovers, verifies, classifies doc-vs-code as drift, routes implied knowledge to knowers, and keeps unconfirmed escalations', async () => {
    const seen: string[] = [];
    const complete: CompleteFn = async (stage, messages) => {
      seen.push(stage);
      const user = messages[1]?.content ?? '';
      if (stage === 'contradict') {
        expect(user).toContain('Directory:');
        expect(user).toContain('Priya Sharma — Head of Support');
        const topics = JSON.parse(user.slice(user.indexOf('Topics:\n') + 8)) as Array<{ topic: string; claims: Array<{ id: string; text: string; by?: string }> }>;
        const out = topics.map((t) => {
          const id = (text: string): string => t.claims.find((c) => c.text === text)?.id ?? 'none';
          if (t.topic === 'api rate limit') return { topic: t.topic, conflicts: [{ claims: [id('Rate limit is 60 requests per minute.'), id('LIMIT is 120 per minute.')], question: 'rate limit per minute', summary: 'doc says 60; code says 120', newer: id('LIMIT is 120 per minute.') }], implied: [] };
          if (t.topic === 'rma photo') return { topic: t.topic, conflicts: [], implied: [{ claims: [id('Agents ask for a photo before approving an RMA.')], rule: 'Hardware RMAs require a photo before approval.', knowers: ['Priya Sharma'], why: 'support norm; head of support owns it' }] };
          return { topic: t.topic, conflicts: [], implied: [] };
        });
        return completion(JSON.stringify({ topics: out }));
      }
      const cands = JSON.parse(user.slice(user.indexOf('Candidates:\n') + 12)) as Array<{ id: string; question: string; sides: Array<{ id: string; claim: string; source: string }> }>;
      for (const c of cands) expect(c.sides[0]?.source).toMatch(/\(\w+ .*\d{4}-\d{2}-\d{2}/);
      return completion(
        JSON.stringify({
          results: cands.map((c) => {
            const texts = c.sides.map((s) => s.claim).join(' | ');
            if (texts.includes('Refunds')) return { id: c.id, verdict: 'contradiction', summary: 'Pricing sheet says 30 days (2026-04-04); macro #4 says 14 days (2025-11-10)', newer: 'a' };
            if (texts.includes('LIMIT')) return { id: c.id, verdict: 'contradiction', summary: 'docs/api.md says 60; rateLimit.ts says 120', newer: 'b' };
            return { id: c.id, verdict: 'consistent', summary: 'same' };
          }),
        }),
      );
    };
    const result = await createContradictStage({ complete })(ctx());
    expect(seen).toContain('contradict');
    expect(seen).toContain('contradict_verify');
    expect(result.replace_finding_kinds).toEqual(['contradiction']);
    expect(result.artifacts).toHaveLength(0);

    const contradictions = result.findings.filter((f) => f.kind === 'contradiction');
    expect(contradictions).toHaveLength(1); // refund window (doc vs macro); rate limit is doc-vs-code → drift only
    expect(contradictions[0]?.refs.map((r) => r.ref).sort()).toEqual(['drive/pricing.md', 'macro:4']);
    expect(contradictions[0]?.summary).toContain('Newer: "Refunds are 30 days on all plans."');

    const drifts = result.findings.filter((f) => f.kind === 'drift');
    expect(drifts).toHaveLength(1);
    expect(drifts[0]?.refs.map((r) => r.ref).sort()).toEqual(['repo/docs/api.md', 'repo/services/cp/src/rateLimit.ts']);

    const gaps = result.findings.filter((f) => f.kind === 'low_confidence');
    const implied = gaps.find((f) => f.summary.startsWith('Implied, unwritten: Hardware RMAs'));
    expect(implied?.suggested_knowers).toEqual(['priya.sharma@x.example']);
    expect(implied?.refs).toEqual([{ kind: 'slack', ref: 'billing:1.0' }]);
    // The currency escalation had no confirmed conflict: kept as a human-review gap, not deleted.
    const kept = gaps.find((f) => f.summary.startsWith('Escalated: Currency'));
    expect(kept?.summary).toContain('needs a human');
    expect(gaps.some((f) => f.summary.startsWith('Escalated: Refund window'))).toBe(false);

    expect(result.stats).toMatchObject({ topics: 4, eligible_topics: 3, contradictions: 1, drifts: 1, implied: 1, escalations_kept: 1, verified: 2, from_judge: 1, from_draft: 0 });
    expect(result.stats?.candidates).toBe(2);
  });

  it('survives garbage output, retries cut-off batches, and stops at the budget without losing prior escalations', async () => {
    const garbage: CompleteFn = async () => completion('nope');
    const r1 = await createContradictStage({ complete: garbage })(ctx());
    expect(r1.findings.filter((f) => f.kind === 'contradiction')).toHaveLength(0);
    expect(r1.findings.filter((f) => f.kind === 'low_confidence')).toHaveLength(2); // both escalations kept
    expect(r1.notes?.join(' ')).toContain('no parseable JSON');

    let discoveryCalls = 0;
    const cut: CompleteFn = async (stage, messages) => {
      if (stage !== 'contradict') return completion('{"results":[]}');
      discoveryCalls += 1;
      const user = messages[1]?.content ?? '';
      const topics = JSON.parse(user.slice(user.indexOf('Topics:\n') + 8)) as Array<{ topic: string }>;
      const full = JSON.stringify({ topics: topics.map((t) => ({ topic: t.topic, conflicts: [], implied: [] })) });
      return completion(topics.length > 1 ? full.slice(0, full.lastIndexOf('{"topic"') - 1) : full);
    };
    const r2 = await createContradictStage({ complete: cut, maxBatchChars: 100_000 })(ctx());
    expect(discoveryCalls).toBeGreaterThan(1);
    expect(r2.notes?.join(' ')).toContain('split batch');

    const budget: CompleteFn = async () => {
      throw new BudgetExceededError('run', 5, 5);
    };
    const r3 = await createContradictStage({ complete: budget })(ctx());
    expect(r3.notes?.join(' ')).toContain('budget reached');
    expect(r3.findings.filter((f) => f.kind === 'low_confidence')).toHaveLength(2);
  });
});
