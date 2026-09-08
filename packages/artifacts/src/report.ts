// The contradiction-scan report (F-ADM-4): the first-hour experience. One
// self-contained HTML page — contradictions and code-vs-docs drift with source
// links, the implied-knowledge gaps with who to ask, and one headline number:
// estimated hours per week the company spends re-answering questions its own
// sources disagree on. Printable to PDF from the browser; no external assets.
//
// It is a read path, so it is permission-scoped like every other one
// (F-SEC-1, CLAUDE.md #2): a finding's scope is the set of scope keys of every
// source it cites, and a viewer sees a finding only when they hold all of them.
// Counts and the headline are computed over visible findings only, so the
// report never hints at what it hides.
import { refKey, type ServeItem, type SourceRef } from './retrieve';

export interface ServeFinding {
  readonly kind: 'contradiction' | 'drift' | 'low_confidence' | 'query_miss';
  readonly refs: readonly SourceRef[];
  readonly summary: string;
  readonly suggested_knowers?: readonly string[];
  readonly confidence?: number;
}
export interface ReportPerson {
  readonly name: string;
  readonly email: string;
  readonly title?: string;
}

export interface ReportAssumptions {
  /** minutes a person spends re-answering one question whose sources disagree */
  readonly minutesPerReanswer: number;
  /** floor on how often each open contradiction/drift gets re-asked, per week */
  readonly minReasksPerWeek: number;
  /** shortest observation window used when inferring re-ask rates from chat/tickets */
  readonly minObservedWeeks: number;
  /** implied-knowledge gaps shown in full before the rest are summarised */
  readonly maxGapsShown: number;
}
export const DEFAULT_ASSUMPTIONS: ReportAssumptions = { minutesPerReanswer: 10, minReasksPerWeek: 0.5, minObservedWeeks: 4, maxGapsShown: 20 };

/** Turn a source ref into a link. Return null for "no link, show the reference as text". */
export type LinkResolver = (ref: SourceRef, item: ServeItem | undefined) => string | null;

export interface ScanReportInput {
  readonly orgName: string;
  readonly generatedAt: string;
  readonly viewer: { readonly email: string; readonly scopes: ReadonlySet<string> };
  readonly findings: readonly ServeFinding[];
  readonly items: readonly ServeItem[];
  readonly people?: readonly ReportPerson[];
  readonly assumptions?: Partial<ReportAssumptions>;
  readonly link?: LinkResolver;
}

/** Scope keys of every source a finding cites; unknown refs are treated as restricted (fail closed). */
export function findingScope(f: ServeFinding, itemsByRef: ReadonlyMap<string, ServeItem>): readonly string[] | null {
  const scopes = new Set<string>();
  for (const r of f.refs) {
    const item = itemsByRef.get(refKey(r));
    if (!item) return null;
    scopes.add(item.scope_key);
  }
  return [...scopes].sort();
}

export function visibleFindings(findings: readonly ServeFinding[], items: readonly ServeItem[], scopes: ReadonlySet<string>): ServeFinding[] {
  const byRef = new Map(items.map((i) => [refKey({ kind: i.source, ref: i.external_ref }), i] as const));
  return findings.filter((f) => {
    const s = findingScope(f, byRef);
    return s !== null && s.every((k) => scopes.has(k));
  });
}

const isChat = (item: ServeItem): boolean => item.source === 'slack' || (item.source === 'zendesk' && !item.external_ref.startsWith('macro:'));

export interface HoursEstimate {
  readonly hoursPerWeek: number;
  readonly findings: number;
  readonly reasksPerWeek: number;
  readonly observedWeeks: number;
  readonly assumptions: ReportAssumptions;
}

/**
 * Headline: hours/week spent re-answering. Each open contradiction or drift is
 * a question people keep asking; chat messages and tickets citing it are the
 * evidence of how often. Rate = chat refs / observed weeks, floored at the
 * assumed minimum; hours = Σ rate × minutes per re-answer. Shown with its
 * assumptions — it is an estimate, and the report says so.
 */
