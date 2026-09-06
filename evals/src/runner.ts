// The eval harness (implementation-plan §4, F-CMP-4): feed the Northwind
// corpus through whatever pipeline stages exist, grade against the manifest,
// and decide pass/fail against evals/golden/thresholds.json.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { complete as gatewayComplete, type CompleteFn } from '@tacit/gateway';
import {
  STAGE_ORDER,
  ZERO_USAGE,
  evalPipeline,
  type EvalArtifact,
  type EvalPipeline,
  type Finding,
  type StageName,
  type StageUsage,
} from '@tacit/pipeline';
import { z } from 'zod';
import { SEED } from '../corpus/generator/world';
import { EVALS_ROOT, loadCorpus, type LoadedCorpus } from './corpus';
import { judgeFactuality } from './factuality';
import { ProbesSchema, checkArtifacts, probeServe, type Leak } from './permission';
import { scoreContradictions, scoreDrift, scoreTribal, type ContradictionScore, type DriftScore, type TribalScore } from './score';

export type StageFilter = StageName | 'serve' | 'all';
export const STAGE_FILTERS: readonly StageFilter[] = [...STAGE_ORDER, 'serve', 'all'];

export const ThresholdsSchema = z.object({
  contradiction_recall: z.number().min(0).max(1),
  contradiction_precision: z.number().min(0).max(1),
  drift_recall: z.number().min(0).max(1),
  tribal_surfaced_with_knower: z.number().min(0).max(1),
  false_assertions_max: z.number().int().min(0),
  permission_leaks_max: z.literal(0),
  factuality: z.number().min(0).max(1),
  compile_cost_usd_max: z.number().positive(),
});
export type Thresholds = z.infer<typeof ThresholdsSchema>;

export interface Metric {
  readonly key: string;
  readonly label: string;
  /** null = not measurable (no findings/artifacts, or gateway unavailable) */
  readonly value: number | null;
  readonly display: string;
  readonly target: string;
  /** whether this metric counts toward pass/fail for the requested stage */
  readonly scored: boolean;
  readonly pass: boolean;
  readonly note?: string;
}

export interface StageReport {
  readonly name: StageName;
  readonly implemented: boolean;
  readonly ran: boolean;
  readonly artifacts: number;
  readonly findings: number;
  readonly usage: StageUsage;
}

export interface Scorecard {
  readonly stage: StageFilter;
  readonly corpus: { items: number; digest: string; repo_head: string };
  readonly stages: readonly StageReport[];
  readonly metrics: readonly Metric[];
  readonly leaks: readonly Leak[];
  readonly cost_usd: number;
  readonly pass: boolean;
  readonly failures: readonly string[];
  readonly notes: readonly string[];
  readonly detail: {
    contradictions: ContradictionScore;
    drift: DriftScore;
    tribal: TribalScore;
    factuality: { judged: number; supported: number; unsupported: ReadonlyArray<{ artifact_id: string; claim: string; reason: string }> };
    serve_probes: number;
  };
}

export interface RunOptions {
  readonly stage?: StageFilter;
  readonly corpusDir?: string;
  readonly manifestPath?: string;
  readonly thresholdsPath?: string;
  readonly probesPath?: string;
  readonly pipeline?: EvalPipeline;
  readonly complete?: CompleteFn;
  readonly budgetUsd?: number;
  readonly factualitySample?: number;
  readonly log?: (msg: string) => void;
}

export const DEFAULT_THRESHOLDS_PATH = path.join(EVALS_ROOT, 'golden', 'thresholds.json');
export const DEFAULT_PROBES_PATH = path.join(EVALS_ROOT, 'golden', 'permission-probes.json');

export function loadThresholds(file = DEFAULT_THRESHOLDS_PATH): Thresholds {
  return ThresholdsSchema.parse(JSON.parse(readFileSync(file, 'utf8')));
}

const pct = (v: number | null): string => (v === null ? 'n/a' : `${(v * 100).toFixed(1)}%`);

function stagesToRun(filter: StageFilter): StageName[] {
  if (filter === 'all' || filter === 'serve') return [...STAGE_ORDER];
  return STAGE_ORDER.slice(0, STAGE_ORDER.indexOf(filter) + 1);
}

