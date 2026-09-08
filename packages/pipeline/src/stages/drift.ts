// Stage 6: drift (F-CODE-3, F-GAP-1d; plan Week 4). Code-vs-docs drift:
// code is ground truth, a document that disagrees with it is stale.
//
// Drift lives in identifiers, and the two sides rarely share a topic name
// ("migration configuration" vs "control-plane env vars"), so this stage does
// not use the draft's topics. Instead:
// 1. Doc statements: technical claims from documents/macros/READMEs, plus
//    technical lines of those documents no claim covers (code fences, inline
//    identifiers) — that is where stale examples hide.
// 2. Retrieval: a small BM25 index over code files and commit messages,
//    tokenized so `NW_DB_URL`, `databaseUrl` and "rename NW_DB_URL to
//    DATABASE_URL" meet on the same terms. Top files/commits per statement,
//    excerpted around the matching lines.
// 3. Verification (mid-tier route `drift`): does the current code contradict
//    the statement? Only a `drift` verdict with cited code becomes a finding,
//    linked to the code lines and the commit that changed it.
import { BudgetExceededError, complete as gatewayComplete, type CompleteFn } from '@tacit/gateway';
import { loadPrompt } from '@tacit/prompts';
import { z } from 'zod';
import { wasCached } from '../cache';
import type { EvalSyncItem, ExtractedClaim, Finding, SourceRef, StageContext, StageResult, StageRunner } from '../contract';
import { drain, parseWithSalvage } from '../json';

export interface DriftDeps {
  readonly complete?: CompleteFn;
  readonly maxBatch?: number;
  readonly topCodeItems?: number;
  readonly contextLines?: number;
  readonly maxTokens?: number;
  readonly maxStatementsPerDoc?: number;
  readonly concurrency?: number;
  readonly log?: (line: Record<string, unknown>) => void;
}

const Result = z.object({
  id: z.string(),
  verdict: z.enum(['drift', 'consistent', 'unrelated']),
  code_says: z.string().max(300).optional(),
  evidence: z.array(z.object({ code: z.string(), line: z.number().int().positive().optional() })).default([]),
  summary: z.string().max(600).optional(),
});
const Output = z.object({ results: z.array(Result) });

// ---- tokenization: identifiers split on _, -, ., /, and camelCase; lowercase; short/stop words dropped
const STOP = new Set(['to', 'of', 'in', 'on', 'at', 'by', 'is', 'it', 'as', 'or', 'an', 'be', 'do', 'if', 'no', 'so', 'up', 'we', 'he', 'me', 'my', 'us', 'am', 'the', 'and', 'for', 'with', 'that', 'this', 'from', 'are', 'was', 'were', 'has', 'have', 'not', 'but', 'you', 'your', 'our', 'all', 'any', 'can', 'will', 'must', 'should', 'into', 'per', 'via', 'use', 'set', 'const', 'export', 'import', 'return', 'true', 'false', 'null', 'new', 'let', 'var', 'function', 'type', 'string', 'number', 'readonly', 'async', 'await', 'then', 'else', 'when', 'than', 'also', 'only', 'every', 'each', 'before', 'after', 'about', 'more', 'most', 'some', 'such', 'other', 'their', 'there', 'they', 'them', 'been', 'being', 'does', 'did', 'how', 'what', 'which', 'who', 'why', 'its', 'one', 'two', 'see', 'get', 'put', 'post', 'run', 'runs', 'over', 'out', 'off', 'default', 'value']);

/** Light stemming so "deliveries" meets DELIVERY and "retried" meets MAX_RETRIES. */
function stem(w: string): string {
  if (w.length <= 3 || /^\d+$/.test(w)) return w;
  if (w.endsWith('ies') || w.endsWith('ied')) return `${w.slice(0, -3)}y`;
  if (w.endsWith('sses')) return w.slice(0, -2);
  if (w.endsWith('es') && w.length > 4 && !w.endsWith('ses')) return w.slice(0, -2);
  if (w.endsWith('ed') && w.length > 4) return w.slice(0, -2);
  if (w.endsWith('s') && !w.endsWith('ss')) return w.slice(0, -1);
  return w;
}

