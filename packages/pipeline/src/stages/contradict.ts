// Stage 5: contradict (PRD §7.2 step 5; F-GAP-1a, F-GAP-1b). Cross-source
// conflict finding in two tiers, as the PRD splits it:
//
// 1. Group the run's claims by the draft's topics (an artifact's meta.topic
//    and claim_ids map subject → topic); claims the judge dropped are out.
// 2. Discovery (frontier route `contradict`): per topic the model names sets
//    of claims that answer the same question differently, and the unwritten
//    rules the sources rely on, with the people most likely to know.
// 3. Verification (mid-tier route `contradict_verify`): every candidate —
//    from discovery, the draft's conflict pairs, and the judge's contradiction
//    escalations — is re-checked against the exact source excerpts. Only a
//    verified conflict becomes a contradiction finding; a doc-vs-code conflict
//    becomes a drift finding (code is ground truth); a judge escalation that
//    fails verification stays a low_confidence gap, never disappears.
//
// The stage is authoritative for contradiction findings: it replaces the
// judge's escalations with the verified set (StageResult.replace_finding_kinds).
import { BudgetExceededError, complete as gatewayComplete, type CompleteFn } from '@tacit/gateway';
import { loadPrompt } from '@tacit/prompts';
import { z } from 'zod';
import { wasCached } from '../cache';
import type { DirectoryPerson, EvalArtifact, EvalSyncItem, ExtractedClaim, Finding, SourceRef, StageContext, StageResult, StageRunner } from '../contract';
import { drain, parseWithSalvage } from '../json';
import { mergeClaims, normalizeSubject, type MergedClaim } from './draft';
import { itemAuthors, sourceExcerpt } from './judge';

export interface ContradictDeps {
  readonly complete?: CompleteFn;
  readonly maxBatchChars?: number;
  readonly maxClaimsPerTopic?: number;
  readonly maxTokens?: number;
  readonly verifyBatch?: number;
  readonly verifyContextLines?: number;
  readonly verifyMaxTokens?: number;
  readonly concurrency?: number;
  readonly log?: (line: Record<string, unknown>) => void;
}

const Conflict = z.object({
  claims: z.array(z.string()).min(2),
  question: z.string().max(200).default(''),
  summary: z.string().max(600).default(''),
  newer: z.string().nullable().optional(),
});
const Implied = z.object({
  claims: z.array(z.string()).min(1),
  rule: z.string().min(1).max(500),
  knowers: z.array(z.string()).default([]),
  why: z.string().max(300).default(''),
});
const DiscoveryOut = z.object({
  topics: z.array(z.object({ topic: z.string(), conflicts: z.array(Conflict).default([]), implied: z.array(Implied).default([]) })),
});
const VerifyOut = z.object({
  results: z.array(
    z.object({
      id: z.string(),
      verdict: z.enum(['contradiction', 'consistent', 'unrelated']),
      summary: z.string().max(600).default(''),
      newer: z.string().nullable().optional(),
    }),
  ),
});

/** Code side of a doc-vs-code pair: non-markdown repo files and commits. Everything else is prose. */
export function isCodeRef(ref: SourceRef): boolean {
  if (ref.kind === 'github_commit') return true;
  if (ref.kind === 'github') return !ref.ref.toLowerCase().endsWith('.md');
  return false;
}

/**
 * A source of record: a document, macro, repo file, or commit. Chat messages and
 * tickets are conversation — two of them disagreeing is a question for a human,
 * not a contradiction between the company's records.
 */
export function isRecordRef(ref: SourceRef): boolean {
  if (ref.kind === 'zendesk') return ref.ref.startsWith('macro:');
  return ref.kind !== 'slack';
}

const refKey = (r: SourceRef): string => `${r.kind}|${r.ref}|${r.line ?? ''}`;
const itemKey = (kind: string, ref: string): string => `${kind}|${ref}`;
const norm = (s: string): string => s.toLowerCase().replace(/\s+/g, ' ').trim();

function unionRefs(claims: readonly MergedClaim[]): SourceRef[] {
  const out = new Map<string, SourceRef>();
  for (const c of claims) for (const r of c.provenance) out.set(refKey(r), r);
  return [...out.values()];
}

