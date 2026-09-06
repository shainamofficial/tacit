// Loads the generated Northwind corpus as eval sync items (the shape the real
// connectors will produce, minus the database). Rebuilds the corpus when it is
// missing or stale, and refuses to run if the generator no longer reproduces
// the committed manifest — the answer key and the corpus must agree.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import type { Acl, EvalSyncItem } from '@tacit/pipeline';
import { build, digestTree } from '../corpus/generator/build';
import type { Manifest } from '../corpus/generator/manifest';

export const EVALS_ROOT = path.resolve(import.meta.dirname, '..');
export const CORPUS_DIR = path.join(EVALS_ROOT, 'corpus', 'generated');
export const MANIFEST_PATH = path.join(EVALS_ROOT, 'corpus', 'manifest.json');
export const OUT_DIR = path.join(EVALS_ROOT, 'out');

export interface LoadedCorpus {
  readonly dir: string;
  readonly manifest: Manifest;
  readonly items: readonly EvalSyncItem[];
  /** refKey → item */
  readonly byRef: ReadonlyMap<string, EvalSyncItem>;
  /** refKey → scope key, for items whose ACL is not domain-wide */
  readonly restrictedScopeByRef: ReadonlyMap<string, string>;
  /** scope key → emails allowed (undefined = whole domain) */
  readonly scopeMembers: ReadonlyMap<string, ReadonlySet<string> | undefined>;
}

export function refKeyOf(kind: string, ref: string): string {
  return `${kind}|${ref}`;
}

export function ensureCorpus(dir: string, manifestPath: string, log: (msg: string) => void): Manifest {
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Manifest;
  const fresh = existsSync(dir) && digestTree(dir) === manifest.corpus_digest;
  if (fresh) return manifest;
  log(`corpus: (re)building Northwind into ${dir}`);
  const scratchManifest = path.join(OUT_DIR, 'generated-manifest.json');
  const result = build({ outDir: dir, manifestPath: scratchManifest, quiet: true });
  if (result.manifest.corpus_digest !== manifest.corpus_digest || result.manifest.repo_head !== manifest.repo_head) {
    throw new Error(
      `generator output does not match the committed manifest (${manifestPath}). ` +
        'Run `pnpm corpus:build` and commit the manifest if the change is intended.',
    );
  }
  return manifest;
}

interface DriveIndexEntry {
  id: string;
  title: string;
  path: string;
  modifiedTime: string;
  acl: { kind: 'domain'; domain: string } | { kind: 'users'; emails: string[] };
}

interface SlackUser {
  id: string;
  profile: { email: string };
}
interface SlackChannel {
  id: string;
  name: string;
  is_private: boolean;
  members: string[];
}
interface SlackDm {
  id: string;
  members: string[];
}
interface SlackRecord {
  user: string;
  text: string;
  ts: string;
  thread_ts?: string;
}

interface TicketJson {
  id: number;
  subject: string;
  description: string;
  updated_at: string;
  comments: Array<{ author_email: string; body: string }>;
}
interface MacroJson {
  id: number;
  title: string;
  updated_at: string;
  actions: Array<{ field: string; value: string }>;
}
interface CommitJson {
  ordinal: number;
  sha: string;
  subject: string;
  author: string;
  date: string;
}

const DOMAIN_ACL: Acl = { kind: 'domain', domain: 'northwindrobotics.example' };

function readJson<T>(file: string): T {
  return JSON.parse(readFileSync(file, 'utf8')) as T;
}

function walk(dir: string, skip: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir).sort()) {
    if (name === skip) continue;
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) out.push(...walk(full, skip));
    else out.push(full);
  }
  return out;
}

// The corpus is immutable for a given manifest, so one load per process is enough.
const cache = new Map<string, LoadedCorpus>();

export function loadCorpus(opts: { dir?: string; manifestPath?: string; log?: (msg: string) => void } = {}): LoadedCorpus {
  const dir = opts.dir ?? CORPUS_DIR;
  const manifestPath = opts.manifestPath ?? MANIFEST_PATH;
  const log = opts.log ?? (() => undefined);
  const cached = cache.get(`${dir}\0${manifestPath}`);
  if (cached) return cached;
  const loaded = loadCorpusUncached(dir, manifestPath, log);
  cache.set(`${dir}\0${manifestPath}`, loaded);
  return loaded;
}