export function estimateHours(findings: readonly ServeFinding[], items: readonly ServeItem[], assumptions: ReportAssumptions = DEFAULT_ASSUMPTIONS): HoursEstimate {
  const byRef = new Map(items.map((i) => [refKey({ kind: i.source, ref: i.external_ref }), i] as const));
  const chatDates = items.filter(isChat).map((i) => Date.parse(i.modified_at)).filter((t) => Number.isFinite(t));
  const spanWeeks = chatDates.length > 1 ? (Math.max(...chatDates) - Math.min(...chatDates)) / (7 * 24 * 3600 * 1000) : 0;
  const observedWeeks = Math.max(assumptions.minObservedWeeks, spanWeeks);
  let reasks = 0;
  let n = 0;
  for (const f of findings) {
    if (f.kind !== 'contradiction' && f.kind !== 'drift') continue;
    n += 1;
    const chatRefs = new Set(f.refs.filter((r) => isChat(byRef.get(refKey(r)) ?? ({ source: 'gdrive', external_ref: '' } as ServeItem))).map(refKey)).size;
    reasks += Math.max(assumptions.minReasksPerWeek, chatRefs / observedWeeks);
  }
  return { hoursPerWeek: (reasks * assumptions.minutesPerReanswer) / 60, findings: n, reasksPerWeek: reasks, observedWeeks, assumptions };
}

// ---- rendering
const esc = (s: string): string => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c);

const KIND_LABEL: Record<SourceRef['kind'], string> = { gdrive: 'Doc', slack: 'Slack', zendesk: 'Zendesk', github: 'Repo', github_commit: 'Commit' };

function refLabel(ref: SourceRef, item: ServeItem | undefined): string {
  const title = item?.title ?? ref.ref;
  const date = item ? ` · ${item.modified_at.slice(0, 10)}` : '';
  const line = ref.line ? ` · line ${ref.line}` : '';
  return `${KIND_LABEL[ref.kind]}: ${title}${line}${date}`;
}

function renderRefs(refs: readonly SourceRef[], byRef: ReadonlyMap<string, ServeItem>, link: LinkResolver): string {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const r of refs) {
    const k = `${refKey(r)}|${r.line ?? ''}`;
    if (seen.has(k)) continue;
    seen.add(k);
    const item = byRef.get(refKey(r));
    const label = esc(refLabel(r, item));
    const href = link(r, item);
    out.push(`<li class="ref ref-${r.kind}">${href ? `<a href="${esc(href)}">${label}</a>` : label}</li>`);
  }
  return `<ul class="refs">${out.join('')}</ul>`;
}

function knowerNames(f: ServeFinding, people: ReadonlyMap<string, ReportPerson>): string[] {
  return (f.suggested_knowers ?? []).map((k) => {
    const p = people.get(k.toLowerCase());
    return p ? `${p.name}${p.title ? ` (${p.title})` : ''}` : k;
  });
}

const CSS = `
:root{--ink:#1a1a1a;--muted:#5f6368;--line:#e3e3e3;--accent:#0b57d0;--warn:#b3261e;--ok:#146c2e;--bg:#fff}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.5 -apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif}
main{max-width:920px;margin:0 auto;padding:32px 24px 64px}
h1{font-size:28px;margin:0 0 4px}h2{font-size:20px;margin:40px 0 12px;padding-bottom:6px;border-bottom:1px solid var(--line)}h3{font-size:16px;margin:20px 0 6px}
.sub{color:var(--muted);margin:0 0 24px}
.headline{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:12px;margin:24px 0}
.stat{border:1px solid var(--line);border-radius:8px;padding:14px 16px}.stat b{display:block;font-size:30px;line-height:1.1}.stat span{color:var(--muted);font-size:13px}
.stat.hero{border-color:var(--accent)}.stat.hero b{color:var(--accent)}
.finding{border:1px solid var(--line);border-left:4px solid var(--accent);border-radius:6px;padding:12px 16px;margin:10px 0}
.finding.drift{border-left-color:var(--warn)}.finding.gap{border-left-color:#8a8a8a}
.finding p{margin:0 0 8px}.refs{margin:6px 0 0;padding-left:18px;color:var(--muted);font-size:13px}.refs a{color:var(--accent);text-decoration:none}
.knowers{font-size:13px;color:var(--muted)}.note{font-size:13px;color:var(--muted)}
.method{background:#f6f8fa;border-radius:8px;padding:14px 16px;font-size:13px}
@media print{main{padding:0}.finding{break-inside:avoid}h2{break-after:avoid}}
`;

export interface ScanReport {
  readonly html: string;
  readonly stats: { readonly contradictions: number; readonly drifts: number; readonly gaps: number; readonly hidden: number; readonly hoursPerWeek: number };
}

