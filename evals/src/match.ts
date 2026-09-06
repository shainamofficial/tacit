// Matching pipeline SourceRefs to manifest Locations.
import type { SourceRef } from '@tacit/pipeline';
import type { Location } from '../corpus/generator/manifest';
import { refKeyOf } from './corpus';

const LINE_TOLERANCE = 5;

export function refKey(ref: SourceRef): string {
  return refKeyOf(ref.kind, ref.ref);
}

export function locationKeys(loc: Location): string[] {
  switch (loc.kind) {
    case 'gdrive':
      return [refKeyOf('gdrive', loc.path)];
    case 'slack':
      return [refKeyOf('slack', `${loc.conversation}:${loc.ts}`)];
    case 'zendesk':
      return [refKeyOf('zendesk', `${loc.object}:${loc.id}`)];
    case 'github':
      return [refKeyOf('github', loc.path)];
    case 'github_commit':
      return [refKeyOf('github_commit', loc.sha)];
    case 'github_commit_series':
      return loc.commits.map((c) => refKeyOf('github_commit', c.sha));
  }
}

export function locationLine(loc: Location): number | undefined {
  return loc.kind === 'gdrive' || loc.kind === 'github' ? loc.line : undefined;
}

export function locationQuote(loc: Location): string | undefined {
  return 'quote' in loc ? loc.quote : undefined;
}

export function refMatchesLocation(ref: SourceRef, loc: Location): boolean {
  if (!locationKeys(loc).includes(refKey(ref))) return false;
  const line = locationLine(loc);
  if (ref.line === undefined || line === undefined) return true;
  return Math.abs(ref.line - line) <= LINE_TOLERANCE;
}

/** Docs side of a drift pair: Drive docs, Zendesk macros, or markdown inside the repo. */
export function isDocSide(loc: Location): boolean {
  if (loc.kind === 'gdrive' || loc.kind === 'zendesk' || loc.kind === 'slack') return true;
  if (loc.kind === 'github') return loc.path.endsWith('.md');
  return false;
}

/** Code side of a drift pair: non-markdown repo files and commits. */
export function isCodeSide(loc: Location): boolean {
  if (loc.kind === 'github') return !loc.path.endsWith('.md');
  return loc.kind === 'github_commit' || loc.kind === 'github_commit_series';
}

export function coveredLocations(refs: readonly SourceRef[], locations: readonly Location[]): Location[] {
  return locations.filter((loc) => refs.some((ref) => refMatchesLocation(ref, loc)));
}