function loadCorpusUncached(dir: string, manifestPath: string, log: (msg: string) => void): LoadedCorpus {
  const manifest = ensureCorpus(dir, manifestPath, log);

  const items: EvalSyncItem[] = [];
  const scopeMembers = new Map<string, ReadonlySet<string> | undefined>();

  // --- Drive
  for (const d of readJson<DriveIndexEntry[]>(path.join(dir, 'drive/index.json'))) {
    const scope = `gdrive:doc:${d.id}`;
    scopeMembers.set(scope, d.acl.kind === 'users' ? new Set(d.acl.emails) : undefined);
    items.push({
      id: `gdrive:${d.id}`,
      source: 'gdrive',
      kind: 'doc',
      external_ref: d.path,
      title: d.title,
      content: readFileSync(path.join(dir, d.path), 'utf8'),
      acl: d.acl,
      scope_key: scope,
      modified_at: d.modifiedTime,
    });
  }

  // --- Slack
  const users = readJson<SlackUser[]>(path.join(dir, 'slack/users.json'));
  const emailById = new Map(users.map((u) => [u.id, u.profile.email] as const));
  const conversations: Array<{ name: string; dirName: string; scope: string; acl: Acl }> = [];
  for (const c of readJson<SlackChannel[]>(path.join(dir, 'slack/channels.json'))) {
    const acl: Acl = c.is_private ? { kind: 'users', emails: c.members.map((m) => emailById.get(m) ?? m) } : DOMAIN_ACL;
    conversations.push({ name: c.name, dirName: c.name, scope: `slack:channel:${c.id}`, acl });
  }
  for (const dm of readJson<SlackDm[]>(path.join(dir, 'slack/dms.json'))) {
    conversations.push({ name: dm.id, dirName: dm.id, scope: `slack:dm:${dm.id}`, acl: { kind: 'users', emails: dm.members.map((m) => emailById.get(m) ?? m) } });
  }
  for (const conv of conversations) {
    scopeMembers.set(conv.scope, conv.acl.kind === 'users' ? new Set(conv.acl.emails) : undefined);
    const convDir = path.join(dir, 'slack', conv.dirName);
    if (!existsSync(convDir)) continue;
    for (const file of readdirSync(convDir).sort()) {
      for (const m of readJson<SlackRecord[]>(path.join(convDir, file))) {
        const ref = `${conv.name}:${m.ts}`;
        items.push({
          id: `slack:${ref}`,
          source: 'slack',
          kind: 'message',
          external_ref: ref,
          title: `#${conv.name} ${emailById.get(m.user) ?? m.user}`,
          content: m.text,
          acl: conv.acl,
          scope_key: conv.scope,
          modified_at: new Date(Number(m.ts.split('.')[0]) * 1000).toISOString(),
        });
      }
    }
  }

  // --- Zendesk (agent-visible to the whole company in this corpus)
  scopeMembers.set('zendesk:all', undefined);
  for (const m of readJson<MacroJson[]>(path.join(dir, 'zendesk/macros.json'))) {
    items.push({
      id: `zendesk:macro:${m.id}`,
      source: 'zendesk',
      kind: 'macro',
      external_ref: `macro:${m.id}`,
      title: `Macro #${m.id}: ${m.title}`,
      content: m.actions.map((a) => a.value).join('\n'),
      acl: DOMAIN_ACL,
      scope_key: 'zendesk:all',
      modified_at: m.updated_at,
    });
  }
  for (const t of readJson<TicketJson[]>(path.join(dir, 'zendesk/tickets.json'))) {
    items.push({
      id: `zendesk:ticket:${t.id}`,
      source: 'zendesk',
      kind: 'ticket',
      external_ref: `ticket:${t.id}`,
      title: `Ticket #${t.id}: ${t.subject}`,
      content: [t.description, ...t.comments.map((c) => `${c.author_email}: ${c.body}`)].join('\n\n'),
      acl: DOMAIN_ACL,
      scope_key: 'zendesk:all',
      modified_at: t.updated_at,
    });
  }

  // --- GitHub: final tree + commits
  scopeMembers.set('github:repo:northwind', undefined);
  const repoDir = path.join(dir, 'repo');
  for (const file of walk(repoDir, '.git')) {
    const rel = path.relative(repoDir, file).split(path.sep).join('/');
    items.push({
      id: `github:file:${rel}`,
      source: 'github',
      kind: 'file',
      external_ref: `repo/${rel}`,
      title: rel,
      content: readFileSync(file, 'utf8'),
      acl: DOMAIN_ACL,
      scope_key: 'github:repo:northwind',
      modified_at: manifest.now,
    });
  }
  for (const c of readJson<CommitJson[]>(path.join(dir, 'repo-commits.json'))) {
    items.push({
      id: `github:commit:${c.sha}`,
      source: 'github_commit',
      kind: 'commit',
      external_ref: c.sha,
      title: `#${c.ordinal} ${c.subject}`,
      content: `${c.subject}\n\nAuthor: ${c.author}\nDate: ${c.date}`,
      acl: DOMAIN_ACL,
      scope_key: 'github:repo:northwind',
      modified_at: c.date,
    });
  }

  const byRef = new Map(items.map((i) => [refKeyOf(i.source, i.external_ref), i] as const));
  const restrictedScopeByRef = new Map<string, string>();
  for (const i of items) {
    if (i.acl.kind === 'users') restrictedScopeByRef.set(refKeyOf(i.source, i.external_ref), i.scope_key);
  }
  log(`corpus: ${items.length} items (${restrictedScopeByRef.size} restricted)`);
  return { dir, manifest, items, byRef, restrictedScopeByRef, scopeMembers };
}

/** Can this user read an item with the given scope key? Domain-wide scopes are visible to everyone. */
export function userCanSee(corpus: LoadedCorpus, email: string, scopeKey: string): boolean {
  const members = corpus.scopeMembers.get(scopeKey);
  return members === undefined || members.has(email);
}
