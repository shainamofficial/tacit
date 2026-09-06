// Resolves every defect's quotes to exact locations in the generated corpus
// and emits manifest.json (SPEC §4.2). A quote that cannot be found — or is
// found more than once where exactly one is expected — fails the build.
import type { DriveDoc } from './docs';
import { DEFECTS, EXPECTED_IDS, type Defect, type SourceSel } from './defects';
import type { SlackMessage } from './slack';
import type { Macro, Ticket } from './zendesk';
import { NOW, SEED, person } from './world';

export interface CommitRef {
  readonly ordinal: number;
  readonly sha: string;
  readonly subject: string;
  readonly author: string;
  readonly date: string;
}

export interface Corpus {
  readonly docs: readonly DriveDoc[];
  readonly slack: readonly SlackMessage[];
  readonly macros: readonly Macro[];
  readonly tickets: readonly Ticket[];
  readonly tree: ReadonlyMap<string, string>;
  readonly commits: readonly CommitRef[];
}

export type Location =
  | { kind: 'gdrive'; doc_id: string; path: string; line: number; quote: string; restricted: string }
  | { kind: 'slack'; conversation: string; ts: string; path: string; user: string; quote: string; restricted: boolean }
  | { kind: 'zendesk'; object: 'macro' | 'ticket'; id: number; path: string; quote: string }
  | { kind: 'github'; path: string; line: number; quote: string }
  | { kind: 'github_commit'; ordinal: number; sha: string; subject: string; quote: string }
  | { kind: 'github_commit_series'; author: string; count: number; commits: Array<{ ordinal: number; sha: string; subject: string }> };

export interface ManifestDefect {
  readonly id: string;
  readonly kind: Defect['kind'];
  readonly topic: string;
  readonly sources: Location[];
  readonly expected: Defect['expected'];
}

export interface Manifest {
  readonly version: 1;
  readonly seed: number;
  readonly now: string;
  readonly counts: {
    docs: number;
    restricted_docs: number;
    slack_messages: number;
    slack_channels: number;
    tickets: number;
    macros: number;
    commits: number;
  };
  readonly repo_head: string;
  readonly corpus_digest: string;
  readonly defects: ManifestDefect[];
  readonly distractors: ManifestDefect[];
}

function findLines(text: string, quote: string): number[] {
  const lines = text.split('\n');
  const hits: number[] = [];
  lines.forEach((line, i) => {
    if (line.includes(quote)) hits.push(i + 1);
  });
  return hits;
}

function exactlyOne<T>(hits: T[], what: string): T {
  if (hits.length !== 1) {
    throw new Error(`expected exactly one match for ${what}, found ${hits.length}`);
  }
  const hit = hits[0];
  if (hit === undefined) throw new Error(`no match for ${what}`);
  return hit;
}

