// Stage 4: judge (implementation-plan §7.2, Week 3). Frontier review of every
// drafted artifact against the exact source excerpts its claims cite:
// approve | edit(drop, demote, corrected body) | escalate(reason, gap kind).
// The per-call edit rate is logged to model_calls.edit_rate_signal — the
// down-tiering signal for the stages before it. Escalations and uncertain
// claims become findings (gaps), never deletions.
import { BudgetExceededError, complete as gatewayComplete, type CompleteFn } from '@tacit/gateway';
import { loadPrompt } from '@tacit/prompts';
import { z } from 'zod';
import { wasCached } from '../cache';
import type { EvalArtifact, EvalClaim, EvalSyncItem, Finding, SourceRef, StageContext, StageResult, StageRunner } from '../contract';
import { drain, parseWithSalvage } from '../json';

export interface JudgeDeps {
  readonly complete?: CompleteFn;
  readonly maxBatch?: number;
  readonly contextLines?: number;
  readonly maxTokens?: number;
  readonly concurrency?: number;
  readonly log?: (line: Record<string, unknown>) => void;
}

const Review = z.object({
  id: z.string(),
  decision: z.enum(['approve', 'edit', 'escalate']),
  edits: z.array(z.string()).default([]),
  drop: z.array(z.string()).default([]),
  demote: z.array(z.string()).default([]),
  body_md: z.string().max(8000).optional(),
  title: z.string().max(200).optional(),
  note: z.string().max(300).optional(),
  gap: z.enum(['contradiction', 'low_confidence']).optional(),
  reason: z.string().max(400).optional(),
});
const Output = z.object({ reviews: z.array(Review) });

const EMAIL = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g;

/** Who is behind an item: emails in its title/head, plus a doc's `_Owner: Name`. Knower hints for gaps. */
export function itemAuthors(item: EvalSyncItem): string[] {
  const head = `${item.title}\n${item.content.slice(0, 400)}`;
  const out = new Set<string>();
  for (const m of head.matchAll(EMAIL)) out.add(m[0].toLowerCase());
  const owner = /_Owner:\s*([^·\n_]+)/.exec(item.content.slice(0, 300));
  if (owner?.[1]) out.add(owner[1].trim());
  return [...out];
}

export function sourceExcerpt(item: EvalSyncItem, ref: SourceRef, contextLines: number): string {
  if (ref.line === undefined) return item.content.slice(0, 700);
  const lines = item.content.split('\n');
  const start = Math.max(0, ref.line - 1 - contextLines);
  const end = Math.min(lines.length, ref.line + contextLines);
  return lines
    .slice(start, end)
    .map((l, i) => `${start + i + 1}: ${l}`)
    .join('\n');
}

const refKey = (r: SourceRef): string => `${r.kind}|${r.ref}`;

export interface JudgeStats {
  approve: number;
  edit: number;
  escalate: number;
  dropped_claims: number;
  demoted_claims: number;
  unreviewed: number;
}

