// `pnpm eval [--stage=<filter|extract|draft|judge|contradict|drift|serve|all>] [--json] [--out=<file>]`
//
// The CI gate (F-CMP-4, CLAUDE.md #1). Exit 0 only when every scored metric
// meets evals/golden/thresholds.json and there are zero permission leaks.
// With no pipeline stages implemented this fails on purpose: main stays red
// until the pipeline earns green.
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { EVALS_ROOT, OUT_DIR } from './src/corpus';
import { STAGE_FILTERS, renderScorecard, runEval, type StageFilter } from './src/runner';

// Local convenience: credentials and DATABASE_URL from the repo-root .env (CI sets its own).
try {
  process.loadEnvFile(path.join(EVALS_ROOT, '..', '.env'));
} catch {
  // no .env: rely on the process environment
}
// Stage outputs are cached on disk so iterating on one stage never re-pays for the ones before it (F-CMP-5).
process.env.TACIT_STAGE_CACHE_DIR ??= path.join(OUT_DIR, 'stage-cache');

function arg(name: string): string | undefined {
  return process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
}

const stageArg = arg('stage') ?? 'all';
if (!STAGE_FILTERS.includes(stageArg as StageFilter)) {
  console.error(`unknown --stage=${stageArg}; expected one of ${STAGE_FILTERS.join(', ')}`);
  process.exit(2);
}
const json = process.argv.includes('--json');
const outFile = arg('out') ?? path.join(OUT_DIR, 'scorecard.json');

const scorecard = await runEval({
  stage: stageArg as StageFilter,
  log: json ? () => undefined : (msg) => console.error(msg),
});

mkdirSync(path.dirname(outFile), { recursive: true });
writeFileSync(outFile, `${JSON.stringify(scorecard, null, 2)}\n`);

if (json) console.log(JSON.stringify(scorecard, null, 2));
else {
  console.log(renderScorecard(scorecard));
  console.log(`\nscorecard json: ${outFile}`);
}
process.exitCode = scorecard.pass ? 0 : 1;
