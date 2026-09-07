// The eval harness (implementation-plan §4, F-CMP-4): feed the Northwind
// corpus through whatever pipeline stages exist, grade against the manifest,
// and decide pass/fail against evals/golden/thresholds.json.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { complete as gatewayComplete, type CompleteFn } from '@tacit/gateway';
import {
  STAGE_ORDER,
  cachedGatewayComplete,
  ZERO_USAGE,
  evalPipeline,
  type EvalArtifact,
  type EvalPipeline,
  type EvalSyncItem,
  type ExtractedClaim,
  type Finding,
  type StageName,
  type StageUsage,
} from '@tacit/pipeline';
import { z } from 'zod';
import { SEED } from '../corpus/generator/world';
import { judgeFalseAssertions } from './assertions';
import { EVALS_ROOT, loadCorpus, type LoadedCorpus } from './corpus';
import { scoreExtract, type ExtractScore } from './extract';
import { judgeFactuality } from './factuality';
import { scoreFilter, type FilterScore } from './filter';
import { ProbesSchema, checkArtifacts, probeServe, type Leak } from './permission';
import { openEvalRun } from './run-record';
import { scoreContradictions, scoreDrift, scoreTribal, type ContradictionScore, type DriftScore, type TribalScore } from './score';

export type StageFilter = StageName | 'serve' | 'all';
export const STAGE_FILTERS: readonly StageFilter[] = [...STAGE_ORDER, 'serve', 'all'];

