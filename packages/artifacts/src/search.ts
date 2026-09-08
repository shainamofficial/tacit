// Lexical search shared by the drift stage (doc statements → code) and the
// serving layer (queries → artifacts). Identifier-aware tokenizer with light
// stemming and a few code-vocabulary synonyms, BM25 ranking, and numbered
// excerpt windows. No model calls: this is the ~100-token index tier (F-SRV-1a).

const STOP = new Set([
  'to', 'of', 'in', 'on', 'at', 'by', 'is', 'it', 'as', 'or', 'an', 'be', 'do', 'if', 'no', 'so', 'up', 'we', 'he', 'me', 'my', 'us', 'am',
  'the', 'and', 'for', 'with', 'that', 'this', 'from', 'are', 'was', 'were', 'has', 'have', 'not', 'but', 'you', 'your', 'our', 'all', 'any',
  'can', 'will', 'must', 'should', 'into', 'per', 'via', 'use', 'set', 'const', 'export', 'import', 'return', 'true', 'false', 'null', 'new',
  'let', 'var', 'function', 'type', 'string', 'number', 'readonly', 'async', 'await', 'then', 'else', 'when', 'than', 'also', 'only', 'every',
  'each', 'before', 'after', 'about', 'more', 'most', 'some', 'such', 'other', 'their', 'there', 'they', 'them', 'been', 'being', 'does', 'did',
  'how', 'what', 'which', 'who', 'why', 'its', 'one', 'two', 'see', 'get', 'put', 'post', 'run', 'runs', 'over', 'out', 'off', 'default', 'value',
]);

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
const SYN: Record<string, string> = {
  db: 'database',
  authentication: 'auth',
  authenticate: 'auth',
  authenticat: 'auth',
  authenticating: 'auth',
  configuration: 'config',
  environment: 'env',
  variable: 'var',
  repository: 'repo',
  directory: 'dir',
  parameter: 'param',
};
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
  const joined = raw
    .slice(1)
    .map((w, i) => ({ a: raw[i] ?? '', b: w }))
    .filter(({ a, b }) => !(STOP.has(a) && STOP.has(b)))
    .map(({ a, b }) => `${a}${b}`)
    .filter((j) => j.length <= 20 && /^[a-z]+$/.test(j));
  return [...new Set([...tokenize(text), ...joined])];
}

export interface SearchDoc {
  readonly id: string;
  readonly text: string;
}
interface Indexed<T> {
  readonly doc: T;
  readonly tf: ReadonlyMap<string, number>;
  readonly len: number;
}
export interface SearchIndex<T extends SearchDoc> {
  readonly docs: readonly Indexed<T>[];
  readonly df: ReadonlyMap<string, number>;
  readonly avgLen: number;
}

export function buildSearchIndex<T extends SearchDoc>(docs: readonly T[]): SearchIndex<T> {
  const indexed: Indexed<T>[] = [];
  const df = new Map<string, number>();
  for (const doc of docs) {
    const tokens = tokenize(doc.text);
    const tf = new Map<string, number>();
    for (const t of tokens) tf.set(t, (tf.get(t) ?? 0) + 1);
    for (const t of tf.keys()) df.set(t, (df.get(t) ?? 0) + 1);
    indexed.push({ doc, tf, len: tokens.length });
  }
  const avgLen = indexed.length === 0 ? 1 : indexed.reduce((s, d) => s + d.len, 0) / indexed.length;
  return { docs: indexed, df, avgLen };
}

export interface SearchHit<T> {
  readonly doc: T;
  readonly score: number;
  /** distinct query terms found in the doc */
  readonly matched: number;
  /** of those, terms rare in the index (≤ 1% of docs, at least 2): an identifier-level link rather than a common word */
  readonly rare: number;
  /** the matched query terms themselves */
  readonly terms: readonly string[];
}

/** BM25 (k1 = 1.2, b = 0.75); ties broken by id so results are deterministic. */
export function searchIndex<T extends SearchDoc>(index: SearchIndex<T>, query: string, k: number): SearchHit<T>[] {
  const q = queryTokens(query);
  const n = index.docs.length;
  const rareCap = Math.max(2, Math.floor(n * 0.01));
  return index.docs
    .map((d) => {
      let score = 0;
      let matched = 0;
      let rare = 0;
      const terms: string[] = [];
      for (const t of q) {
        const tf = d.tf.get(t);
        if (!tf) continue;
        const df = index.df.get(t) ?? 0;
        matched += 1;
        terms.push(t);
        if (df <= rareCap) rare += 1;
        const idf = Math.log(1 + (n - df + 0.5) / (df + 0.5));
        score += idf * ((tf * 2.2) / (tf + 1.2 * (0.25 + 0.75 * (d.len / index.avgLen))));
      }
      return { doc: d.doc, score, matched, rare, terms };
    })
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score || a.doc.id.localeCompare(b.doc.id))
    .slice(0, k);
}

/** Rare index terms (in few docs) that a text shares with the index: an identifier-level link. */
export function sharedRareTerms<T extends SearchDoc>(index: SearchIndex<T>, text: string): string[] {
  const cap = Math.max(3, Math.floor(index.docs.length * 0.1));
  return queryTokens(text).filter((t) => {
    const df = index.df.get(t) ?? 0;
    return df > 0 && df <= cap && !/^\d+$/.test(t);
  });
}

/** Numbered excerpt windows around the lines that share the most query tokens with the text. */
export function excerptWindows(content: string, query: string, contextLines: number, maxWindows: number): { line: number; text: string }[] {
  const q = new Set(queryTokens(query));
  const lines = content.split('\n');
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