export interface Topic {
  readonly name: string;
  readonly claims: readonly MergedClaim[];
  /** claims from at least two distinct items: a candidate for conflicts */
  readonly crossSource: boolean;
  /** carries a hint or an uncertain claim: a candidate for implied knowledge */
  readonly uncertain: boolean;
  /** only chat and tickets say it: a fact no document states, so a tribal-knowledge candidate */
  readonly conversational: boolean;
}

/**
 * Claims grouped by the draft's topics. Subjects the draft never clustered
 * (claims it dropped as noise, or from artifacts that never drafted) fall back
 * to their own subject. Claims the judge dropped as unsupported are excluded.
 */
export function groupByTopic(claims: readonly ExtractedClaim[], artifacts: readonly EvalArtifact[]): Topic[] {
  const byId = new Map(claims.map((c) => [c.id, c] as const));
  const topicOfSubject = new Map<string, string>();
  const surviving = new Set<string>();
  const cited = new Set<string>();
  for (const a of artifacts) {
    const meta = a.meta ?? {};
    const topic = typeof meta.topic === 'string' ? meta.topic : null;
    const ids = Array.isArray(meta.claim_ids) ? meta.claim_ids.filter((x): x is string => typeof x === 'string') : [];
    for (const c of a.claims) surviving.add(norm(c.text));
    for (const id of ids) {
      const c = byId.get(id);
      if (!c) continue;
      cited.add(norm(c.text));
      if (topic && !topicOfSubject.has(c.subject)) topicOfSubject.set(c.subject, topic);
    }
  }
  const dropped = new Set([...cited].filter((t) => !surviving.has(t)));
  const groups = new Map<string, ExtractedClaim[]>();
  for (const c of claims) {
    if (dropped.has(norm(c.text))) continue;
    const topic = topicOfSubject.get(c.subject) ?? normalizeSubject(c.subject);
    const list = groups.get(topic) ?? [];
    list.push(c);
    groups.set(topic, list);
  }
  return [...groups.entries()]
    .map(([name, cs]) => {
      const merged = mergeClaims(cs);
      const items = new Set(cs.map((c) => c.item_id));
      return {
        name,
        claims: merged,
        crossSource: items.size >= 2,
        uncertain: merged.some((m) => m.kind === 'hint' || m.confidence <= 0.5),
        conversational: cs.every((c) => c.source === 'slack' || (c.source === 'zendesk' && c.item_kind === 'ticket')),
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** Cap a topic's claims, keeping one per distinct item first so every source stays represented. */
export function capClaims(claims: readonly MergedClaim[], max: number): MergedClaim[] {
  if (claims.length <= max) return [...claims];
  const seen = new Set<string>();
  const first: MergedClaim[] = [];
  const rest: MergedClaim[] = [];
  for (const c of claims) {
    const item = c.members[0]?.item_id ?? '';
    if (seen.has(item)) rest.push(c);
    else {
      seen.add(item);
      first.push(c);
    }
  }
  return [...first, ...rest].slice(0, max);
}

const topicWords = (name: string): string[] => [...new Set(normalizeSubject(name).split(' ').filter((w) => w.length > 1))];

/**
 * The cluster step sometimes names one topic twice ("first response time" and
 * "support first response time"). Fold a topic into the smallest other topic
 * whose name contains every word of its own, so both sides of a conflict share
 * a topic and discovery sees them together.
 */
export function mergeSubsetTopics(topics: readonly Topic[]): Topic[] {
  const words = new Map(topics.map((t) => [t.name, topicWords(t.name)] as const));
  const wordsOf = (name: string): string[] => words.get(name) ?? [];
  const target = new Map<string, string>();
  for (const t of topics) {
    const w = wordsOf(t.name);
    if (w.length < 2) continue;
    const best = topics
      .filter((o) => o !== t && wordsOf(o.name).length > w.length && w.every((x) => wordsOf(o.name).includes(x)))
      .sort((a, b) => wordsOf(a.name).length - wordsOf(b.name).length || a.name.localeCompare(b.name))[0];
    if (best) target.set(t.name, best.name);
  }
  const root = (name: string): string => {
    let n = name;
    while (target.has(n)) n = target.get(n) as string; // strictly longer names each hop: no cycles
    return n;
  };
  const groups = new Map<string, Topic[]>();
  for (const t of topics) {
    const r = root(t.name);
    const list = groups.get(r) ?? [];
    list.push(t);
    groups.set(r, list);
  }
  return [...groups.entries()]
    .map(([name, members]) => {
      const only = members[0];
      if (members.length === 1 && only) return only;
      const claims = mergeClaims(members.flatMap((m) => m.claims.flatMap((c) => c.members)));
      const items = new Set(claims.flatMap((c) => c.members.map((m) => m.item_id)));
      return { name, claims, crossSource: items.size >= 2, uncertain: members.some((m) => m.uncertain), conversational: members.every((m) => m.conversational) };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** Order topics so names sharing their rarest common word sit together: related topics land in one discovery batch. */
export function orderForDiscovery(topics: readonly Topic[]): Topic[] {
  const df = new Map<string, number>();
  for (const t of topics) for (const w of topicWords(t.name)) df.set(w, (df.get(w) ?? 0) + 1);
  const key = (t: Topic): string | null => {
    const shared = topicWords(t.name)
      .filter((w) => (df.get(w) ?? 0) >= 2)
      .sort((a, b) => (df.get(a) ?? 0) - (df.get(b) ?? 0) || a.localeCompare(b));
    return shared[0] ?? null;
  };
  // Topics sharing a word first (grouped by it), then the loners by name.
  return [...topics].sort((a, b) => {
    const ka = key(a);
    const kb = key(b);
    if (ka === null && kb !== null) return 1;
    if (ka !== null && kb === null) return -1;
    return (ka ?? '').localeCompare(kb ?? '') || a.name.localeCompare(b.name);
  });
}

/** Map a model-suggested knower (name, email, handle, first name) onto the directory; unknown strings pass through. */
export function resolveKnower(raw: string, people: readonly DirectoryPerson[]): string {
  const needle = raw.trim().toLowerCase().replace(/^@/, '');
  if (!needle) return '';
  const exact = people.find((p) => p.email.toLowerCase() === needle || p.name.toLowerCase() === needle || (p.handle ?? '').toLowerCase() === needle);
  if (exact) return exact.email;
  const byFirst = people.filter((p) => p.name.toLowerCase().split(' ')[0] === needle);
  if (byFirst.length === 1) return byFirst[0]?.email ?? raw.trim();
  const contains = people.filter((p) => needle.includes(p.name.toLowerCase()) || needle.includes(p.email.toLowerCase()));
  if (contains.length === 1) return contains[0]?.email ?? raw.trim();
  return raw.trim();
}

interface Candidate {
  readonly key: string;
  readonly question: string;
  readonly sides: readonly MergedClaim[];
  readonly origins: Set<'discovery' | 'draft' | 'judge'>;
  hint: string;
}

export interface ContradictStats {
  topics: number;
  merged_topics: number;
  eligible_topics: number;
  discovery_calls: number;
  verify_calls: number;
  candidates: number;
  from_discovery: number;
  from_draft: number;
  from_judge: number;
  verified: number;
  rejected: number;
  unverified: number;
  contradictions: number;
  drifts: number;
  chat_only: number;
  code_history: number;
  merged_findings: number;
  implied: number;
  escalations_kept: number;
}

export function createContradictStage(deps: ContradictDeps = {}): StageRunner {
  const complete = deps.complete ?? gatewayComplete;
  const log = deps.log ?? (() => undefined);

  return async (ctx: StageContext): Promise<StageResult> => {
    const discoveryPrompt = loadPrompt('contradict');
    const verifyPrompt = loadPrompt('verify');
    const maxBatchChars = deps.maxBatchChars ?? Number(discoveryPrompt.params.max_batch_chars ?? 6000);
    const maxClaimsPerTopic = deps.maxClaimsPerTopic ?? Number(discoveryPrompt.params.max_claims_per_topic ?? 30);
    const maxTokens = deps.maxTokens ?? Number(discoveryPrompt.params.max_tokens ?? 8192);
    const verifyBatch = deps.verifyBatch ?? Number(verifyPrompt.params.max_batch ?? 6);
    const verifyContextLines = deps.verifyContextLines ?? Number(verifyPrompt.params.context_lines ?? 4);
    const verifyMaxTokens = deps.verifyMaxTokens ?? Number(verifyPrompt.params.max_tokens ?? 3000);
    const concurrency = deps.concurrency ?? 4;
    const people = ctx.people ?? [];

    const usage = { cost_usd: 0, model_calls: 0, in_tokens: 0, out_tokens: 0, cached_calls: 0 };
    const stats: ContradictStats = {
      topics: 0, merged_topics: 0, eligible_topics: 0, discovery_calls: 0, verify_calls: 0, candidates: 0, from_discovery: 0, from_draft: 0, from_judge: 0,
      verified: 0, rejected: 0, unverified: 0, contradictions: 0, drifts: 0, chat_only: 0, code_history: 0, merged_findings: 0, implied: 0, escalations_kept: 0,
    };
    const notes: string[] = [];
    let budgetHit = false;
    let truncated = 0;
    let parseFailures = 0;
    let retries = 0;

    const itemsById = new Map(ctx.items.map((i) => [i.id, i] as const));
    const itemsByRef = new Map(ctx.items.map((i) => [itemKey(i.source, i.external_ref), i] as const));
    const authorsOf = (c: MergedClaim): string[] => [...new Set(c.members.flatMap((m) => (itemsById.get(m.item_id) ? itemAuthors(itemsById.get(m.item_id) as EvalSyncItem) : [])))];

    const call = async (stage: 'contradict' | 'contradict_verify', system: string, user: string, max: number): Promise<string | null> => {
      try {
        const completion = await complete(stage, [{ role: 'system', content: system }, { role: 'user', content: user }], {
          json: true,
          maxTokens: max,
          runId: ctx.run_id,
          orgId: ctx.org_id,
          budgetUsd: ctx.budget_usd,
        });
        usage.cost_usd += completion.cost_usd;
        usage.model_calls += 1;
        if (wasCached(completion)) usage.cached_calls += 1;
        usage.in_tokens += completion.usage.in_tokens + completion.usage.cache_read_tokens + completion.usage.cache_write_tokens;
        usage.out_tokens += completion.usage.out_tokens;
        return completion.text;
      } catch (err) {
        if (err instanceof BudgetExceededError) {
          budgetHit = true;
          return null;
        }
        throw err;
      }
    };

    // ---- 1. topics
    const rawTopics = groupByTopic(ctx.claims, ctx.artifacts);
    const topics = mergeSubsetTopics(rawTopics);
    stats.topics = topics.length;
    stats.merged_topics = rawTopics.length - topics.length;
    const mergedByMember = new Map<string, MergedClaim>();
    const mergedByText = new Map<string, MergedClaim>();
    for (const t of topics) for (const m of t.claims) {
      mergedByText.set(norm(m.text), m);
      for (const member of m.members) mergedByMember.set(member.id, m);
    }
    const eligible = orderForDiscovery(topics.filter((t) => t.crossSource || t.uncertain || t.conversational));
    stats.eligible_topics = eligible.length;

    const candidates = new Map<string, Candidate>();
    const addCandidate = (sides: readonly MergedClaim[], question: string, origin: 'discovery' | 'draft' | 'judge', hint: string): void => {
      const unique = [...new Map(sides.map((s) => [s.key, s])).values()];
      if (unique.length < 2) return;
      const key = unique.map((s) => s.key).sort().join('+');
      const existing = candidates.get(key);
      if (existing) {
        existing.origins.add(origin);
        if (!existing.hint && hint) existing.hint = hint;
      } else candidates.set(key, { key, question, sides: unique, origins: new Set([origin]), hint });
    };
    const implied: Finding[] = [];

    // ---- 2. discovery (frontier)
    const directory = people.length > 0 ? `Directory:\n${people.map((p) => `${p.name} — ${p.title ?? 'unknown title'} — ${p.email}`).join('\n')}\n\n` : '';
    const claimRecord = (c: MergedClaim, id: string): Record<string, unknown> => {
      const item = itemsById.get(c.members[0]?.item_id ?? '');
      const by = authorsOf(c);
      return { id, src: c.source, from: item?.title ?? c.provenance[0]?.ref ?? '', date: c.date, ...(by.length ? { by: by.join(', ') } : {}), kind: c.kind, text: c.text, ...(c.quote ? { quote: c.quote.slice(0, 300) } : {}), conf: c.confidence };
    };
    interface Pack {
      readonly topic: Topic;
      readonly claims: readonly MergedClaim[];
      readonly chars: number;
    }
    const packs: Pack[] = eligible.map((topic) => {
      const claims = capClaims(topic.claims, maxClaimsPerTopic);
      return { topic, claims, chars: JSON.stringify({ topic: topic.name, claims: claims.map((c) => claimRecord(c, 'k000')) }).length };
    });
    const discoveryQueue: Pack[][] = [];
    let current: Pack[] = [];
    let chars = 0;
    for (const p of packs) {
      if (current.length > 0 && chars + p.chars > maxBatchChars) {
        discoveryQueue.push(current);
        current = [];
        chars = 0;
      }
      current.push(p);
      chars += p.chars;
    }
    if (current.length > 0) discoveryQueue.push(current);
    const discoveryBatches = discoveryQueue.length;

    await drain(discoveryQueue, concurrency, async (batch) => {
      if (budgetHit) return;
      // Claim ids are unique across the batch so a conflict may pair claims from neighbouring topics.
      const ids = new Map<string, MergedClaim>();
      let n = 0;
      const payload = batch.map((p) => ({
        topic: p.topic.name,
        claims: p.claims.map((c) => {
          n += 1;
          const id = `k${n}`;
          ids.set(id, c);
          return claimRecord(c, id);
        }),
      }));
      const text = await call('contradict', discoveryPrompt.text, `${directory}Topics:\n${JSON.stringify(payload)}`, maxTokens);
      if (text === null) return;
      stats.discovery_calls += 1;
      const { parsed, salvaged } = parseWithSalvage(text, DiscoveryOut, [']}', ']}]}', ']}]}]}']);
      if (salvaged) truncated += 1;
      if (!parsed) parseFailures += 1;
      const done = new Set<string>();
      for (const t of parsed?.topics ?? []) {
        const pack = batch.find((p) => p.topic.name === t.topic) ?? batch.find((p) => norm(p.topic.name) === norm(t.topic));
        if (!pack || done.has(pack.topic.name)) continue;
        done.add(pack.topic.name);
        for (const c of t.conflicts) {
          const sides = c.claims.map((id) => ids.get(id)).filter((x): x is MergedClaim => x !== undefined);
          const newer = c.newer ? ids.get(c.newer) : undefined;
          addCandidate(sides, c.question || pack.topic.name, 'discovery', [c.summary, newer ? `newer: ${newer.text}` : ''].filter(Boolean).join(' '));
        }
        for (const im of t.implied) {
          const cited = im.claims.map((id) => ids.get(id)).filter((x): x is MergedClaim => x !== undefined);
          if (cited.length === 0) continue;
          const knowers = [...new Set(im.knowers.map((k) => resolveKnower(k, people)).filter(Boolean))];
          const fallback = knowers.length > 0 ? knowers : [...new Set(cited.flatMap(authorsOf))];
          implied.push({
            kind: 'low_confidence',
            refs: unionRefs(cited),
            summary: `Implied, unwritten: ${im.rule}${im.why ? ` (${im.why})` : ''}`,
            suggested_knowers: fallback,
            confidence: 0.3,
          });
        }
      }
      const missing = batch.filter((p) => !done.has(p.topic.name));
      if (missing.length > 0 && (salvaged || !parsed)) {
        if (batch.length === 1) return;
        const mid = Math.ceil(missing.length / 2);
        discoveryQueue.push(missing.slice(0, mid));
        if (mid < missing.length) discoveryQueue.push(missing.slice(mid));
        retries += 1;
      }
    });
    stats.from_discovery = candidates.size;

    // ---- candidates the earlier stages already flagged
    const escalated = new Set<string>();
    for (const a of ctx.artifacts) {
      const meta = a.meta ?? {};
      const judge = meta.judge as { gap?: unknown; decision?: unknown } | undefined;
      const isEscalation = judge?.decision === 'escalate' && judge.gap === 'contradiction';
      const pairs = Array.isArray(meta.conflicts) ? (meta.conflicts as unknown[]).filter((p): p is string[] => Array.isArray(p) && p.every((x) => typeof x === 'string')) : [];
      const topic = typeof meta.topic === 'string' ? meta.topic : a.title;
      for (const pair of pairs) {
        const sides = pair.map((id) => mergedByMember.get(id)).filter((x): x is MergedClaim => x !== undefined);
        addCandidate(sides, topic, isEscalation ? 'judge' : 'draft', '');
      }
      if (isEscalation) {
        escalated.add(a.id);
        if (pairs.length === 0) {
          // No pair named: verify the artifact's own claims against each other (capped).
          const sides = a.claims.map((c) => mergedByText.get(norm(c.text))).filter((x): x is MergedClaim => x !== undefined).slice(0, 4);
          addCandidate(sides, topic, 'judge', '');
        }
      }
    }
    for (const c of candidates.values()) {
      if (c.origins.has('draft')) stats.from_draft += 1;
      if (c.origins.has('judge')) stats.from_judge += 1;
    }
    stats.candidates = candidates.size;

    // ---- 3. verification (mid-tier)
    const verified = new Map<string, { summary: string; newer: MergedClaim | undefined }>();
    const rejected = new Set<string>();
    const sideExcerpt = (c: MergedClaim): string => {
      const parts = c.provenance.slice(0, 2).map((r) => {
        const item = itemsByRef.get(itemKey(r.kind, r.ref));
        return item ? `(${r.kind} ${item.title}, ${item.modified_at.slice(0, 10)}${r.line ? `, line ${r.line}` : ''})\n${sourceExcerpt(item, r, verifyContextLines)}` : `(${r.kind} ${r.ref}) [source not available]`;
      });
      return parts.join('\n');
    };
    const verifyQueue: Candidate[][] = [];
    // Deterministic order: discovery finishes in concurrency order, and verify batches must be cache-stable across runs.
    const all = [...candidates.values()].sort((a, b) => a.key.localeCompare(b.key));
    for (let i = 0; i < all.length; i += verifyBatch) verifyQueue.push(all.slice(i, i + verifyBatch));
    await drain(verifyQueue, concurrency, async (batch) => {
      if (budgetHit) return;
      const ids = new Map<string, Candidate>();
      const payload = batch.map((c, i) => {
        const id = `p${i + 1}`;
        ids.set(id, c);
        return {
          id,
          question: c.question,
          sides: c.sides.map((s, j) => ({ id: String.fromCharCode(97 + j), claim: s.text, source: sideExcerpt(s) })),
        };
      });
      const text = await call('contradict_verify', verifyPrompt.text, `Candidates:\n${JSON.stringify(payload)}`, verifyMaxTokens);
      if (text === null) return;
      stats.verify_calls += 1;
      const { parsed, salvaged } = parseWithSalvage(text, VerifyOut, [']}']);
      if (salvaged) truncated += 1;
      if (!parsed) parseFailures += 1;
      const done = new Set<string>();
      for (const r of parsed?.results ?? []) {
        const c = ids.get(r.id);
        if (!c || done.has(c.key)) continue;
        done.add(c.key);
        if (r.verdict === 'contradiction') {
          const newerIdx = r.newer ? r.newer.toLowerCase().charCodeAt(0) - 97 : -1;
          verified.set(c.key, { summary: r.summary || c.hint, newer: c.sides[newerIdx] });
        } else rejected.add(c.key);
      }
      const missing = batch.filter((c) => !done.has(c.key));
      if (missing.length > 0 && (salvaged || !parsed)) {
        if (batch.length === 1) return;
        const mid = Math.ceil(missing.length / 2);
        verifyQueue.push(missing.slice(0, mid));
        if (mid < missing.length) verifyQueue.push(missing.slice(mid));
        retries += 1;
      }
    });
    stats.verified = verified.size;
    stats.rejected = rejected.size;
    stats.unverified = candidates.size - verified.size - rejected.size;

    // ---- findings
    const findings = new Map<string, Finding>();
    const put = (f: Finding): void => {
      const k = `${f.kind}|${f.refs.map(refKey).sort().join(',')}`;
      if (!findings.has(k)) findings.set(k, f);
    };
    const contradictions: Finding[] = [];
    for (const c of candidates.values()) {
      const v = verified.get(c.key);
      const verdict = v ? 'contradiction' : rejected.has(c.key) ? 'rejected' : 'unverified';
      log({ event: 'contradict_candidate', run_id: ctx.run_id, org_id: ctx.org_id, origins: [...c.origins].sort().join(','), verdict, refs: unionRefs(c.sides).map(refKey).join(' ') });
      if (!v) continue;
      const codeSides = c.sides.filter((s) => s.provenance.every(isCodeRef));
      const docSides = c.sides.filter((s) => s.provenance.some((r) => !isCodeRef(r)));
      const recordSides = c.sides.filter((s) => s.provenance.some(isRecordRef));
      const refs = unionRefs(c.sides);
      const summary = `${c.question}: ${v.summary}${v.newer ? ` Newer: "${v.newer.text}" (${v.newer.source}, ${v.newer.date}).` : ''}`;
      if (codeSides.length === c.sides.length) {
        // Commit and code history is not a conflict: the code's current state wins by definition.
        stats.code_history += 1;
        continue;
      }
      if (recordSides.length === 0) {
        // Chat disagreeing with chat: a human question, never a contradiction between records.
        put({ kind: 'low_confidence', refs, summary: `Chat disagrees, no source of record: ${summary}`, suggested_knowers: [...new Set(c.sides.flatMap(authorsOf))], confidence: 0.4 });
        stats.chat_only += 1;
        continue;
      }
      if (docSides.length >= 2) {
        contradictions.push({ kind: 'contradiction', refs, summary, suggested_knowers: [...new Set(c.sides.flatMap(authorsOf))], confidence: 0.8 });
      }
      if (docSides.length >= 1 && codeSides.length >= 1) {
        put({ kind: 'drift', refs, summary: `Docs vs code — ${summary}`, confidence: 0.7 });
        stats.drifts += 1;
      }
    }
    // One record citation, one finding: the same policy line disagreeing with six Slack reminders
    // (or with two other documents) is one conflict with several sources, not several conflicts.
    const mergedFindings: Finding[] = [];
    for (const f of contradictions) {
      const keys = new Set(f.refs.filter(isRecordRef).map(refKey));
      const idx = mergedFindings.findIndex((m) => m.refs.some((r) => isRecordRef(r) && keys.has(refKey(r))));
      const existing = mergedFindings[idx];
      if (idx < 0 || !existing) {
        mergedFindings.push(f);
        continue;
      }
      const seen = new Set(existing.refs.map(refKey));
      const extra = f.refs.filter((r) => !seen.has(refKey(r)));
      const also = existing.summary.length < 700 ? `${existing.summary} Also: ${f.summary.slice(0, 200)}` : existing.summary;
      mergedFindings[idx] = { ...existing, refs: [...existing.refs, ...extra], summary: also, suggested_knowers: [...new Set([...(existing.suggested_knowers ?? []), ...(f.suggested_knowers ?? [])])] };
      stats.merged_findings += 1;
    }
    for (const f of mergedFindings) put(f);
    stats.contradictions = mergedFindings.length;
    for (const f of implied) put(f);
    stats.implied = implied.length;
    // A judge escalation nothing here confirmed stays a gap for a human, as low_confidence.
    const verifiedRefs = new Set([...findings.values()].filter((f) => f.kind === 'contradiction').flatMap((f) => f.refs.map(refKey)));
    for (const prior of ctx.findings) {
      if (prior.kind !== 'contradiction') continue;
      if (prior.refs.some((r) => verifiedRefs.has(refKey(r)))) continue;
      put({ ...prior, kind: 'low_confidence', summary: `${prior.summary} (not confirmed as a contradiction; needs a human)` });
      stats.escalations_kept += 1;
    }

    if (budgetHit) notes.push('contradict: budget reached; remaining topics/candidates skipped');
    if (truncated > 0) notes.push(`contradict: ${truncated} response(s) were cut off; ${retries} split batch(es) retried`);
    if (parseFailures > 0) notes.push(`contradict: ${parseFailures} response(s) had no parseable JSON`);
    notes.push(`contradict: ${stats.eligible_topics}/${stats.topics} topics eligible, ${discoveryBatches} discovery batch(es); ${stats.candidates} candidates (${stats.from_discovery} discovery, ${stats.from_draft} draft, ${stats.from_judge} judge) → ${stats.verified} verified, ${stats.rejected} rejected, ${stats.unverified} unverified`);
    notes.push(`contradict: ${stats.contradictions} contradictions (${stats.merged_findings} merged into them), ${stats.drifts} doc-vs-code drifts, ${stats.chat_only} chat-only disagreements → low_confidence, ${stats.code_history} code-history pairs dropped, ${stats.implied} implied-knowledge gaps, ${stats.escalations_kept} judge escalation(s) kept as low_confidence`);
    log({ event: 'stage', stage: 'contradict', run_id: ctx.run_id, org_id: ctx.org_id, escalated_artifacts: escalated.size, ...stats, ...usage });

    return {
      artifacts: [],
      findings: [...findings.values()],
      replace_finding_kinds: ['contradiction'],
      usage,
      stats: { ...stats },
      notes,
    };
  };
}