/** Which metric keys count toward pass/fail for a given --stage. Permission and cost always count. */
function scoredKeys(filter: StageFilter): ReadonlySet<string> {
  const always = ['permission_leaks', 'compile_cost_usd'];
  switch (filter) {
    case 'filter':
    case 'extract':
      return new Set(always);
    case 'draft':
      return new Set([...always, 'factuality']);
    case 'judge':
      return new Set([...always, 'factuality', 'false_assertions']);
    case 'contradict':
      return new Set([...always, 'contradiction_recall', 'contradiction_precision', 'tribal_surfaced_with_knower', 'false_assertions']);
    case 'drift':
      return new Set([...always, 'drift_recall']);
    case 'serve':
      return new Set(always);
    case 'all':
      return new Set([
        ...always,
        'contradiction_recall',
        'contradiction_precision',
        'drift_recall',
        'tribal_surfaced_with_knower',
        'false_assertions',
        'factuality',
      ]);
  }
}

export async function runEval(opts: RunOptions = {}): Promise<Scorecard> {
  const log = opts.log ?? (() => undefined);
  const filter = opts.stage ?? 'all';
  const pipeline = opts.pipeline ?? evalPipeline;
  const complete = opts.complete ?? gatewayComplete;
  const thresholds = loadThresholds(opts.thresholdsPath);
  const probes = ProbesSchema.parse(JSON.parse(readFileSync(opts.probesPath ?? DEFAULT_PROBES_PATH, 'utf8')));
  const corpus: LoadedCorpus = loadCorpus({ log, ...(opts.corpusDir ? { dir: opts.corpusDir } : {}), ...(opts.manifestPath ? { manifestPath: opts.manifestPath } : {}) });
  const notes: string[] = [];

  // --- run stages in order
  let artifacts: EvalArtifact[] = [];
  let findings: Finding[] = [];
  let cost = 0;
  const stageReports: StageReport[] = [];
  const budget = opts.budgetUsd ?? thresholds.compile_cost_usd_max;
  for (const name of STAGE_ORDER) {
    const runner = pipeline.stages[name];
    const shouldRun = stagesToRun(filter).includes(name);
    if (!runner || !shouldRun) {
      stageReports.push({ name, implemented: Boolean(runner), ran: false, artifacts: 0, findings: 0, usage: ZERO_USAGE });
      continue;
    }
    log(`stage ${name}: running`);
    const result = await runner({ org_id: 'northwind', items: corpus.items, artifacts, findings, budget_usd: budget - cost });
    artifacts = [...artifacts, ...result.artifacts];
    findings = [...findings, ...result.findings];
    cost += result.usage.cost_usd;
    stageReports.push({ name, implemented: true, ran: true, artifacts: result.artifacts.length, findings: result.findings.length, usage: result.usage });
    if (cost > budget) {
      notes.push(`budget exceeded after ${name}: $${cost.toFixed(2)} > $${budget.toFixed(2)}; later stages skipped`);
      break;
    }
  }
  const missing = stageReports.filter((s) => !s.implemented).map((s) => s.name);
  if (missing.length > 0) notes.push(`stages not implemented: ${missing.join(', ')}`);

  // --- grade
  const contradictions = scoreContradictions(corpus.manifest.defects, findings);
  const drift = scoreDrift(corpus.manifest.defects, findings);
  const tribal = scoreTribal(corpus.manifest.defects, findings, artifacts);
  const factuality = await judgeFactuality(artifacts, corpus, { sample: opts.factualitySample ?? 20, seed: SEED, complete });
  cost += factuality.cost_usd;
  if (factuality.note) notes.push(`factuality: ${factuality.note}`);

  const leaks: Leak[] = checkArtifacts(artifacts, corpus);
  let probed = 0;
  if (filter === 'all' || filter === 'serve') {
    const serve = await probeServe(pipeline, artifacts, probes, corpus);
    probed = serve.probed;
    leaks.push(...serve.leaks);
    if (!pipeline.serve) notes.push('serve path not implemented; permission probes skipped (artifact scopes still checked)');
  }

  const scored = scoredKeys(filter);
  const metric = (key: string, label: string, value: number | null, display: string, target: string, pass: boolean, note?: string): Metric => ({
    key,
    label,
    value,
    display,
    target,
    scored: scored.has(key),
    pass,
    ...(note ? { note } : {}),
  });
  const gte = (v: number | null, t: number): boolean => v !== null && v >= t;

  const metrics: Metric[] = [
    metric('contradiction_recall', 'Contradiction recall', contradictions.recall, `${contradictions.matched}/${contradictions.defects} (${pct(contradictions.recall)})`, `≥ ${pct(thresholds.contradiction_recall)}`, gte(contradictions.recall, thresholds.contradiction_recall)),
    metric('contradiction_precision', 'Contradiction precision', contradictions.precision, contradictions.precision === null ? 'n/a (no findings)' : `${contradictions.true_positives}/${contradictions.findings} (${pct(contradictions.precision)})`, `≥ ${pct(thresholds.contradiction_precision)}`, gte(contradictions.precision, thresholds.contradiction_precision)),
    metric('drift_recall', 'Drift recall', drift.recall, `${drift.matched}/${drift.defects} (${pct(drift.recall)})`, `≥ ${pct(thresholds.drift_recall)}`, gte(drift.recall, thresholds.drift_recall)),
    metric('tribal_surfaced_with_knower', 'Tribal gaps surfaced w/ knower', tribal.surfaced_with_knower, `${tribal.with_knower}/${tribal.defects} (${pct(tribal.surfaced_with_knower)}; ${tribal.surfaced} surfaced)`, `≥ ${pct(thresholds.tribal_surfaced_with_knower)}`, gte(tribal.surfaced_with_knower, thresholds.tribal_surfaced_with_knower)),
    metric('false_assertions', 'False assertions of tribal facts', tribal.false_assertions.length, String(tribal.false_assertions.length), `≤ ${thresholds.false_assertions_max}`, tribal.false_assertions.length <= thresholds.false_assertions_max),
    metric('permission_leaks', 'Permission leaks', leaks.length, `${leaks.length} (${artifacts.length} artifacts checked, ${probed} probes)`, '= 0', leaks.length === 0, leaks.length > 0 ? 'STOP THE LINE' : undefined),
    metric('factuality', 'Artifact factuality', factuality.value, factuality.value === null ? 'n/a' : `${factuality.supported}/${factuality.judged} (${pct(factuality.value)})`, `≥ ${pct(thresholds.factuality)}`, gte(factuality.value, thresholds.factuality), factuality.note),
    metric('compile_cost_usd', '$/compile', cost, `$${cost.toFixed(2)}`, `≤ $${thresholds.compile_cost_usd_max.toFixed(2)}`, cost <= thresholds.compile_cost_usd_max),
  ];

  const failures = metrics.filter((m) => m.scored && !m.pass).map((m) => `${m.label}: ${m.display} (target ${m.target})`);
  const pass = failures.length === 0 && leaks.length === 0;

  return {
    stage: filter,
    corpus: { items: corpus.items.length, digest: corpus.manifest.corpus_digest, repo_head: corpus.manifest.repo_head },
    stages: stageReports,
    metrics,
    leaks,
    cost_usd: cost,
    pass,
    failures,
    notes,
    detail: {
      contradictions,
      drift,
      tribal,
      factuality: { judged: factuality.judged, supported: factuality.supported, unsupported: factuality.unsupported },
      serve_probes: probed,
    },
  };
}