export function renderScanReport(input: ScanReportInput): ScanReport {
  const assumptions = { ...DEFAULT_ASSUMPTIONS, ...(input.assumptions ?? {}) };
  const link: LinkResolver = input.link ?? (() => null);
  const byRef = new Map(input.items.map((i) => [refKey({ kind: i.source, ref: i.external_ref }), i] as const));
  const people = new Map((input.people ?? []).flatMap((p) => [[p.email.toLowerCase(), p] as const, [p.name.toLowerCase(), p] as const]));

  const visible = visibleFindings(input.findings, input.items, input.viewer.scopes);
  const hidden = input.findings.length - visible.length;
  const contradictions = visible.filter((f) => f.kind === 'contradiction');
  const drifts = visible.filter((f) => f.kind === 'drift');
  const gaps = visible.filter((f) => f.kind === 'low_confidence').sort((a, b) => (b.suggested_knowers?.length ?? 0) - (a.suggested_knowers?.length ?? 0) || (a.confidence ?? 1) - (b.confidence ?? 1));
  const hours = estimateHours(visible, input.items, assumptions);

  const card = (f: ServeFinding, cls: string): string => {
    const knowers = knowerNames(f, people);
    return `<article class="finding ${cls}"><p>${esc(f.summary)}</p>${renderRefs(f.refs, byRef, link)}${knowers.length ? `<div class="knowers">Who would know: ${esc(knowers.join(', '))}</div>` : ''}</article>`;
  };
  const section = (title: string, items: readonly ServeFinding[], cls: string, empty: string, intro?: string): string =>
    `<h2>${esc(title)} <span class="note">(${items.length})</span></h2>${intro ? `<p class="note">${intro}</p>` : ''}${items.length ? items.map((f) => card(f, cls)).join('') : `<p class="note">${esc(empty)}</p>`}`;

  const shownGaps = gaps.slice(0, assumptions.maxGapsShown);
  const gapsHtml =
    section('Unwritten knowledge', shownGaps, 'gap', 'No implied-knowledge gaps were found.', 'Things your sources rely on but never state. Each names the person most likely to know; one question to them turns it into a verified fact.') +
    (gaps.length > shownGaps.length ? `<p class="note">${gaps.length - shownGaps.length} more gaps are in the full export.</p>` : '');

  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(input.orgName)} — contradiction scan</title><style>${CSS}</style></head><body><main>
<h1>${esc(input.orgName)}: contradiction scan</h1>
<p class="sub">Generated ${esc(input.generatedAt.slice(0, 16).replace('T', ' '))} UTC for ${esc(input.viewer.email)}. Findings are limited to sources this viewer can already read.</p>
<div class="headline">
<div class="stat hero"><b>${hours.hoursPerWeek.toFixed(1)} h</b><span>per week estimated re-answering questions your sources disagree on</span></div>
<div class="stat"><b>${contradictions.length}</b><span>contradictions between sources</span></div>
<div class="stat"><b>${drifts.length}</b><span>places the docs no longer match the code</span></div>
<div class="stat"><b>${gaps.length}</b><span>unwritten rules surfaced, ${gaps.filter((g) => (g.suggested_knowers?.length ?? 0) > 0).length} with a named knower</span></div>
</div>
${section('Contradictions', contradictions, 'contradiction', 'No contradictions between sources this viewer can read.', 'Two sources of record give incompatible answers to the same question. The newer or more authoritative side is named where the sources show it; the older one is still in use.')}
${section('Docs vs code', drifts, 'drift', 'No code-vs-docs drift found.', 'The code is ground truth. Each entry links the stale document line, the code that contradicts it, and the commit that changed it.')}
${gapsHtml}
<h2>How the headline is estimated</h2>
<div class="method">Each open contradiction or drift is a question people keep re-asking. Chat messages and tickets that cite it are the evidence of how often: ${hours.findings} findings carry ${hours.reasksPerWeek.toFixed(1)} estimated re-asks per week over an observed window of ${hours.observedWeeks.toFixed(0)} weeks (floor ${assumptions.minReasksPerWeek} per finding per week), at ${assumptions.minutesPerReanswer} minutes per re-answer. This is an estimate for prioritisation, not a measurement.${hidden > 0 ? ' Findings citing sources outside this viewer&#39;s access are not included anywhere in this report.' : ''}</div>
</main></body></html>`;

  return { html, stats: { contradictions: contradictions.length, drifts: drifts.length, gaps: gaps.length, hidden, hoursPerWeek: hours.hoursPerWeek } };
}