/** Code vocabulary that prose spells out: "database" ↔ db/, "authenticate" ↔ auth.ts. */
const SYN: Record<string, string> = { db: 'database', authentication: 'auth', authenticate: 'auth', authenticat: 'auth', authenticating: 'auth', configuration: 'config', environment: 'env', variable: 'var', repository: 'repo', directory: 'dir', parameter: 'param' };
const norm = (w: string): string => SYN[w] ?? SYN[stem(w)] ?? stem(w);

const rawTokens = (text: string): string[] =>
  text
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((r) => r.length >= 2);

export function tokenize(text: string): string[] {
  return rawTokens(text)
    .filter((r) => !STOP.has(r))
    .map(norm);
}

/** Query terms: tokens plus adjacent pairs joined, so "time out" and "rate limit" meet TIMEOUT and rateLimit. */
export function queryTokens(text: string): string[] {
  const raw = rawTokens(text);
  const joined = raw.slice(1).map((w, i) => ({ a: raw[i] ?? '', b: w })).filter(({ a, b }) => !(STOP.has(a) && STOP.has(b))).map(({ a, b }) => `${a}${b}`).filter((j) => j.length <= 20 && /^[a-z]+$/.test(j));
  return [...new Set([...tokenize(text), ...joined])];
}

/** Does a doc line or claim talk about something the code could contradict? */
const TECH = [
  /\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b/, // UPPER_SNAKE
  /\b[a-z]+[A-Z][A-Za-z0-9]+\b/, // camelCase
  /\bX-[A-Za-z0-9-]+/, // headers
  /\/v\d+\/[\w/-]+/, // versioned paths
  /\b\w+\.\w+(?:\.\w+)*\(\)/, // client.robots.list()
  /\b[a-z][a-z0-9]*_[a-z0-9_]+\b/, // snake_case
  /\b[A-Z]{2,}-\d+\b/, // NW-404
  /\b(?:us|eu|ap|sa|ca|me|af)-(?:east|west|central|north|south|northeast|southeast)-\d\b/,
  /\bport\s+\d+/i,
  /\b\d[\d_,.]*\s*(?:ms|milliseconds|seconds|secs|minutes|req\/min|requests per minute|items per page|per page|retries|retry|attempts)\b/i,
  /\b(?:env(?:ironment)? var(?:iable)?s?|endpoint|header|feature flag|flag|database|db name|error codes?|migration|sdk|page size|pagination|rate limit|timeout|time out|retr(?:y|ies)|signature|listens on|defaults? to)\b/i,
];
export function isTechnical(text: string): boolean {
  return TECH.some((re) => re.test(text));
}