export function renderScorecard(sc: Scorecard): string {
  const lines: string[] = [];
  lines.push(`Northwind scorecard  (stage: ${sc.stage}; ${sc.corpus.items} items; corpus ${sc.corpus.digest.slice(0, 12)}, repo ${sc.corpus.repo_head.slice(0, 12)})`);
  lines.push('');
  const w = Math.max(...sc.metrics.map((m) => m.label.length));
  for (const m of sc.metrics) {
    const status = !m.scored ? 'skip' : m.pass ? 'PASS' : 'FAIL';
    lines.push(`  ${m.label.padEnd(w)}  ${m.display.padEnd(34)}  ${m.target.padEnd(10)}  ${status}${m.note ? `  (${m.note})` : ''}`);
  }
  lines.push('');
  const ran = sc.stages.filter((s) => s.ran);
  lines.push(`  stages: ${sc.stages.map((s) => `${s.name}${s.ran ? '✓' : s.implemented ? '·' : '✗'}`).join(' ')}   (✓ ran, · implemented but filtered out, ✗ not implemented)`);
  if (ran.length > 0) {
    for (const s of ran) lines.push(`    ${s.name}: ${s.artifacts} artifacts, ${s.findings} findings, ${s.usage.model_calls} calls, $${s.usage.cost_usd.toFixed(2)}`);
  }
  for (const n of sc.notes) lines.push(`  note: ${n}`);
  for (const l of sc.leaks) lines.push(`  LEAK [${l.kind}]${l.defect_id ? ` ${l.defect_id}` : ''}: ${l.detail}`);
  lines.push('');
  lines.push(sc.pass ? 'RESULT: PASS' : `RESULT: FAIL — ${sc.leaks.length > 0 ? `${sc.leaks.length} permission leak(s); ` : ''}${sc.failures.length} threshold(s) unmet`);
  return lines.join('\n');
}
