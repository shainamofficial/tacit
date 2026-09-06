// Secrets scanning at ingest (F-ING-5, CLAUDE.md #6): regex detectors plus an
// entropy pass. The scanner only reports spans; the sync store quarantines
// them by id and stores redacted content. Nothing here logs content.

export interface SecretSpan {
  readonly start: number;
  /** exclusive */
  readonly end: number;
  readonly detector: string;
}

interface Detector {
  readonly name: string;
  readonly re: RegExp;
  /** capture group that holds the secret; 0 = whole match */
  readonly group?: number;
}

// Order matters only for overlap resolution (earlier wins on ties).
const DETECTORS: readonly Detector[] = [
  { name: 'private_key', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g },
  { name: 'aws_access_key', re: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g },
  { name: 'github_token', re: /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{22,})\b/g },
  { name: 'slack_token', re: /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g },
  { name: 'anthropic_key', re: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/g },
  { name: 'openai_key', re: /\bsk-(?:proj-)?[A-Za-z0-9_-]{32,}\b/g },
  { name: 'stripe_key', re: /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}\b/g },
  { name: 'google_api_key', re: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  { name: 'jwt', re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g },
  { name: 'connection_string_password', re: /\b[a-z][a-z0-9+.-]*:\/\/[^\s:@/]+:([^\s@/]{3,})@/gi, group: 1 },
  {
    name: 'assigned_secret',
    re: /(?:api[_-]?key|secret[_-]?key|client[_-]?secret|access[_-]?token|auth[_-]?token|password|passwd)["']?\s*[:=]\s*["']?([A-Za-z0-9_\-/+=]{16,})["']?/gi,
    group: 1,
  },
];

const ENTROPY_MIN_LENGTH = 32;
const ENTROPY_THRESHOLD = 4.5;
// `=` only as trailing base64 padding, so `KEY=value` splits at the `=`.
const ENTROPY_CANDIDATE = /[A-Za-z0-9+/_-]{32,}={0,2}/g;

export function shannonEntropy(s: string): number {
  const counts = new Map<string, number>();
  for (const ch of s) counts.set(ch, (counts.get(ch) ?? 0) + 1);
  let h = 0;
  for (const n of counts.values()) {
    const p = n / s.length;
    h -= p * Math.log2(p);
  }
  return h;
}

function looksLikeSecretToken(token: string): boolean {
  if (token.length < ENTROPY_MIN_LENGTH) return false;
  if (/^[0-9a-f]+$/i.test(token)) return false; // git shas, hashes: high entropy but not credentials
  if (!/[A-Za-z]/.test(token) || !/[0-9]/.test(token)) return false;
  if (/^[A-Za-z0-9]+(?:[-_][A-Za-z0-9]+)+$/.test(token) && !/[0-9]{3}/.test(token)) return false; // kebab/snake identifiers
  return shannonEntropy(token) >= ENTROPY_THRESHOLD;
}

export function scanSecrets(content: string): SecretSpan[] {
  const found: SecretSpan[] = [];
  for (const d of DETECTORS) {
    d.re.lastIndex = 0;
    for (const m of content.matchAll(d.re)) {
      const group = d.group ?? 0;
      const text = m[group];
      if (text === undefined || m.index === undefined) continue;
      const offset = group === 0 ? 0 : m[0].indexOf(text);
      found.push({ start: m.index + offset, end: m.index + offset + text.length, detector: d.name });
    }
  }
  for (const m of content.matchAll(ENTROPY_CANDIDATE)) {
    if (m.index === undefined || !looksLikeSecretToken(m[0])) continue;
    found.push({ start: m.index, end: m.index + m[0].length, detector: 'high_entropy' });
  }
  // Resolve overlaps: earliest start wins; on a tie a specific detector beats
  // the entropy heuristic, then the longer span.
  const rank = (s: SecretSpan): number => (s.detector === 'high_entropy' ? 1 : 0);
  found.sort((a, b) => a.start - b.start || rank(a) - rank(b) || b.end - a.end);
  const out: SecretSpan[] = [];
  for (const s of found) {
    const last = out[out.length - 1];
    if (last && s.start < last.end) continue;
    out.push(s);
  }
  return out;
}

/** Replace each span with a reference-by-id placeholder. `ids[i]` belongs to `spans[i]`. */
export function redact(content: string, spans: readonly SecretSpan[], ids: readonly string[]): string {
  if (spans.length !== ids.length) throw new Error('redact: spans and ids differ in length');
  let out = content;
  for (let i = spans.length - 1; i >= 0; i--) {
    const s = spans[i];
    const id = ids[i];
    if (!s || id === undefined) continue;
    out = `${out.slice(0, s.start)}[SECRET:${id}]${out.slice(s.end)}`;
  }
  return out;
}
