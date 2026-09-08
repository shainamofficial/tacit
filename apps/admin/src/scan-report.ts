// `pnpm scan-report --viewer=<email> [--data=<snapshot dir>] [--out=<file.html>] [--github=<blob base url>]`
// Renders the contradiction-scan report (F-ADM-4) for one viewer from a serve
// snapshot written by `pnpm eval --serve-out=<dir>`. The viewer's scopes come
// from the snapshot's connector ACLs; the report shows only what they can read.
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { SnapshotStore, renderScanReport, type LinkResolver } from '@tacit/artifacts';
import { SCAN_REPORT_ASSUMPTIONS } from '@tacit/config/scan-report';

function arg(name: string): string | undefined {
  return process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
}

const viewer = arg('viewer');
if (!viewer) {
  console.error('usage: pnpm scan-report --viewer=<email> [--data=<dir>] [--out=<file>] [--github=<https://github.com/org/repo/blob/main>]');
  process.exit(2);
}
const root = path.resolve(import.meta.dirname, '../../..');
const dataDir = arg('data') ?? path.join(root, 'evals/out/serve');
const out = arg('out') ?? path.join(root, 'evals/out', `scan-report-${viewer.split('@')[0]}.html`);
const githubBase = arg('github');

const store = SnapshotStore.load(dataDir);
const snap = store.snapshot;
const scopes = await store.scopesFor(snap.org_id, viewer);
const link: LinkResolver = (ref) => {
  if (!githubBase) return null;
  if (ref.kind === 'github') return `${githubBase.replace(/\/$/, '')}/${ref.ref.replace(/^repo\//, '')}${ref.line ? `#L${ref.line}` : ''}`;
  if (ref.kind === 'github_commit') return `${githubBase.replace(/\/blob\/.*$/, '')}/commit/${ref.ref}`;
  return null;
};
const report = renderScanReport({
  orgName: snap.org_name ?? 'Your company',
  generatedAt: new Date().toISOString(),
  viewer: { email: viewer, scopes },
  findings: snap.findings ?? [],
  items: snap.items,
  ...(snap.people ? { people: snap.people } : {}),
  assumptions: SCAN_REPORT_ASSUMPTIONS,
  link,
});
mkdirSync(path.dirname(out), { recursive: true });
writeFileSync(out, report.html);
console.error(JSON.stringify({ event: 'scan_report', viewer, out, ...report.stats }));
