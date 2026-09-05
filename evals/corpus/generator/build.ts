// `pnpm corpus:build [--out=<dir>] [--manifest=<path>]`
//
// Generates the Northwind Robotics corpus (SPEC §2) deterministically from
// SEED and writes evals/corpus/manifest.json. Re-runs are byte-identical; the
// manifest's corpus_digest and repo_head make that checkable in CI.
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { buildDrive } from './docs';
import { buildManifest, type CommitRef, type Manifest } from './manifest';
import { buildCommits, fastImportStream, finalTree } from './repo';
import { Rng } from './rng';
import { buildSlack } from './slack';
import { buildZendesk, serializeMacros, serializeTickets } from './zendesk';
import { SEED, person } from './world';

export interface BuildOptions {
  readonly outDir: string;
  readonly manifestPath: string;
  readonly quiet?: boolean;
}

export interface BuildResult {
  readonly manifest: Manifest;
  readonly outDir: string;
}

const CORPUS_ROOT = path.resolve(import.meta.dirname, '..');

function writeText(file: string, content: string): void {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, content.replace(/\r\n/g, '\n'), 'utf8');
}

function writeJson(file: string, value: unknown): void {
  writeText(file, `${JSON.stringify(value, null, 2)}\n`);
}

function git(cwd: string, args: string[], input?: Buffer): string {
  return execFileSync('git', args, {
    cwd,
    input,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' },
  }).trim();
}

/** sha256 over (path, content) of every file under dir, excluding repo/.git. */
export function digestTree(dir: string): string {
  const hash = createHash('sha256');
  const walk = (d: string): void => {
    for (const name of readdirSync(d).sort()) {
      const full = path.join(d, name);
      const rel = path.relative(dir, full).split(path.sep).join('/');
      if (rel === 'repo/.git') continue;
      if (statSync(full).isDirectory()) {
        walk(full);
      } else {
        hash.update(`${rel}\0`);
        hash.update(readFileSync(full));
        hash.update('\0');
      }
    }
  };
  walk(dir);
  return hash.digest('hex');
}

export function build(opts: BuildOptions): BuildResult {
  const log = (msg: string): void => {
    if (!opts.quiet) console.log(msg);
  };
  const rng = new Rng(SEED);
  const out = path.resolve(opts.outDir);
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });

  // --- Drive
  const docs = buildDrive(rng);
  for (const d of docs) writeText(path.join(out, d.path), d.body);
  writeJson(
    path.join(out, 'drive/index.json'),
    docs.map((d) => ({
      id: d.id,
      title: d.title,
      path: d.path,
      folder: d.folder,
      mimeType: 'application/vnd.google-apps.document',
      modifiedTime: d.modifiedAt.toISOString(),
      owners: [person(d.owner).email],
      acl:
        d.restricted === 'none'
          ? { kind: 'domain', domain: 'northwindrobotics.example' }
          : { kind: 'users', emails: (d.restricted === 'finance' ? ['tom', 'alice', 'elif'] : ['alice', 'tom', 'sofia', 'jenna']).map((k) => person(k as never).email) },
    })),
  );
  log(`drive: ${docs.length} docs (${docs.filter((d) => d.restricted !== 'none').length} restricted)`);

  // --- Slack
  const slack = buildSlack(rng);
  for (const f of slack.files) writeJson(path.join(out, f.path), f.json);
  log(`slack: ${slack.messages.length} messages in ${slack.files.length} files`);

  // --- Zendesk
  const zd = buildZendesk(rng);
  writeJson(path.join(out, 'zendesk/macros.json'), serializeMacros(zd.macros));
  writeJson(path.join(out, 'zendesk/tickets.json'), serializeTickets(zd.tickets));
  log(`zendesk: ${zd.tickets.length} tickets, ${zd.macros.length} macros`);

  // --- Repo (git fast-import)
  const commits = buildCommits(rng);
  const repoDir = path.join(out, 'repo');
  mkdirSync(repoDir, { recursive: true });
  git(repoDir, ['init', '-q', '-b', 'main']);
  git(repoDir, ['config', 'core.autocrlf', 'false']);
  git(repoDir, ['config', 'user.name', 'Northwind Bot']);
  git(repoDir, ['config', 'user.email', 'bot@northwindrobotics.example']);
  git(repoDir, ['fast-import', '--quiet'], fastImportStream(commits));
  git(repoDir, ['reset', '-q', '--hard', 'main']);
  const shas = git(repoDir, ['rev-list', '--reverse', 'main']).split('\n');
  if (shas.length !== commits.length) throw new Error(`expected ${commits.length} commits, git has ${shas.length}`);
  const commitRefs: CommitRef[] = commits.map((c, i) => ({
    ordinal: c.ordinal,
    sha: shas[i] ?? '',
    subject: c.subject,
    author: person(c.author).email,
    date: c.at.toISOString(),
  }));
  writeJson(path.join(out, 'repo-commits.json'), commitRefs);
  const head = shas[shas.length - 1] ?? '';
  log(`repo: ${commits.length} commits, head ${head.slice(0, 12)}`);

  // --- Manifest
  const digest = digestTree(out);
  const manifest = buildManifest(
    { docs, slack: slack.messages, macros: zd.macros, tickets: zd.tickets, tree: finalTree(commits), commits: commitRefs },
    head,
    digest,
  );
  writeJson(path.resolve(opts.manifestPath), manifest);
  log(`manifest: ${manifest.defects.length} defects, ${manifest.distractors.length} distractors → ${opts.manifestPath}`);
  return { manifest, outDir: out };
}

function parseArgs(argv: readonly string[]): BuildOptions {
  const get = (flag: string): string | undefined => argv.find((a) => a.startsWith(`--${flag}=`))?.slice(flag.length + 3);
  return {
    outDir: get('out') ?? path.join(CORPUS_ROOT, 'generated'),
    manifestPath: get('manifest') ?? path.join(CORPUS_ROOT, 'manifest.json'),
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
  build(parseArgs(process.argv.slice(2)));
}
