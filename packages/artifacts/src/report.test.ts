import { describe, expect, it } from 'vitest';
import { estimateHours, findingScope, renderScanReport, visibleFindings, type ServeFinding } from './report';
import { refKey, type ServeItem } from './retrieve';

const PUBLIC = 'gdrive:doc:pricing';
const EXEC = 'gdrive:doc:comp';
const CHANNEL = 'slack:channel:C1';
const items: ServeItem[] = [
  { id: 'i1', source: 'gdrive', external_ref: 'drive/pricing.md', title: 'Pricing sheet', content: 'Refunds: 30 days', scope_key: PUBLIC, modified_at: '2026-04-04T00:00:00Z' },
  { id: 'i2', source: 'zendesk', external_ref: 'macro:4', title: 'Macro #4', content: 'Refunds within 14 days', scope_key: 'zendesk:all', modified_at: '2025-11-10T00:00:00Z' },
  { id: 'i3', source: 'gdrive', external_ref: 'drive/comp.md', title: 'Comp bands', content: 'L3 $140k', scope_key: EXEC, modified_at: '2026-04-04T00:00:00Z' },
  { id: 'i4', source: 'slack', external_ref: 'billing:1.0', title: '#billing priya', content: 'refund question again', scope_key: CHANNEL, modified_at: '2026-01-01T00:00:00Z' },
  { id: 'i5', source: 'slack', external_ref: 'billing:2.0', title: '#billing maya', content: 'which refund window?', scope_key: CHANNEL, modified_at: '2026-03-01T00:00:00Z' },
  { id: 'i6', source: 'github', external_ref: 'repo/src/config.ts', title: 'repo/src/config.ts', content: 'DEFAULT_PORT = 9090', scope_key: 'github:repo:nw', modified_at: '2026-09-01T00:00:00Z' },
];
const findings: ServeFinding[] = [
  { kind: 'contradiction', refs: [{ kind: 'gdrive', ref: 'drive/pricing.md', line: 1 }, { kind: 'zendesk', ref: 'macro:4' }, { kind: 'slack', ref: 'billing:1.0' }, { kind: 'slack', ref: 'billing:2.0' }], summary: 'Refund window: pricing sheet says 30 days; macro #4 says 14 days.', suggested_knowers: ['priya.sharma@x.example'] },
  { kind: 'contradiction', refs: [{ kind: 'gdrive', ref: 'drive/comp.md', line: 1 }, { kind: 'gdrive', ref: 'drive/pricing.md', line: 1 }], summary: 'Comp bands: L3 $140k <script>alert(1)</script>' },
  { kind: 'drift', refs: [{ kind: 'gdrive', ref: 'drive/pricing.md', line: 3 }, { kind: 'github', ref: 'repo/src/config.ts', line: 1 }], summary: 'Docs vs code — port 8080 vs DEFAULT_PORT = 9090.' },
  { kind: 'low_confidence', refs: [{ kind: 'slack', ref: 'billing:1.0' }], summary: 'Implied, unwritten: enterprise invoices are net-60.', suggested_knowers: ['marcus.webb@x.example'], confidence: 0.3 },
  { kind: 'low_confidence', refs: [{ kind: 'gdrive', ref: 'drive/missing.md' }], summary: 'cites an item the snapshot does not have' },
];
const everyone = new Set([PUBLIC, 'zendesk:all', CHANNEL, 'github:repo:nw']);
const exec = new Set([...everyone, EXEC]);
const people = [{ name: 'Priya Sharma', email: 'priya.sharma@x.example', title: 'Head of Support' }];

describe('scan report scoping', () => {
  it('derives a finding scope from every cited source and fails closed on unknown refs', () => {
    const byRef = new Map(items.map((i) => [refKey({ kind: i.source, ref: i.external_ref }), i] as const));
    expect(findingScope(findings[0] as ServeFinding, byRef)).toEqual([PUBLIC, CHANNEL, 'zendesk:all'].sort());
    expect(findingScope(findings[4] as ServeFinding, byRef)).toBeNull();
    expect(visibleFindings(findings, items, everyone).map((f) => f.summary.slice(0, 12))).toEqual(['Refund windo', 'Docs vs code', 'Implied, unw']);
    expect(visibleFindings(findings, items, exec)).toHaveLength(4);
  });

  it('estimates hours from chat evidence with a floor, over the observed window', () => {
    const est = estimateHours(visibleFindings(findings, items, everyone), items, { minutesPerReanswer: 10, minReasksPerWeek: 0.5, minObservedWeeks: 4, maxGapsShown: 20 });
    // chat items span 2026-01-01..2026-03-01 ≈ 8.4 weeks; the refund conflict has 2 chat refs → 0.5 floor wins (2/8.4 = 0.24); drift has none → 0.5
    expect(est.findings).toBe(2);
    expect(est.observedWeeks).toBeCloseTo(8.43, 1);
    expect(est.reasksPerWeek).toBeCloseTo(1.0, 5);
    expect(est.hoursPerWeek).toBeCloseTo(10 / 60, 5);
  });

  it('renders only what the viewer may see, escapes source text, and names knowers', () => {
    const base = { orgName: 'Northwind', generatedAt: '2026-09-09T10:00:00Z', findings, items, people };
    const lena = renderScanReport({ ...base, viewer: { email: 'lena@x.example', scopes: everyone } });
    expect(lena.stats).toMatchObject({ contradictions: 1, drifts: 1, gaps: 1, hidden: 2 });
    expect(lena.html).toContain('Refund window: pricing sheet says 30 days');
    expect(lena.html).not.toContain('$140k');
    expect(lena.html).not.toContain('Comp bands');
    expect(lena.html).toContain('Who would know: Priya Sharma (Head of Support)');
    expect(lena.html).toContain('Doc: Pricing sheet · line 1 · 2026-04-04');
    expect(lena.html).toContain('<b>1</b><span>contradictions');
    expect(lena.html).toContain('outside this viewer');

    const alice = renderScanReport({ ...base, viewer: { email: 'alice@x.example', scopes: exec }, link: (r) => (r.kind === 'github' ? `https://example.test/${r.ref}#L${r.line ?? 1}` : null) });
    expect(alice.stats).toMatchObject({ contradictions: 2, hidden: 1 });
    expect(alice.html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(alice.html).not.toContain('<script>alert');
    expect(alice.html).toContain('href="https://example.test/repo/src/config.ts#L1"');
  });
});
