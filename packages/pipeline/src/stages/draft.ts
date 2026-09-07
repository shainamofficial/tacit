// Stage 3: draft (implementation-plan §7.2). Claims → artifacts.
//
// 1. Cluster: the model maps extracted subjects onto topics (entity linking).
// 2. Group: claims by topic, exact-duplicate texts merged with their
//    provenance unioned, then split into permission variants: one public
//    artifact from domain-wide sources, plus one variant per restricted
//    scope that adds that scope's claims. An artifact's permission_scope is
//    the set of scope keys of every claim it cites (F-SEC-1: ACL intersection
//    — a reader must hold all of them), so a restricted fact can never ride
//    along in a public card.
// 3. Draft: the model writes title/body per group citing claim ids; only
//    claims it cites become the artifact's claims. Truncated output is
//    salvaged and the lost groups retried in halves.
import { createHash } from 'node:crypto';
import { BudgetExceededError, complete as gatewayComplete, type CompleteFn, type Completion } from '@tacit/gateway';
import { loadPrompt } from '@tacit/prompts';
import { z } from 'zod';
import { wasCached } from '../cache';
import type { EvalArtifact, EvalClaim, ExtractedClaim, SourceRef, StageContext, StageResult, StageRunner } from '../contract';
import { drain, parseWithSalvage } from '../json';

export interface DraftDeps {
  readonly complete?: CompleteFn;
  readonly maxSubjects?: number;
  readonly maxBatchChars?: number;
  readonly maxGroups?: number;
  readonly maxTokens?: number;
  readonly concurrency?: number;
  readonly log?: (line: Record<string, unknown>) => void;
}

const ARTIFACT_TYPES = ['qa_fact', 'entity_card', 'decision_record', 'process_doc', 'service_card', 'api_surface', 'glossary_entry'] as const;

const ClusterOut = z.object({
  topics: z.array(z.object({ topic: z.string().min(1).max(120), subjects: z.array(z.string()) })),
});

const DraftOut = z.object({
  artifacts: z.array(
    z.object({
      group: z.string(),
      type: z.string().default('qa_fact'),
      title: z.string().min(1).max(200),
      body_md: z.string().min(1).max(8000),
      used: z.array(z.string()).default([]),
      conflicts: z.array(z.array(z.string())).default([]),
      uncertain: z.array(z.string()).default([]),
      dropped: z.array(z.object({ id: z.string(), reason: z.string().max(300).default('') })).default([]),
    }),
  ),
});

export function normalizeSubject(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9&/ .-]+/g, ' ').replace(/\s+/g, ' ').trim();
}

/** Claims with identical text inside one topic are one claim with unioned provenance. */
export interface MergedClaim {
  readonly key: string;
  readonly text: string;
  readonly kind: ExtractedClaim['kind'];
  readonly subject: string;
  readonly confidence: number;
  readonly provenance: readonly SourceRef[];
  readonly scope_keys: readonly string[];
  readonly restricted: boolean;
  readonly source: string;
  readonly date: string;
  readonly quote: string | undefined;
  readonly members: readonly ExtractedClaim[];
}

export function mergeClaims(claims: readonly ExtractedClaim[]): MergedClaim[] {
  const byText = new Map<string, ExtractedClaim[]>();
  for (const c of claims) {
    const k = c.text.toLowerCase().replace(/\s+/g, ' ').trim();
    const list = byText.get(k) ?? [];
    list.push(c);
    byText.set(k, list);
  }
  return [...byText.values()].map((members) => {
    const first = members[0] as ExtractedClaim;
    const refs = new Map<string, SourceRef>();
    for (const m of members) for (const r of m.provenance) refs.set(`${r.kind}|${r.ref}|${r.line ?? ''}`, r);
    const newest = members.reduce((a, b) => (a.modified_at >= b.modified_at ? a : b));
    return {
      key: first.id,
      text: first.text,
      kind: first.kind,
      subject: first.subject,
      confidence: Math.max(...members.map((m) => m.confidence)),
      provenance: [...refs.values()],
      scope_keys: [...new Set(members.map((m) => m.scope_key))].sort(),
      restricted: members.some((m) => m.acl.kind === 'users'),
      source: first.source,
      date: newest.modified_at.slice(0, 10),
      quote: first.quote,
      members,
    };
  });
}

export interface Variant {
  readonly id: string;
  readonly topic: string;
  /** 'public' or the restricted scope key this variant is allowed to include */
  readonly scope: string;
  readonly claims: readonly MergedClaim[];
}