export const ThresholdsSchema = z.object({
  filter_signal_recall: z.number().min(0).max(1),
  filter_noise_rejection: z.number().min(0).max(1),
  extract_source_coverage: z.number().min(0).max(1),
  draft_source_coverage: z.number().min(0).max(1),
  contradiction_recall: z.number().min(0).max(1),
  contradiction_precision: z.number().min(0).max(1),
  drift_recall: z.number().min(0).max(1),
  tribal_surfaced_with_knower: z.number().min(0).max(1),
  false_assertions_max: z.number().int().min(0),
  permission_leaks_max: z.literal(0),
  factuality: z.number().min(0).max(1),
  /** claims sampled for the rubric judge; larger = less noisy, ~2 cents per claim */
  factuality_sample: z.number().int().positive(),
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
  /** items passed on to the next stage, when the stage narrows the set */
  readonly kept: number | null;
  readonly claims: number;
  readonly usage: StageUsage;
  readonly error?: string;
  readonly notes: readonly string[];
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
    filter: FilterScore;
    extract: ExtractScore;
    draft: ExtractScore;
    contradictions: ContradictionScore;
    drift: DriftScore;
    tribal: TribalScore;
    false_assertions: ReadonlyArray<{ defect_id: string; artifact_id: string; claim: string; reason: string }>;
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
  readonly runId?: string;
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
  const filterKeys = ['filter_signal_recall', 'filter_noise_rejection'];
  switch (filter) {
    case 'filter':
      return new Set([...always, ...filterKeys]);
    case 'extract':
      return new Set([...always, 'extract_source_coverage', 'factuality']);
    case 'draft':
      return new Set([...always, 'draft_source_coverage', 'factuality']);
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
        ...filterKeys,
        'extract_source_coverage',
        'draft_source_coverage',
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
  // Judge calls go through the same disk cache as the stages (F-CMP-5), so re-runs are free.
  const complete = opts.complete ?? cachedGatewayComplete(gatewayComplete);
  const thresholds = loadThresholds(opts.thresholdsPath);
  const probes = ProbesSchema.parse(JSON.parse(readFileSync(opts.probesPath ?? DEFAULT_PROBES_PATH, 'utf8')));
  const corpus: LoadedCorpus = loadCorpus({ log, ...(opts.corpusDir ? { dir: opts.corpusDir } : {}), ...(opts.manifestPath ? { manifestPath: opts.manifestPath } : {}) });
  const notes: string[] = [];
  const budget = opts.budgetUsd ?? thresholds.compile_cost_usd_max;
  // A real pipeline_runs row when a database is present, so model_calls logging has valid FKs.
  const run = opts.runId ? { orgId: 'northwind', runId: opts.runId, close: async () => undefined } : await openEvalRun(filter, budget);
  const runId = run.runId;

  // --- run stages in order
  let items: readonly EvalSyncItem[] = corpus.items;
  let filtered: readonly EvalSyncItem[] | null = null;
  let claims: ExtractedClaim[] = [];
  let extracted: readonly ExtractedClaim[] | null = null;
  let artifacts: EvalArtifact[] = [];
  let findings: Finding[] = [];
  let cost = 0;
  const stageReports: StageReport[] = [];
  for (const name of STAGE_ORDER) {
    const runner = pipeline.stages[name];
    const shouldRun = stagesToRun(filter).includes(name);
    if (!runner || !shouldRun) {
      stageReports.push({ name, implemented: Boolean(runner), ran: false, artifacts: 0, findings: 0, kept: null, claims: 0, usage: ZERO_USAGE, notes: [] });
      continue;
    }
    log(`stage ${name}: running on ${items.length} items`);
    try {
      // The gateway ledger tracks live spend per run_id and enforces the cap itself, so pass the
      // run's total budget (passing the remainder would double-count earlier stages).
      const result = await runner({ org_id: run.orgId, run_id: runId, items, claims, artifacts, findings, budget_usd: budget });
      artifacts = [...artifacts, ...result.artifacts];
      findings = [...findings, ...result.findings];
      cost += result.usage.cost_usd;
      if (result.items) {
        items = result.items;
        if (name === 'filter') filtered = result.items;
      }
      if (result.claims) {
        claims = [...claims, ...result.claims];
        if (name === 'extract') extracted = result.claims;
      }
      stageReports.push({ name, implemented: true, ran: true, artifacts: result.artifacts.length, findings: result.findings.length, kept: result.items ? result.items.length : null, claims: result.claims?.length ?? 0, usage: result.usage, notes: result.notes ?? [] });
      if (cost > budget) {
        notes.push(`budget exceeded after ${name}: $${cost.toFixed(2)} > $${budget.toFixed(2)}; later stages skipped`);
        break;
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      stageReports.push({ name, implemented: true, ran: true, artifacts: 0, findings: 0, kept: null, claims: 0, usage: ZERO_USAGE, error: message, notes: [] });
      notes.push(`stage ${name} failed: ${message}; later stages skipped`);
      break;
    }
  }
  for (const name of STAGE_ORDER) {
    if (!stageReports.some((s) => s.name === name)) {
      stageReports.push({ name, implemented: Boolean(pipeline.stages[name]), ran: false, artifacts: 0, findings: 0, kept: null, claims: 0, usage: ZERO_USAGE, notes: [] });
    }
  }
  const missing = stageReports.filter((s) => !s.implemented).map((s) => s.name);
  if (missing.length > 0) notes.push(`stages not implemented: ${missing.join(', ')}`);

  // --- grade
  const filterScore = scoreFilter(corpus, filtered);
  const extractScore = scoreExtract(corpus, extracted);
  const draftScore = scoreExtract(corpus, stageReports.some((s) => s.name === 'draft' && s.ran && !s.error) ? artifacts.flatMap((a) => a.claims) : null);
  const contradictions = scoreContradictions(corpus.manifest.defects, findings);
  const drift = scoreDrift(corpus.manifest.defects, findings);
  const tribal = scoreTribal(corpus.manifest.defects, findings, artifacts);
  // Provenance overlap only nominates candidates; the judge decides which ones actually assert the unwritten rule.
  const assertions = await judgeFalseAssertions(tribal.false_assertions, corpus.manifest.defects, complete);
  cost += assertions.cost_usd;
  if (assertions.note) notes.push(`false assertions: ${assertions.note}`);
  // Until draft/judge exist, factuality is judged on extracted claims (each wrapped as a one-claim artifact).
  const judged: EvalArtifact[] =
    artifacts.length > 0
      ? artifacts
      : claims.map((c) => ({ id: c.id, type: 'claim', title: c.subject, body_md: c.text, claims: [{ text: c.text, provenance: c.provenance, confidence: c.confidence }], permission_scope: { require_all: [c.scope_key] }, verification_state: 'unverified' as const }));
  const factuality = await judgeFactuality(judged, corpus, { sample: opts.factualitySample ?? thresholds.factuality_sample, seed: SEED, complete });
  cost += factuality.cost_usd;
  if (factuality.note) notes.push(`factuality: ${factuality.note}`);
  if (artifacts.length === 0 && claims.length > 0) notes.push(`factuality judged on a sample of ${judged.length} extracted claims (no artifacts yet)`);

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
    metric('filter_signal_recall', 'Filter: signal recall', filterScore.signal_recall, filterScore.signal_recall === null ? 'n/a' : `${filterScore.must_keep_kept}/${filterScore.must_keep} (${pct(filterScore.signal_recall)})`, `≥ ${pct(thresholds.filter_signal_recall)}`, gte(filterScore.signal_recall, thresholds.filter_signal_recall), filterScore.dropped_signal.length ? `dropped: ${filterScore.dropped_signal.slice(0, 5).join(', ')}${filterScore.dropped_signal.length > 5 ? '…' : ''}` : undefined),
    metric('filter_noise_rejection', 'Filter: noise rejection', filterScore.noise_rejection, filterScore.noise_rejection === null ? 'n/a' : `${filterScore.noise - filterScore.noise_kept}/${filterScore.noise} (${pct(filterScore.noise_rejection)})`, `≥ ${pct(thresholds.filter_noise_rejection)}`, gte(filterScore.noise_rejection, thresholds.filter_noise_rejection)),
    metric('extract_source_coverage', 'Extract: source coverage', extractScore.source_coverage, extractScore.source_coverage === null ? 'n/a' : `${extractScore.covered}/${extractScore.locations} (${pct(extractScore.source_coverage)}; ${extractScore.claims} claims)`, `≥ ${pct(thresholds.extract_source_coverage)}`, gte(extractScore.source_coverage, thresholds.extract_source_coverage), extractScore.uncovered_sample.length ? `uncovered: ${extractScore.uncovered_sample.slice(0, 4).join('; ')}${extractScore.uncovered_sample.length > 4 ? '…' : ''}` : undefined),
    metric('draft_source_coverage', 'Draft: source coverage', draftScore.source_coverage, draftScore.source_coverage === null ? 'n/a' : `${draftScore.covered}/${draftScore.locations} (${pct(draftScore.source_coverage)}; ${artifacts.length} artifacts)`, `≥ ${pct(thresholds.draft_source_coverage)}`, gte(draftScore.source_coverage, thresholds.draft_source_coverage), draftScore.uncovered_sample.length ? `uncovered: ${draftScore.uncovered_sample.slice(0, 4).join('; ')}${draftScore.uncovered_sample.length > 4 ? '…' : ''}` : undefined),
    metric('contradiction_recall', 'Contradiction recall', contradictions.recall, `${contradictions.matched}/${contradictions.defects} (${pct(contradictions.recall)})`, `≥ ${pct(thresholds.contradiction_recall)}`, gte(contradictions.recall, thresholds.contradiction_recall)),
    metric('contradiction_precision', 'Contradiction precision', contradictions.precision, contradictions.precision === null ? 'n/a (no findings)' : `${contradictions.true_positives}/${contradictions.findings} (${pct(contradictions.precision)})`, `≥ ${pct(thresholds.contradiction_precision)}`, gte(contradictions.precision, thresholds.contradiction_precision)),
    metric('drift_recall', 'Drift recall', drift.recall, `${drift.matched}/${drift.defects} (${pct(drift.recall)})`, `≥ ${pct(thresholds.drift_recall)}`, gte(drift.recall, thresholds.drift_recall)),
    metric('tribal_surfaced_with_knower', 'Tribal gaps surfaced w/ knower', tribal.surfaced_with_knower, `${tribal.with_knower}/${tribal.defects} (${pct(tribal.surfaced_with_knower)}; ${tribal.surfaced} surfaced)`, `≥ ${pct(thresholds.tribal_surfaced_with_knower)}`, gte(tribal.surfaced_with_knower, thresholds.tribal_surfaced_with_knower)),
    metric('false_assertions', 'False assertions of tribal facts', assertions.asserted.length, `${assertions.asserted.length} (${assertions.candidates} candidates judged)`, `≤ ${thresholds.false_assertions_max}`, assertions.asserted.length <= thresholds.false_assertions_max, assertions.asserted.length ? `e.g. ${assertions.asserted[0]?.defect_id}: ${assertions.asserted[0]?.claim.slice(0, 80)}` : undefined),
    metric('permission_leaks', 'Permission leaks', leaks.length, `${leaks.length} (${artifacts.length} artifacts checked, ${probed} probes)`, '= 0', leaks.length === 0, leaks.length > 0 ? 'STOP THE LINE' : undefined),
    metric('factuality', 'Artifact factuality', factuality.value, factuality.value === null ? 'n/a' : `${factuality.supported}/${factuality.judged} (${pct(factuality.value)})`, `≥ ${pct(thresholds.factuality)}`, gte(factuality.value, thresholds.factuality), factuality.note),
    metric('compile_cost_usd', '$/compile', cost, `$${cost.toFixed(2)}`, `≤ $${thresholds.compile_cost_usd_max.toFixed(2)}`, cost <= thresholds.compile_cost_usd_max),
  ];

  const failures = metrics.filter((m) => m.scored && !m.pass).map((m) => `${m.label}: ${m.display} (target ${m.target})`);
  for (const s of stageReports) if (s.error) failures.push(`stage ${s.name} failed: ${s.error}`);
  const pass = failures.length === 0 && leaks.length === 0;
  await run.close(stageReports.some((s) => s.error) ? 'failed' : 'succeeded', cost);

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
      filter: filterScore,
      extract: extractScore,
      draft: draftScore,
      contradictions,
      drift,
      tribal,
      false_assertions: assertions.asserted,
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
  lines.push(`  stages: ${sc.stages.map((s) => `${s.name}${s.error ? '!' : s.ran ? '✓' : s.implemented ? '·' : '✗'}`).join(' ')}   (✓ ran, ! failed, · implemented but filtered out, ✗ not implemented)`);
  for (const s of ran) {
    const kept = s.kept !== null ? `, ${s.kept} items kept` : '';
    const claimsNote = s.claims > 0 ? `, ${s.claims} claims` : '';
    const cached = s.usage.cached_calls ? ` (${s.usage.cached_calls} cached)` : '';
    lines.push(`    ${s.name}: ${s.error ? `FAILED: ${s.error}` : `${s.artifacts} artifacts, ${s.findings} findings${kept}${claimsNote}, ${s.usage.model_calls} calls${cached}, ${s.usage.cost_usd.toFixed(2)}`}`);
    for (const n of s.notes) lines.push(`      note: ${n}`);
  }
  for (const n of sc.notes) lines.push(`  note: ${n}`);
  for (const l of sc.leaks) lines.push(`  LEAK [${l.kind}]${l.defect_id ? ` ${l.defect_id}` : ''}: ${l.detail}`);
  lines.push('');
  lines.push(sc.pass ? 'RESULT: PASS' : `RESULT: FAIL — ${sc.leaks.length > 0 ? `${sc.leaks.length} permission leak(s); ` : ''}${sc.failures.length} threshold(s)/stage(s) unmet`);
  return lines.join('\n');
}
