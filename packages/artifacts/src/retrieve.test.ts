import { describe, expect, it } from 'vitest';
import { Retriever, canSee, type ServeArtifact, type ServeItem } from './retrieve';

const art = (id: string, title: string, body: string, scopes: string[], claims: ServeArtifact['claims'] = []): ServeArtifact => ({
  id,
  type: 'qa_fact',
  title,
  body_md: body,
  claims,
  permission_scope: { require_all: scopes },
  verification_state: 'machine_consistent',
});

const PUBLIC = 'gdrive:doc:pricing';
const EXEC = 'gdrive:doc:comp-bands';
const artifacts = [
  art('a1', 'Refund window', 'The refund window is 30 days on all plans [c1].', [PUBLIC], [{ text: 'Refunds are 30 days.', provenance: [{ kind: 'gdrive', ref: 'drive/Sales/pricing-sheet.md', line: 13 }], confidence: 0.9 }]),
  art('a2', 'Engineering compensation bands', 'Engineering compensation bands for 2026: L3 $140k–$165k, raises planned in Q3 [c1].', [EXEC], [{ text: 'Raises planned in Q3.', provenance: [{ kind: 'gdrive', ref: 'drive/Exec-Restricted/compensation-bands-2026.md', line: 9 }], confidence: 0.9 }]),
];
const everyone = new Set([PUBLIC]);
const exec = new Set([PUBLIC, EXEC]);

describe('Retriever', () => {
  it('filters by permission scope: every required scope must be held', () => {
    expect(canSee(artifacts[1] as ServeArtifact, everyone)).toBe(false);
    expect(canSee(artifacts[1] as ServeArtifact, exec)).toBe(true);
  });

  it('distinguishes a query miss from a permission miss internally, and never returns hidden cards', () => {
    const r = new Retriever(artifacts);
    expect(r.lookup('refund window', everyone)).toMatchObject({ kind: 'hit', entries: [{ id: 'a1', verification_state: 'machine_consistent', sources: 1 }] });
    expect(r.lookup('compensation bands raises', everyone)).toEqual({ kind: 'permission_miss' });
    expect(r.lookup('compensation bands raises', exec)).toMatchObject({ kind: 'hit', entries: [{ id: 'a2' }] });
    expect(r.lookup('quantum teleportation', exec)).toEqual({ kind: 'query_miss' });
    // One common word in common is noise, not a hit — otherwise a real miss never reaches the gap log.
    const filler = Array.from({ length: 12 }, (_, i) => art(`f${i}`, `Filler ${i}`, 'Plans for the quarter are on track.', [PUBLIC]));
    expect(new Retriever([...artifacts, ...filler]).lookup('are plans afoot', everyone)).toEqual({ kind: 'query_miss' });
    // …but a single rare, specific term is enough.
    expect(new Retriever([...artifacts, ...filler]).lookup('compensation', exec)).toMatchObject({ kind: 'hit', entries: [{ id: 'a2' }] });
    const hit = r.lookup('refund window', everyone);
    if (hit.kind === 'hit') expect(hit.entries[0]?.summary).not.toContain('[c1]');
  });

  it('get returns null for hidden and unknown ids alike', () => {
    const r = new Retriever(artifacts);
    expect(r.get('a2', everyone)).toBeNull();
    expect(r.get('nope', exec)).toBeNull();
    expect(r.get('a2', exec)?.title).toBe('Engineering compensation bands');
  });

  it('sources re-check each item scope and excerpt around the cited line', () => {
    const r = new Retriever(artifacts);
    const items: ServeItem[] = [
      { id: 'i1', source: 'gdrive', external_ref: 'drive/Sales/pricing-sheet.md', title: 'Pricing sheet', content: Array.from({ length: 20 }, (_, i) => (i === 12 ? 'Refunds: 30 days on all plans.' : `line ${i + 1}`)).join('\n'), scope_key: PUBLIC, modified_at: '2026-04-04T00:00:00Z' },
      { id: 'i2', source: 'gdrive', external_ref: 'drive/Exec-Restricted/compensation-bands-2026.md', title: 'Comp bands', content: 'secret', scope_key: EXEC, modified_at: '2026-04-04T00:00:00Z' },
    ];
    const lookupItem = (ref: { ref: string }): ServeItem | undefined => items.find((i) => i.external_ref === ref.ref);
    const spans = r.sources(artifacts[0] as ServeArtifact, everyone, lookupItem, 1);
    expect(spans).toHaveLength(1);
    expect(spans[0]?.excerpt).toBe('12: line 12\n13: Refunds: 30 days on all plans.\n14: line 14');
    // A caller holding the card but not the source scope gets no span from it.
    expect(r.sources(artifacts[1] as ServeArtifact, new Set([EXEC, PUBLIC]), () => items[1], 1)).toHaveLength(1);
    expect(r.sources(artifacts[1] as ServeArtifact, everyone, () => items[1], 1)).toHaveLength(0);
  });
});