/** Split a topic's claims into a public variant and one variant per restricted scope (F-SEC-1). */
export function variantsFor(topic: string, claims: readonly MergedClaim[]): Variant[] {
  const publicClaims = claims.filter((c) => !c.restricted);
  const restricted = new Map<string, MergedClaim[]>();
  for (const c of claims.filter((c) => c.restricted)) {
    for (const scope of c.scope_keys) {
      const list = restricted.get(scope) ?? [];
      list.push(c);
      restricted.set(scope, list);
    }
  }
  const out: Variant[] = [];
  if (publicClaims.length > 0) out.push({ id: `${topic}::public`, topic, scope: 'public', claims: publicClaims });
  for (const [scope, list] of [...restricted.entries()].sort()) {
    out.push({ id: `${topic}::${scope}`, topic, scope, claims: [...list, ...publicClaims] });
  }
  return out;
}

function artifactId(variantId: string): string {
  return `art_${createHash('sha256').update(variantId).digest('hex').slice(0, 12)}`;
}

function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

export function createDraftStage(deps: DraftDeps = {}): StageRunner {
  const complete = deps.complete ?? gatewayComplete;
  const log = deps.log ?? (() => undefined);

  return async (ctx: StageContext): Promise<StageResult> => {
    const clusterPrompt = loadPrompt('cluster');
    const draftPrompt = loadPrompt('draft');
    const maxSubjects = deps.maxSubjects ?? Number(clusterPrompt.params.max_subjects ?? 150);
    const maxBatchChars = deps.maxBatchChars ?? Number(draftPrompt.params.max_batch_chars ?? 7000);
    const maxGroups = deps.maxGroups ?? Number(draftPrompt.params.max_groups ?? 6);
    const maxTokens = deps.maxTokens ?? Number(draftPrompt.params.max_tokens ?? 12000);
    const usage = { cost_usd: 0, model_calls: 0, in_tokens: 0, out_tokens: 0, cached_calls: 0 };
    const notes: string[] = [];
    let budgetHit = false;

    const account = (c: Completion): void => {
      usage.cost_usd += c.cost_usd;
      usage.model_calls += 1;
      if (wasCached(c)) usage.cached_calls += 1;
      usage.in_tokens += c.usage.in_tokens + c.usage.cache_read_tokens + c.usage.cache_write_tokens;
      usage.out_tokens += c.usage.out_tokens;
    };
    const call = async (system: string, user: string): Promise<string | null> => {
      try {
        const c = await complete('draft', [{ role: 'system', content: system }, { role: 'user', content: user }], { json: true, maxTokens, runId: ctx.run_id, orgId: ctx.org_id, budgetUsd: ctx.budget_usd });
        account(c);
        return c.text;
      } catch (err) {
        if (err instanceof BudgetExceededError) {
          budgetHit = true;
          return null;
        }
        throw err;
      }
    };

    // --- 1. cluster subjects into topics
    const subjects = [...new Set(ctx.claims.map((c) => normalizeSubject(c.subject)).filter(Boolean))].sort();
    const topicOf = new Map<string, string>();
    let clusterFailures = 0;
    await drain(chunk(subjects, maxSubjects), deps.concurrency ?? 4, async (batch) => {
      if (budgetHit) return;
      const text = await call(clusterPrompt.text, `Subjects:\n${JSON.stringify(batch)}`);
      if (text === null) return;
      const { parsed } = parseWithSalvage(text, ClusterOut, [']}']);
      if (!parsed) {
        clusterFailures += 1;
        return;
      }
      const allowed = new Set(batch);
      for (const t of parsed.topics) {
        const topic = normalizeSubject(t.topic) || 'misc';
        for (const s of t.subjects) if (allowed.has(s) && !topicOf.has(s)) topicOf.set(s, topic);
      }
    });
    for (const s of subjects) if (!topicOf.has(s)) topicOf.set(s, s);

    // --- 2. group into permission variants
    const byTopic = new Map<string, ExtractedClaim[]>();
    for (const c of ctx.claims) {
      const topic = topicOf.get(normalizeSubject(c.subject)) ?? normalizeSubject(c.subject) ?? 'misc';
      const list = byTopic.get(topic) ?? [];
      list.push(c);
      byTopic.set(topic, list);
    }
    const variants: Variant[] = [];
    for (const [topic, claims] of [...byTopic.entries()].sort()) variants.push(...variantsFor(topic, mergeClaims(claims)));

    // --- 3. draft each variant
    const artifacts = new Map<string, EvalArtifact>();
    const sizeOf = (v: Variant): number => v.claims.reduce((n, c) => n + c.text.length + (c.quote?.length ?? 0) + 40, 0);
    const queue: Variant[][] = [];
    let current: Variant[] = [];
    let chars = 0;
    for (const v of variants) {
      const size = sizeOf(v);
      if (current.length > 0 && (chars + size > maxBatchChars || current.length >= maxGroups)) {
        queue.push(current);
        current = [];
        chars = 0;
      }
      current.push(v);
      chars += size;
    }
    if (current.length > 0) queue.push(current);
    const initialBatches = queue.length;
    let truncated = 0;
    let retries = 0;
    let unrecoverable = 0;
    let parseFailures = 0;
    let unusedClaims = 0;

    await drain(queue, deps.concurrency ?? 4, async (batch) => {
      if (budgetHit) return;
      // Short ids keep output small; map back afterwards.
      const groups = batch.map((v, gi) => {
        const ids = new Map<string, MergedClaim>();
        return {
          id: `g${gi + 1}`,
          variant: v,
          ids,
          payload: {
            group: `g${gi + 1}`,
            topic: v.topic,
            claims: v.claims.map((c, ci) => {
              const cid = `c${ci + 1}`;
              ids.set(cid, c);
              return { id: cid, text: c.text, kind: c.kind, confidence: c.confidence, source: c.source, date: c.date, ...(c.quote ? { quote: c.quote.slice(0, 140) } : {}) };
            }),
          },
        };
      });
      const text = await call(draftPrompt.text, `Groups:\n${JSON.stringify(groups.map((g) => g.payload))}`);
      if (text === null) return;
      const { parsed, salvaged } = parseWithSalvage(text, DraftOut, [']}']);
      if (salvaged) truncated += 1;
      if (!parsed) parseFailures += 1;
      const done = new Set<string>();
      for (const a of parsed?.artifacts ?? []) {
        const g = groups.find((x) => x.id === a.group);
        if (!g || done.has(g.id)) continue;
        const used = a.used.map((cid) => g.ids.get(cid)).filter((c): c is MergedClaim => c !== undefined);
        if (used.length === 0) continue;
        done.add(g.id);
        unusedClaims += g.variant.claims.length - used.length;
        const claims: EvalClaim[] = used.map((c) => ({ text: c.text, provenance: c.provenance, confidence: c.confidence }));
        const type = (ARTIFACT_TYPES as readonly string[]).includes(a.type) ? a.type : 'qa_fact';
        const resolve = (cid: string): string | undefined => g.ids.get(cid)?.key;
        artifacts.set(g.variant.id, {
          id: artifactId(g.variant.id),
          type,
          title: a.title.trim(),
          body_md: a.body_md.trim(),
          claims,
          permission_scope: { require_all: [...new Set(used.flatMap((c) => c.scope_keys))].sort() },
          verification_state: 'unverified',
          meta: {
            topic: g.variant.topic,
            scope: g.variant.scope,
            claim_ids: used.map((c) => c.key),
            conflicts: a.conflicts.map((pair) => pair.map(resolve).filter((x): x is string => x !== undefined)).filter((p) => p.length === 2),
            uncertain: a.uncertain.map(resolve).filter((x): x is string => x !== undefined),
            dropped: a.dropped.map((d) => ({ id: resolve(d.id), reason: d.reason })).filter((d) => d.id !== undefined),
          },
        });
      }
      const missing = batch.filter((v) => !done.has(groups.find((g) => g.variant === v)?.id ?? ''));
      if (missing.length > 0 && (salvaged || !parsed)) {
        if (batch.length === 1) {
          unrecoverable += 1;
          return;
        }
        const mid = Math.ceil(missing.length / 2);
        queue.push(missing.slice(0, mid));
        if (mid < missing.length) queue.push(missing.slice(mid));
        retries += 1;
      }
    });

    const out = variants.map((v) => artifacts.get(v.id)).filter((a): a is EvalArtifact => a !== undefined);
    const undrafted = variants.length - out.length;
    if (budgetHit) notes.push('draft: budget reached; remaining groups were not drafted');
    if (clusterFailures > 0) notes.push(`draft: ${clusterFailures} cluster batch(es) unparseable; their subjects became their own topics`);
    if (truncated > 0) notes.push(`draft: ${truncated} response(s) were cut off; complete artifacts were salvaged and ${retries} split batch(es) retried`);
    if (unrecoverable > 0) notes.push(`draft: ${unrecoverable} single-group batch(es) still cut off`);
    if (parseFailures > 0) notes.push(`draft: ${parseFailures} response(s) had no parseable JSON`);
    if (undrafted > 0) notes.push(`draft: ${undrafted} of ${variants.length} groups produced no artifact`);
    if (unusedClaims > 0) notes.push(`draft: ${unusedClaims} merged claims were left out of their artifacts by the model`);
    log({ event: 'stage', stage: 'draft', run_id: ctx.run_id, org_id: ctx.org_id, claims: ctx.claims.length, subjects: subjects.length, topics: byTopic.size, variants: variants.length, batches: initialBatches, retries, artifacts: out.length, ...usage });

    return { artifacts: out, findings: [], usage, ...(notes.length ? { notes } : {}) };
  };
}