const STRICT = TECH.slice(0, 10);
/** For raw doc lines (not extracted claims) demand an identifier-like token, not just a technical noun. */
export function isTechnicalLine(line: string): boolean {
  const t = line.trim();
  if (t.length < 8 || t.length > 400) return false;
  if (/^(#|---|\||```)/.test(t) && !/`/.test(t)) return false;
  return STRICT.some((re) => re.test(t));
}

export function isDocItem(item: EvalSyncItem): boolean {
  if (item.source === 'gdrive') return true;
  if (item.source === 'zendesk') return item.kind === 'macro';
  if (item.source === 'github') return item.external_ref.toLowerCase().endsWith('.md');
  return false;
}
export function isCodeItem(item: EvalSyncItem): boolean {
  return item.source === 'github_commit' || (item.source === 'github' && !item.external_ref.toLowerCase().endsWith('.md'));
}

// ---- BM25 over code items
interface Indexed {
  readonly item: EvalSyncItem;
  readonly tf: ReadonlyMap<string, number>;
  readonly len: number;
}
export interface CodeIndex {
  readonly docs: readonly Indexed[];
  readonly df: ReadonlyMap<string, number>;
  readonly avgLen: number;
}
export function buildIndex(items: readonly EvalSyncItem[]): CodeIndex {
  const docs: Indexed[] = [];
  const df = new Map<string, number>();
  for (const item of items) {
    const tokens = tokenize(`${item.title}\n${item.content}`);
    const tf = new Map<string, number>();
    for (const t of tokens) tf.set(t, (tf.get(t) ?? 0) + 1);
    for (const t of tf.keys()) df.set(t, (df.get(t) ?? 0) + 1);
    docs.push({ item, tf, len: tokens.length });
  }
  const avgLen = docs.length === 0 ? 1 : docs.reduce((s, d) => s + d.len, 0) / docs.length;
  return { docs, df, avgLen };
}
export function search(index: CodeIndex, query: string, k: number): { item: EvalSyncItem; score: number }[] {
  const q = queryTokens(query);
  const n = index.docs.length;
  const scored = index.docs.map((d) => {
    let score = 0;
    for (const t of q) {
      const tf = d.tf.get(t);
      if (!tf) continue;
      const df = index.df.get(t) ?? 0;
      const idf = Math.log(1 + (n - df + 0.5) / (df + 0.5));
      score += idf * ((tf * 2.2) / (tf + 1.2 * (0.25 + 0.75 * (d.len / index.avgLen))));
    }
    return { item: d.item, score };
  });
  return scored
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score || a.item.external_ref.localeCompare(b.item.external_ref))
    .slice(0, k);
}

/** Numbered excerpt windows around the lines that share the most query tokens with the statement. */
export function excerptWindows(item: EvalSyncItem, query: string, contextLines: number, maxWindows: number): { line: number; text: string }[] {
  const q = new Set(queryTokens(query));
  const lines = item.content.split('\n');
  const hits = lines
    .map((l, i) => ({ i, n: new Set(tokenize(l).filter((t) => q.has(t))).size }))
    .filter((h) => h.n > 0)
    .sort((a, b) => b.n - a.n || a.i - b.i);
  const windows: { start: number; end: number; anchor: number }[] = [];
  for (const h of hits) {
    if (windows.length >= maxWindows) break;
    const start = Math.max(0, h.i - contextLines);
    const end = Math.min(lines.length, h.i + contextLines + 1);
    if (windows.some((w) => h.i >= w.start && h.i < w.end)) continue;
    windows.push({ start, end, anchor: h.i });
  }
  return windows
    .sort((a, b) => a.start - b.start)
    .map((w) => ({ line: w.anchor + 1, text: lines.slice(w.start, w.end).map((l, j) => `${w.start + j + 1}: ${l}`).join('\n') }));
}

export interface DocStatement {
  readonly id: string;
  readonly item: EvalSyncItem;
  readonly ref: SourceRef;
  readonly text: string;
  readonly quote?: string;
  readonly origin: 'claim' | 'line';
}

/** Rare code terms (in few code items) that a statement shares with the code base: an identifier-level link. */
export function sharedRareTerms(index: CodeIndex, text: string): string[] {
  const cap = Math.max(3, Math.floor(index.docs.length * 0.1));
  return queryTokens(text).filter((t) => {
    const df = index.df.get(t) ?? 0;
    return df > 0 && df <= cap && !/^\d+$/.test(t);
  });
}

/**
 * Technical claims from documents (identifier-like text, or at least two rare terms shared
 * with the code), plus technical doc lines no claim covers (stale code examples hide there).
 */
export function docStatements(items: readonly EvalSyncItem[], claims: readonly ExtractedClaim[], maxPerDoc: number, index?: CodeIndex): DocStatement[] {
  const byRef = new Map(items.map((i) => [`${i.source}|${i.external_ref}`, i] as const));
  const out: DocStatement[] = [];
  const coveredLines = new Map<string, Set<number>>();
  const seenClaim = new Set<string>();
  for (const c of claims) {
    const item = byRef.get(`${c.source}|${c.provenance[0]?.ref ?? ''}`);
    if (!item || !isDocItem(item)) continue;
    const text = `${c.text} ${c.quote ?? ''}`;
    if (!isTechnical(text) && !(index && sharedRareTerms(index, text).length >= 2)) continue;
    const ref = c.provenance[0];
    if (!ref) continue;
    const key = `${item.id}|${c.text.toLowerCase()}`;
    if (seenClaim.has(key)) continue;
    seenClaim.add(key);
    if (ref.line !== undefined) {
      const set = coveredLines.get(item.id) ?? new Set<number>();
      for (let l = ref.line - 3; l <= ref.line + 3; l++) set.add(l);
      coveredLines.set(item.id, set);
    }
    out.push({ id: '', item, ref, text: c.text, ...(c.quote ? { quote: c.quote } : {}), origin: 'claim' });
  }
  for (const item of items) {
    if (!isDocItem(item)) continue;
    const covered = coveredLines.get(item.id) ?? new Set<number>();
    const lines = item.content.split('\n');
    lines.forEach((l, i) => {
      const line = i + 1;
      if (covered.has(line) || !isTechnicalLine(l)) return;
      const prev = i > 0 ? lines[i - 1]?.trim() ?? '' : '';
      const text = prev && !/^```/.test(prev) && prev.length < 160 ? `${prev} ${l.trim()}` : l.trim();
      out.push({ id: '', item, ref: { kind: item.source, ref: item.external_ref, line }, text, origin: 'line' });
    });
  }
  // Cap per document: claims first, then the identifier-richest lines.
  const perDoc = new Map<string, DocStatement[]>();
  for (const s of out) {
    const list = perDoc.get(s.item.id) ?? [];
    list.push(s);
    perDoc.set(s.item.id, list);
  }
  const capped: DocStatement[] = [];
  for (const list of perDoc.values()) {
    const claimsFirst = list.filter((s) => s.origin === 'claim');
    const lines = list.filter((s) => s.origin === 'line').sort((a, b) => tokenize(b.text).length - tokenize(a.text).length);
    capped.push(...[...claimsFirst, ...lines].slice(0, maxPerDoc));
  }
  return capped.sort((a, b) => a.item.external_ref.localeCompare(b.item.external_ref) || (a.ref.line ?? 0) - (b.ref.line ?? 0)).map((s, i) => ({ ...s, id: `s${i + 1}` }));
}

export interface DriftStats {
  statements: number;
  from_claims: number;
  from_lines: number;
  no_code_match: number;
  calls: number;
  drift: number;
  consistent: number;
  unrelated: number;
  unverified: number;
  findings: number;
}

export function createDriftStage(deps: DriftDeps = {}): StageRunner {
  const complete = deps.complete ?? gatewayComplete;
  const log = deps.log ?? (() => undefined);

  return async (ctx: StageContext): Promise<StageResult> => {
    const prompt = loadPrompt('drift');
    const maxBatch = deps.maxBatch ?? Number(prompt.params.max_batch ?? 5);
    const topCodeItems = deps.topCodeItems ?? Number(prompt.params.top_code_items ?? 4);
    const contextLines = deps.contextLines ?? Number(prompt.params.context_lines ?? 4);
    const maxTokens = deps.maxTokens ?? Number(prompt.params.max_tokens ?? 4096);
    const maxPerDoc = deps.maxStatementsPerDoc ?? 80;
    const usage = { cost_usd: 0, model_calls: 0, in_tokens: 0, out_tokens: 0, cached_calls: 0 };
    const stats: DriftStats = { statements: 0, from_claims: 0, from_lines: 0, no_code_match: 0, calls: 0, drift: 0, consistent: 0, unrelated: 0, unverified: 0, findings: 0 };
    const notes: string[] = [];
    let budgetHit = false;
    let truncated = 0;
    let parseFailures = 0;
    let retries = 0;

    const codeItems = ctx.items.filter(isCodeItem);
    const index = buildIndex(codeItems);
    const statements = docStatements(ctx.items, ctx.claims, maxPerDoc, index);
    stats.statements = statements.length;
    stats.from_claims = statements.filter((s) => s.origin === 'claim').length;
    stats.from_lines = statements.length - stats.from_claims;

    interface Candidate {
      readonly statement: DocStatement;
      readonly code: { id: string; item: EvalSyncItem; windows: { line: number; text: string }[] }[];
    }
    const candidates: Candidate[] = [];
    for (const s of statements) {
      const query = `${s.text} ${s.quote ?? ''}`;
      const hits = search(index, query, topCodeItems);
      if (hits.length === 0) {
        stats.no_code_match += 1;
        continue;
      }
      const code = hits.map((h, i) => ({
        id: `k${i + 1}`,
        item: h.item,
        windows: h.item.source === 'github_commit' ? [{ line: 1, text: h.item.content.slice(0, 600) }] : excerptWindows(h.item, query, contextLines, 3),
      }));
      candidates.push({ statement: s, code });
    }

    const findings: Finding[] = [];
    const seen = new Set<string>();
    const queue: Candidate[][] = [];
    for (let i = 0; i < candidates.length; i += maxBatch) queue.push(candidates.slice(i, i + maxBatch));
    const initialBatches = queue.length;

    await drain(queue, deps.concurrency ?? 4, async (batch) => {
      if (budgetHit) return;
      const byId = new Map(batch.map((c) => [c.statement.id, c] as const));
      const payload = batch.map((c) => ({
        id: c.statement.id,
        doc: { source: c.statement.item.source, title: c.statement.item.title, date: c.statement.item.modified_at.slice(0, 10), line: c.statement.ref.line ?? null, statement: c.statement.text, ...(c.statement.quote ? { quote: c.statement.quote } : {}) },
        code: c.code.map((k) => ({ id: k.id, path: k.item.source === 'github_commit' ? `commit ${k.item.title}` : k.item.external_ref, date: k.item.modified_at.slice(0, 10), excerpts: k.windows.map((w) => w.text) })),
      }));
      let text: string;
      try {
        const completion = await complete(
          'drift',
          [
            { role: 'system', content: prompt.text },
            { role: 'user', content: `Candidates:\n${JSON.stringify(payload)}` },
          ],
          { json: true, maxTokens, runId: ctx.run_id, orgId: ctx.org_id, budgetUsd: ctx.budget_usd },
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
      stats.calls += 1;
      const { parsed, salvaged } = parseWithSalvage(text, Output, [']}']);
      if (salvaged) truncated += 1;
      if (!parsed) parseFailures += 1;
      const done = new Set<string>();
      for (const r of parsed?.results ?? []) {
        const c = byId.get(r.id);
        if (!c || done.has(r.id)) continue;
        done.add(r.id);
        stats[r.verdict] += 1;
        log({ event: 'drift_candidate', run_id: ctx.run_id, org_id: ctx.org_id, doc: `${c.statement.ref.kind}|${c.statement.ref.ref}|${c.statement.ref.line ?? ''}`, origin: c.statement.origin, verdict: r.verdict, code: c.code.map((k) => k.item.external_ref).join(' ') });
        if (r.verdict !== 'drift') continue;
        const evidence = r.evidence.map((e) => ({ e, k: c.code.find((k) => k.id === e.code) })).filter((x): x is { e: { code: string; line?: number }; k: Candidate['code'][number] } => x.k !== undefined);
        if (evidence.length === 0) continue;
        const codeRefs: SourceRef[] = evidence.map(({ e, k }) => {
          const line = k.item.source === 'github_commit' ? undefined : (e.line ?? k.windows[0]?.line);
          return { kind: k.item.source, ref: k.item.external_ref, ...(line !== undefined ? { line } : {}) };
        });
        const refs = [c.statement.ref, ...codeRefs];
        const key = refs.map((x) => `${x.kind}|${x.ref}|${x.line ?? ''}`).sort().join(',');
        if (seen.has(key)) continue;
        seen.add(key);
        const where = evidence.map(({ k }) => (k.item.source === 'github_commit' ? `commit "${k.item.title.replace(/^#\d+\s*/, '')}"` : k.item.external_ref)).join(', ');
        findings.push({
          kind: 'drift',
          refs,
          summary: `Docs vs code — ${c.statement.item.title}: ${r.summary ?? `"${c.statement.text}" but the code says ${r.code_says ?? 'otherwise'}`} (${where}).`,
          confidence: 0.8,
        });
      }
      const missing = batch.filter((c) => !done.has(c.statement.id));
      if (missing.length > 0 && (salvaged || !parsed)) {
        if (batch.length === 1) return;
        const mid = Math.ceil(missing.length / 2);
        queue.push(missing.slice(0, mid));
        if (mid < missing.length) queue.push(missing.slice(mid));
        retries += 1;
      }
    });

    stats.unverified = candidates.length - stats.drift - stats.consistent - stats.unrelated;
    stats.findings = findings.length;
    if (budgetHit) notes.push('drift: budget reached; remaining candidates skipped');
    if (truncated > 0) notes.push(`drift: ${truncated} response(s) were cut off; ${retries} split batch(es) retried`);
    if (parseFailures > 0) notes.push(`drift: ${parseFailures} response(s) had no parseable JSON`);
    notes.push(`drift: ${stats.statements} doc statements (${stats.from_claims} claims, ${stats.from_lines} uncovered lines) over ${codeItems.length} code items; ${candidates.length} with code matches in ${initialBatches} batch(es) → ${stats.drift} drift, ${stats.consistent} consistent, ${stats.unrelated} unrelated, ${stats.unverified} unverified`);
    log({ event: 'stage', stage: 'drift', run_id: ctx.run_id, org_id: ctx.org_id, code_items: codeItems.length, ...stats, ...usage });

    return { artifacts: [], findings, usage, stats: { ...stats }, notes };
  };
}
