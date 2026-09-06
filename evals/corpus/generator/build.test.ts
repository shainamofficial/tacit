// Acceptance criteria from SPEC §4, checked end to end on a real build.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { build, digestTree, type BuildResult } from './build';
import { EXPECTED_IDS } from './defects';
import type { Manifest } from './manifest';

const REPO_ROOT = path.resolve(import.meta.dirname, '../../..');

describe('Northwind corpus generator', () => {
  let work: string;
  let first: BuildResult;

  beforeAll(() => {
    work = mkdtempSync(path.join(tmpdir(), 'northwind-'));
    first = build({ outDir: path.join(work, 'a'), manifestPath: path.join(work, 'a.json'), quiet: true });
  }, 120_000);

  afterAll(() => {
    rmSync(work, { recursive: true, force: true });
  });

  it('is byte-identical on re-run (SPEC §4.1)', () => {
    const second = build({ outDir: path.join(work, 'b'), manifestPath: path.join(work, 'b.json'), quiet: true });
    expect(second.manifest.corpus_digest).toBe(first.manifest.corpus_digest);
    expect(second.manifest.repo_head).toBe(first.manifest.repo_head);
    expect(digestTree(second.outDir)).toBe(digestTree(first.outDir));
    expect(readFileSync(path.join(work, 'b.json'), 'utf8')).toBe(readFileSync(path.join(work, 'a.json'), 'utf8'));
  }, 120_000);

  it('covers all 55 defects with exact locations (SPEC §4.2)', () => {
    const ids = first.manifest.defects.map((d) => d.id);
    expect([...ids].sort()).toEqual([...EXPECTED_IDS].sort());
    for (const d of first.manifest.defects) {
      expect(d.sources.length, d.id).toBeGreaterThan(0);
      for (const s of d.sources) {
        if (s.kind === 'gdrive' || s.kind === 'github') expect(s.line, `${d.id} ${s.path}`).toBeGreaterThan(0);
        if (s.kind === 'slack') expect(s.ts, d.id).toMatch(/^\d+\.\d{6}$/);
        if (s.kind === 'github_commit') expect(s.sha, d.id).toMatch(/^[0-9a-f]{40}$/);
      }
    }
  });

  it('every quoted location really contains the quote', () => {
    const out = first.outDir;
    for (const d of [...first.manifest.defects, ...first.manifest.distractors]) {
      for (const s of d.sources) {
        if (s.kind === 'gdrive' || s.kind === 'github') {
          const lines = readFileSync(path.join(out, s.path), 'utf8').split('\n');
          expect(lines[s.line - 1], `${d.id} ${s.path}:${s.line}`).toContain(s.quote);
        } else if (s.kind === 'slack') {
          const msgs = JSON.parse(readFileSync(path.join(out, s.path), 'utf8')) as Array<{ ts: string; text: string }>;
          const m = msgs.find((x) => x.ts === s.ts);
          expect(m?.text, `${d.id} ${s.path} ${s.ts}`).toContain(s.quote);
        } else if (s.kind === 'zendesk') {
          const rows = JSON.parse(readFileSync(path.join(out, s.path), 'utf8')) as Array<Record<string, unknown>>;
          const row = rows.find((r) => r.id === s.id);
          expect(JSON.stringify(row), `${d.id} ${s.object} ${s.id}`).toContain(JSON.stringify(s.quote).slice(1, -1));
        }
      }
    }
  });

  it('the monorepo compiles and its git history is coherent (SPEC §4.3)', () => {
    const repo = path.join(first.outDir, 'repo');
    const tsc = path.join(REPO_ROOT, 'node_modules', 'typescript', 'bin', 'tsc');
    execFileSync(process.execPath, [tsc, '-p', path.join(repo, 'tsconfig.json'), '--typeRoots', path.join(REPO_ROOT, 'node_modules', '@types')], { stdio: 'pipe' });

    const log = execFileSync('git', ['log', '--format=%H %s', 'main'], { cwd: repo, encoding: 'utf8' }).trim().split('\n');
    expect(log).toHaveLength(150);
    for (const d of first.manifest.defects) {
      for (const s of d.sources) {
        if (s.kind === 'github_commit') expect(log, `${d.id} #${s.ordinal}`).toContain(`${s.sha} ${s.subject}`);
      }
    }
    const codeowners = readFileSync(path.join(repo, 'CODEOWNERS'), 'utf8');
    expect(codeowners).toContain('services/fleet-agent/ @jenna-ortiz');
  }, 120_000);

  it('restricted sources carry distinct ACL metadata (SPEC §4.4)', () => {
    const index = JSON.parse(readFileSync(path.join(first.outDir, 'drive/index.json'), 'utf8')) as Array<{ path: string; acl: { kind: string; emails?: string[] } }>;
    const restricted = index.filter((d) => d.acl.kind === 'users');
    expect(restricted).toHaveLength(5);
    for (const d of restricted) expect(d.acl.emails?.length).toBeGreaterThan(0);
    expect(index.filter((d) => d.acl.kind === 'domain')).toHaveLength(35);

    const channels = JSON.parse(readFileSync(path.join(first.outDir, 'slack/channels.json'), 'utf8')) as Array<{ name: string; is_private: boolean; members: string[] }>;
    const exec = channels.find((c) => c.name === 'exec');
    expect(exec?.is_private).toBe(true);
    expect(exec?.members).toHaveLength(4);
    expect(channels.find((c) => c.name === 'general')?.members).toHaveLength(28);

    for (const p of first.manifest.defects.filter((d) => d.kind === 'permission')) {
      const primary = p.sources.filter((s) => (s.kind === 'gdrive' && s.restricted !== 'none') || (s.kind === 'slack' && s.restricted));
      expect(primary.length, p.id).toBeGreaterThan(0);
    }
  });

  it('has ≥10 distractors and the SPEC volumes', () => {
    const m: Manifest = first.manifest;
    expect(m.distractors.length).toBeGreaterThanOrEqual(10);
    expect(m.counts.docs).toBe(40);
    expect(m.counts.slack_messages).toBeGreaterThanOrEqual(2000);
    expect(m.counts.slack_channels).toBe(9); // 8 channels + 1 DM
    expect(m.counts.tickets).toBe(200);
    expect(m.counts.macros).toBe(12);
    expect(m.counts.commits).toBe(150);
  });

  it('the committed manifest matches a fresh build', () => {
    const committed = JSON.parse(readFileSync(path.join(REPO_ROOT, 'evals/corpus/manifest.json'), 'utf8')) as Manifest;
    expect(committed.corpus_digest).toBe(first.manifest.corpus_digest);
    expect(committed.repo_head).toBe(first.manifest.repo_head);
  });
});