export function createJudgeStage(deps: JudgeDeps = {}): StageRunner {
  const complete = deps.complete ?? gatewayComplete;
  const log = deps.log ?? (() => undefined);

  return async (ctx: StageContext): Promise<StageResult> => {
    const prompt = loadPrompt('judge');
    const maxBatch = deps.maxBatch ?? Number(prompt.params.max_batch ?? 5);
    const contextLines = deps.contextLines ?? Number(prompt.params.context_lines ?? 5);
    const maxTokens = deps.maxTokens ?? Number(prompt.params.max_tokens ?? 6000);
    const usage = { cost_usd: 0, model_calls: 0, in_tokens: 0, out_tokens: 0, cached_calls: 0 };
    const stats: JudgeStats = { approve: 0, edit: 0, escalate: 0, dropped_claims: 0, demoted_claims: 0, unreviewed: 0 };
    const notes: string[] = [];
    const itemsByRef = new Map(ctx.items.map((i) => [refKey({ kind: i.source, ref: i.external_ref }), i] as const));
    const judged = new Map<string, EvalArtifact>();
    const findings: Finding[] = [];
    let budgetHit = false;
    let truncated = 0;
    let retries = 0;
    let parseFailures = 0;
    const editKinds = new Map<string, number>();

    const knowersFor = (claims: readonly EvalClaim[]): string[] => {
      const out = new Set<string>();
      for (const c of claims) for (const r of c.provenance) {
        const item = itemsByRef.get(refKey(r));
        if (item) for (const a of itemAuthors(item)) out.add(a);
      }
      return [...out];
    };

    const queue: EvalArtifact[][] = [];
    for (let i = 0; i < ctx.artifacts.length; i += maxBatch) queue.push(ctx.artifacts.slice(i, i + maxBatch));
    const initialBatches = queue.length;

    await drain(queue, deps.concurrency ?? 4, async (batch) => {
      if (budgetHit) return;
      const packs = batch.map((artifact, ai) => {
        const ids = new Map<string, number>();
        const claims = artifact.claims.map((c, ci) => {
          ids.set(`c${ci + 1}`, ci);
          const excerpts = [...new Set(c.provenance.map((r) => {
            const item = itemsByRef.get(refKey(r));
            return item ? `(${r.kind} ${r.ref}${r.line ? `:${r.line}` : ''}) ${sourceExcerpt(item, r, contextLines)}` : `(${r.kind} ${r.ref}) [source not available]`;
          }))];
          return { id: `c${ci + 1}`, text: c.text, confidence: c.confidence, excerpts };
        });
        // Body cites the draft's short ids (c1..) which are positional in artifact.claims — same order here.
        return { id: `a${ai + 1}`, artifact, ids, payload: { id: `a${ai + 1}`, type: artifact.type, title: artifact.title, body_md: artifact.body_md, claims } };
      });
      let text: string;
      const signal: string[] = [];
      try {
        const completion = await complete(
          'judge',
          [
            { role: 'system', content: prompt.text },
            { role: 'user', content: `Artifacts:\n${JSON.stringify(packs.map((p) => p.payload))}` },
          ],
          { json: true, maxTokens, runId: ctx.run_id, orgId: ctx.org_id, budgetUsd: ctx.budget_usd, editRateSignal: 'pending' },
        );
        usage.cost_usd += completion.cost_usd;
        usage.model_calls += 1;
        if (wasCached(completion)) usage.cached_calls += 1;
        usage.in_tokens += completion.usage.in_tokens + completion.usage.cache_read_tokens + completion.usage.cache_write_tokens;
        usage.out_tokens += completion.usage.out_tokens;
        text = completion.text;
      } catch (err) {
        if (err instanceof BudgetExceededError) {
          budgetHit = true;
          return;
        }
        throw err;
      }
      const { parsed, salvaged } = parseWithSalvage(text, Output, [']}']);
      if (salvaged) truncated += 1;
      if (!parsed) parseFailures += 1;
      const done = new Set<string>();
      for (const r of parsed?.reviews ?? []) {
        const p = packs.find((x) => x.id === r.id);
        if (!p || done.has(p.id)) continue;
        done.add(p.id);
        signal.push(r.decision);
        const a = p.artifact;
        const dropIdx = new Set(r.drop.map((cid) => p.ids.get(cid)).filter((x): x is number => x !== undefined));
        const demoteIdx = new Set(r.demote.map((cid) => p.ids.get(cid)).filter((x): x is number => x !== undefined));
        const claims: EvalClaim[] = a.claims
          .map((c, i) => (demoteIdx.has(i) ? { ...c, confidence: Math.min(c.confidence, 0.5) } : c))
          .filter((_, i) => !dropIdx.has(i));
        stats.dropped_claims += dropIdx.size;
        stats.demoted_claims += demoteIdx.size;
        for (const k of r.edits) editKinds.set(k, (editKinds.get(k) ?? 0) + 1);
        const escalated = r.decision === 'escalate';
        stats[r.decision] += 1;
        const meta = {
          ...(a.meta ?? {}),
          judge: { decision: r.decision, edits: r.edits, note: r.note ?? null, reason: r.reason ?? null, gap: r.gap ?? null, dropped: dropIdx.size, demoted: demoteIdx.size },
        };
        judged.set(a.id, {
          ...a,
          title: r.title?.trim() || a.title,
          body_md: r.body_md?.trim() || a.body_md,
          claims,
          verification_state: escalated ? 'unverified' : 'machine_consistent',
          meta,
        });
        if (escalated) {
          findings.push({
            kind: r.gap ?? 'low_confidence',
            refs: claims.flatMap((c) => c.provenance),
            summary: `Escalated: ${a.title} — ${r.reason ?? 'needs human review'}`,
            suggested_knowers: knowersFor(claims),
            confidence: 0.3,
          });
        }
        // Every uncertain claim (drafted as uncertain, or demoted here) is a gap with a suggested knower.
        for (const c of claims) {
          if (c.confidence > 0.5) continue;
          findings.push({ kind: 'low_confidence', refs: c.provenance, summary: `Unverified: ${c.text}`, suggested_knowers: knowersFor([c]), confidence: c.confidence });
        }
      }
      const missing = batch.filter((a) => !done.has(packs.find((p) => p.artifact === a)?.id ?? ''));
      if (missing.length > 0 && (salvaged || !parsed)) {
        if (batch.length === 1) {
          stats.unreviewed += 1;
          return;
        }
        const mid = Math.ceil(missing.length / 2);
        queue.push(missing.slice(0, mid));
        if (mid < missing.length) queue.push(missing.slice(mid));
        retries += 1;
      }
      log({ event: 'judge_batch', run_id: ctx.run_id, org_id: ctx.org_id, decisions: signal.join(',') });
    });

    // Artifacts the judge never reached stay as drafted (unverified).
    const artifacts = ctx.artifacts.map((a) => judged.get(a.id) ?? a);
    stats.unreviewed = ctx.artifacts.length - judged.size;
    const reviewed = stats.approve + stats.edit + stats.escalate;
    const editRate = reviewed === 0 ? null : (stats.edit + stats.escalate) / reviewed;
    if (budgetHit) notes.push('judge: budget reached; remaining artifacts left unverified');
    if (truncated > 0) notes.push(`judge: ${truncated} response(s) were cut off; ${retries} split batch(es) retried`);
    if (parseFailures > 0) notes.push(`judge: ${parseFailures} response(s) had no parseable JSON`);
    if (stats.unreviewed > 0) notes.push(`judge: ${stats.unreviewed} artifact(s) not reviewed (left unverified)`);
    if (editRate !== null) notes.push(`judge: edit rate ${(editRate * 100).toFixed(1)}% (${stats.approve} approve, ${stats.edit} edit, ${stats.escalate} escalate; ${stats.dropped_claims} claims dropped, ${stats.demoted_claims} demoted)`);
    if (editKinds.size > 0) notes.push(`judge: edit kinds ${[...editKinds.entries()].sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k}=${n}`).join(', ')}`);
    log({ event: 'stage', stage: 'judge', run_id: ctx.run_id, org_id: ctx.org_id, artifacts: ctx.artifacts.length, batches: initialBatches, retries, ...stats, edit_rate: editRate, ...usage });

    return {
      artifacts,
      replace_artifacts: true,
      findings,
      usage,
      stats: { ...stats, ...(editRate === null ? {} : { edit_rate: editRate }) },
      ...(notes.length ? { notes } : {}),
    };
  };
}