export function locate(sel: SourceSel, corpus: Corpus, defectId: string): Location[] {
  const label = `${defectId} ${JSON.stringify(sel)}`;
  switch (sel.kind) {
    case 'gdrive': {
      const doc = corpus.docs.find((d) => d.slug === sel.doc);
      if (!doc) throw new Error(`${defectId}: unknown doc ${sel.doc}`);
      const line = exactlyOne(findLines(doc.body, sel.quote), label);
      return [{ kind: 'gdrive', doc_id: doc.id, path: doc.path, line, quote: sel.quote, restricted: doc.restricted }];
    }
    case 'slack': {
      const hits = corpus.slack.filter((m) => m.conversation === sel.conversation && m.text.includes(sel.quote));
      const m = exactlyOne(hits, label);
      const restricted = sel.conversation === 'exec' || sel.conversation.startsWith('D');
      return [{ kind: 'slack', conversation: sel.conversation, ts: m.ts, path: m.file, user: person(m.user).email, quote: sel.quote, restricted }];
    }
    case 'zendesk': {
      if (sel.object === 'macro') {
        const hits = corpus.macros.filter((m) => m.body.includes(sel.quote));
        const m = exactlyOne(hits, label);
        return [{ kind: 'zendesk', object: 'macro', id: m.id, path: 'zendesk/macros.json', quote: sel.quote }];
      }
      const hits = corpus.tickets.filter(
        (t) => t.description.includes(sel.quote) || t.comments.some((c) => c.body.includes(sel.quote)),
      );
      if (sel.all) {
        if (hits.length < 2) throw new Error(`${label}: expected several tickets, found ${hits.length}`);
        return hits.map((t) => ({ kind: 'zendesk', object: 'ticket', id: t.id, path: 'zendesk/tickets.json', quote: sel.quote }));
      }
      const t = exactlyOne(hits, label);
      return [{ kind: 'zendesk', object: 'ticket', id: t.id, path: 'zendesk/tickets.json', quote: sel.quote }];
    }
    case 'github': {
      const content = corpus.tree.get(sel.path);
      if (content === undefined) throw new Error(`${defectId}: no file ${sel.path} in final tree`);
      const line = exactlyOne(findLines(content, sel.quote), label);
      return [{ kind: 'github', path: `repo/${sel.path}`, line, quote: sel.quote }];
    }
    case 'github_commit': {
      const c = corpus.commits.find((x) => x.ordinal === sel.ordinal);
      if (!c) throw new Error(`${defectId}: no commit #${sel.ordinal}`);
      if (!c.subject.includes(sel.quote)) throw new Error(`${label}: commit #${sel.ordinal} subject "${c.subject}" lacks quote`);
      return [{ kind: 'github_commit', ordinal: c.ordinal, sha: c.sha, subject: c.subject, quote: sel.quote }];
    }
    case 'github_commit_series': {
      const author = person(sel.author).email;
      const hits = corpus.commits.filter((c) => c.subject.startsWith(sel.subjectPrefix));
      if (hits.length < 3) throw new Error(`${label}: expected a series, found ${hits.length}`);
      const foreign = hits.filter((c) => c.author !== author);
      if (foreign.length > 0) throw new Error(`${label}: series has commits by others: ${foreign.map((c) => c.ordinal).join(',')}`);
      return [{ kind: 'github_commit_series', author, count: hits.length, commits: hits.map((c) => ({ ordinal: c.ordinal, sha: c.sha, subject: c.subject })) }];
    }
  }
}

export function buildManifest(corpus: Corpus, repoHead: string, corpusDigest: string): Manifest {
  const resolved: ManifestDefect[] = DEFECTS.map((d) => ({
    id: d.id,
    kind: d.kind,
    topic: d.topic,
    sources: d.sources.flatMap((s) => locate(s, corpus, d.id)),
    expected: d.expected,
  }));

  const ids = new Set(resolved.map((d) => d.id));
  const missing = EXPECTED_IDS.filter((id) => !ids.has(id));
  if (missing.length > 0) throw new Error(`manifest is missing defects: ${missing.join(', ')}`);

  for (const d of resolved) {
    if (d.kind === 'permission') {
      const leaky = d.sources.filter((s) => (s.kind === 'gdrive' && s.restricted === 'none') || (s.kind === 'slack' && !s.restricted && s.conversation !== 'sales'));
      if (leaky.length > 0) throw new Error(`${d.id}: restricted fact found in an unrestricted source: ${JSON.stringify(leaky)}`);
    }
  }

  const defects = resolved.filter((d) => d.kind !== 'distractor');
  const distractors = resolved.filter((d) => d.kind === 'distractor');
  if (distractors.length < 10) throw new Error(`need ≥10 distractors, have ${distractors.length}`);

  return {
    version: 1,
    seed: SEED,
    now: new Date(NOW).toISOString(),
    counts: {
      docs: corpus.docs.length,
      restricted_docs: corpus.docs.filter((d) => d.restricted !== 'none').length,
      slack_messages: corpus.slack.length,
      slack_channels: new Set(corpus.slack.map((m) => m.conversation)).size,
      tickets: corpus.tickets.length,
      macros: corpus.macros.length,
      commits: corpus.commits.length,
    },
    repo_head: repoHead,
    corpus_digest: corpusDigest,
    defects,
    distractors,
  };
}
