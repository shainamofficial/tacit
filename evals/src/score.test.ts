import type { EvalArtifact, Finding, SourceRef } from '@tacit/pipeline';
import { describe, expect, it } from 'vitest';
import type { Location, ManifestDefect } from '../corpus/generator/manifest';
import { scoreContradictions, scoreDrift, scoreTribal } from './score';

const gd = (path: string, line: number, quote = 'q'): Location => ({ kind: 'gdrive', doc_id: 'doc', path, line, quote, restricted: 'none' });
const sl = (conversation: string, ts: string): Location => ({ kind: 'slack', conversation, ts, path: 'slack/x.json', user: 'u@x', quote: 'q', restricted: false });
const gh = (path: string, line: number): Location => ({ kind: 'github', path, line, quote: 'q' });
const gc = (sha: string): Location => ({ kind: 'github_commit', ordinal: 1, sha, subject: 's', quote: 'q' });

const ref = (kind: SourceRef['kind'], r: string, line?: number): SourceRef => (line === undefined ? { kind, ref: r } : { kind, ref: r, line });

const C: ManifestDefect = { id: 'C01', kind: 'contradiction', topic: 't', sources: [gd('drive/a.md', 10), sl('billing', '1.000001')], expected: { gap_kind: 'contradiction', truth: 'x', resolution: 'newer_source' } };
const C2: ManifestDefect = { id: 'C02', kind: 'contradiction', topic: 't', sources: [gd('drive/b.md', 3), gd('drive/c.md', 8)], expected: { gap_kind: 'contradiction', truth: 'x', resolution: 'unresolved' } };
const D: ManifestDefect = { id: 'D01', kind: 'drift', topic: 't', sources: [gd('drive/api.md', 5), gh('repo/src/auth.ts', 2), gc('abc')], expected: { gap_kind: 'drift', code_wins: true, truth: 'x' } };
const T: ManifestDefect = { id: 'T01', kind: 'tribal', topic: 't', sources: [sl('billing', '2.000002')], expected: { gap_kind: 'low_confidence', truth: 'x', knowers: ['marcus'], must_not_assert: true } };

const finding = (kind: Finding['kind'], refs: SourceRef[], extra: Partial<Finding> = {}): Finding => ({ kind, refs, summary: 's', ...extra });

describe('scoreContradictions', () => {
  it('counts a defect as recalled only when a finding covers two of its sources', () => {
    const findings = [
      finding('contradiction', [ref('gdrive', 'drive/a.md', 12), ref('slack', 'billing:1.000001')]),
      finding('contradiction', [ref('gdrive', 'drive/b.md')]), // one source only: not a match
    ];
    const s = scoreContradictions([C, C2], findings);
    expect(s.matched).toBe(1);
    expect(s.recall).toBe(0.5);
    expect(s.true_positives).toBe(1);
    expect(s.false_positives).toBe(1);
    expect(s.precision).toBe(0.5);
  });

  it('respects the line tolerance', () => {
    const far = finding('contradiction', [ref('gdrive', 'drive/a.md', 40), ref('slack', 'billing:1.000001')]);
    expect(scoreContradictions([C], [far]).matched).toBe(0);
  });

  it('reports null precision with no findings', () => {
    const s = scoreContradictions([C], []);
    expect(s.recall).toBe(0);
    expect(s.precision).toBeNull();
  });
});

describe('scoreDrift', () => {
  it('needs a doc-side and a code-side ref', () => {
    const docOnly = finding('drift', [ref('gdrive', 'drive/api.md')]);
    const codeOnly = finding('drift', [ref('github', 'repo/src/auth.ts'), ref('github_commit', 'abc')]);
    const both = finding('drift', [ref('gdrive', 'drive/api.md'), ref('github_commit', 'abc')]);
    expect(scoreDrift([D], [docOnly]).matched).toBe(0);
    expect(scoreDrift([D], [codeOnly]).matched).toBe(0);
    expect(scoreDrift([D], [both]).matched).toBe(1);
  });
});

describe('scoreTribal', () => {
  it('requires a correct knower for credit and accepts email, name, or key', () => {
    const noKnower = finding('low_confidence', [ref('slack', 'billing:2.000002')]);
    expect(scoreTribal([T], [noKnower], []).with_knower).toBe(0);
    expect(scoreTribal([T], [noKnower], []).surfaced).toBe(1);
    for (const who of ['marcus.webb@northwindrobotics.example', 'Marcus Webb', 'marcus']) {
      const withKnower = finding('low_confidence', [ref('slack', 'billing:2.000002')], { suggested_knowers: [who] });
      expect(scoreTribal([T], [withKnower], []).with_knower, who).toBe(1);
    }
    const wrong = finding('low_confidence', [ref('slack', 'billing:2.000002')], { suggested_knowers: ['priya'] });
    expect(scoreTribal([T], [wrong], []).with_knower).toBe(0);
  });

  it('flags a confident claim built on a tribal hint as a false assertion', () => {
    const artifact: EvalArtifact = {
      id: 'a1',
      type: 'qa_fact',
      title: 'Invoice terms',
      body_md: '',
      claims: [
        { text: 'Enterprise invoices are net-60', provenance: [ref('slack', 'billing:2.000002')], confidence: 0.95 },
        { text: 'Possibly net-60', provenance: [ref('slack', 'billing:2.000002')], confidence: 0.4 },
      ],
      permission_scope: { require_all: [] },
      verification_state: 'unverified',
    };
    const s = scoreTribal([T], [], [artifact]);
    expect(s.false_assertions).toHaveLength(1);
    expect(s.false_assertions[0]?.claim).toBe('Enterprise invoices are net-60');
  });
});
