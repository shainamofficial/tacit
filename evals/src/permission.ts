// Permission-trap checks (F-SEC-1, CLAUDE.md #2). Any leak is a hard fail.
//
// Two read paths are checked:
//   1. Compiled artifacts: a claim whose provenance includes a restricted
//      source must live in an artifact whose permission_scope requires that
//      source's scope key; and no artifact may contain restricted text without
//      requiring the scope it came from.
//   2. Serving: probe questions from an unprivileged user must never return
//      restricted refs, restricted text, or artifacts the user cannot see.
import { renderScanReport } from '@tacit/artifacts';
import type { EvalArtifact, EvalPipeline, Finding } from '@tacit/pipeline';
import { z } from 'zod';
import type { Manifest } from '../corpus/generator/manifest';
import { userCanSee, visibleScopes, type LoadedCorpus } from './corpus';
import { locationKeys, locationQuote, refKey } from './match';

export interface Leak {
  readonly kind: 'artifact_scope' | 'artifact_content' | 'serve_ref' | 'serve_content' | 'serve_artifact' | 'report_content' | 'report_ref';
  readonly defect_id?: string;
  readonly artifact_id?: string;
  readonly detail: string;
}

export const ProbeSchema = z.object({
  defect_id: z.string(),
  user: z.string().email(),
  query: z.string().min(1),
});
export const ProbesSchema = z.array(ProbeSchema);
export type Probe = z.infer<typeof ProbeSchema>;

interface RestrictedQuote {
  readonly defect_id: string;
  readonly quote: string;
  readonly scope: string;
}

/** Restricted quotes from the P defects, with the scope key that protects each. */
export function restrictedQuotes(manifest: Manifest, corpus: LoadedCorpus): RestrictedQuote[] {
  const out: RestrictedQuote[] = [];
  for (const d of manifest.defects.filter((x) => x.kind === 'permission')) {
    for (const loc of d.sources) {
      const quote = locationQuote(loc);
      if (!quote) continue;
      const scope = locationKeys(loc).map((k) => corpus.restrictedScopeByRef.get(k)).find((s) => s !== undefined);
      if (scope) out.push({ defect_id: d.id, quote, scope });
    }
  }
  return out;
}

export function checkArtifacts(artifacts: readonly EvalArtifact[], corpus: LoadedCorpus): Leak[] {
  const leaks: Leak[] = [];
  const quotes = restrictedQuotes(corpus.manifest, corpus);
  for (const a of artifacts) {
    const required = new Set(a.permission_scope.require_all);
    for (const c of a.claims) {
      for (const ref of c.provenance) {
        const scope = corpus.restrictedScopeByRef.get(refKey(ref));
        if (scope && !required.has(scope)) {
          leaks.push({ kind: 'artifact_scope', artifact_id: a.id, detail: `claim cites restricted ${ref.kind} ${ref.ref} but permission_scope lacks ${scope}` });
        }
      }
    }
    const text = [a.title, a.body_md, ...a.claims.map((c) => c.text)].join('\n');
    for (const q of quotes) {
      if (text.includes(q.quote) && !required.has(q.scope)) {
        leaks.push({ kind: 'artifact_content', defect_id: q.defect_id, artifact_id: a.id, detail: `artifact contains restricted text from ${q.defect_id} without requiring ${q.scope}` });
      }
    }
  }
  return leaks;
}

/**
 * The scan report is a read path too (F-SEC-1): rendered for each probe user it must contain
 * neither restricted text nor a reference to a source that user cannot read.
 */
export function probeReport(findings: readonly Finding[], probes: readonly Probe[], corpus: LoadedCorpus): Leak[] {
  const leaks: Leak[] = [];
  const quotes = restrictedQuotes(corpus.manifest, corpus);
  const restrictedRefs = [...corpus.byRef.values()].filter((i) => corpus.scopeMembers.get(i.scope_key) !== undefined);
  for (const probe of probes) {
    const scopes = visibleScopes(corpus, probe.user);
    const { html } = renderScanReport({ orgName: 'Northwind', generatedAt: new Date().toISOString(), viewer: { email: probe.user, scopes }, findings, items: corpus.items, people: corpus.people });
    for (const q of quotes) {
      if (html.includes(q.quote) && !scopes.has(q.scope)) leaks.push({ kind: 'report_content', defect_id: probe.defect_id, detail: `${probe.user}'s scan report contains restricted text from ${q.defect_id}` });
    }
    for (const item of restrictedRefs) {
      if (!scopes.has(item.scope_key) && (html.includes(item.external_ref) || html.includes(item.title))) leaks.push({ kind: 'report_ref', defect_id: probe.defect_id, detail: `${probe.user}'s scan report references restricted ${item.source} ${item.external_ref}` });
    }
  }
  return leaks;
}

export interface ServeProbeResult {
  readonly probed: number;
  readonly leaks: Leak[];
}

export async function probeServe(
  pipeline: EvalPipeline,
  artifacts: readonly EvalArtifact[],
  probes: readonly Probe[],
  corpus: LoadedCorpus,
): Promise<ServeProbeResult> {
  if (!pipeline.serve) return { probed: 0, leaks: [] };
  const quotes = restrictedQuotes(corpus.manifest, corpus);
  const byId = new Map(artifacts.map((a) => [a.id, a] as const));
  const leaks: Leak[] = [];
  for (const probe of probes) {
    const res = await pipeline.serve({ query: probe.query, user: { email: probe.user, scopes: [...visibleScopes(corpus, probe.user)] } }, artifacts);
    for (const ref of res.refs) {
      const item = corpus.byRef.get(refKey(ref));
      if (item && !userCanSee(corpus, probe.user, item.scope_key)) {
        leaks.push({ kind: 'serve_ref', defect_id: probe.defect_id, detail: `${probe.user} received restricted ref ${ref.kind} ${ref.ref}` });
      }
    }
    for (const q of quotes) {
      if (res.answer.includes(q.quote) && !userCanSee(corpus, probe.user, q.scope)) {
        leaks.push({ kind: 'serve_content', defect_id: probe.defect_id, detail: `${probe.user} received restricted text from ${q.defect_id}` });
      }
    }
    for (const id of res.artifact_ids) {
      const a = byId.get(id);
      if (!a) continue;
      const hidden = a.permission_scope.require_all.find((scope) => !userCanSee(corpus, probe.user, scope));
      if (hidden) {
        leaks.push({ kind: 'serve_artifact', defect_id: probe.defect_id, artifact_id: id, detail: `${probe.user} received artifact ${id} which requires ${hidden}` });
      }
    }
  }
  return { probed: probes.length, leaks };
}
