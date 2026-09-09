// Compile an org from the database (F-CMP-2, F-GAP-1, CLAUDE.md #5): read
// the live items of its approved sources, run the registered stages under
// the run budget, and write artifacts (supersede, never delete) and gaps
// (first-class rows) back. Idempotent in effect: the stage cache makes an
// unchanged re-run free of model spend, and saveCompiled supersedes rather
// than duplicates. A source whose permission review is pending or stale is
// not compiled (F-ING-4) — the gate is the same digest the admin approved.
import { PgArtifactStore } from '@tacit/artifacts';
import { atomic, isApproved, loadAclGroups, mapPermissions, type Db } from '@tacit/connector-core';
import { BudgetExceededError } from '@tacit/gateway';
import { STAGE_ORDER, evalPipeline, type DirectoryPerson, type EvalArtifact, type EvalPipeline, type EvalSyncItem, type ExtractedClaim, type Finding, type StageName } from './contract';
import { loadItems } from './db-items';

export interface CompileOptions {
  readonly db: Db;
  readonly orgId: string;
  readonly budgetUsd: number;
  readonly pipeline?: EvalPipeline;
  /** Compile only these sources (default: every approved source). */
  readonly sourceIds?: readonly string[];
  /** Skip the permission-review gate (eval/seed use only). */
  readonly requireApproval?: boolean;
  readonly people?: readonly DirectoryPerson[];
  readonly kind?: 'initial' | 'incremental';
  readonly log?: (line: Record<string, unknown>) => void;
}

export interface StageSummary {
  readonly stage: StageName;
  readonly artifacts: number;
  readonly findings: number;
  readonly calls: number;
  readonly cached: number;
  readonly cost_usd: number;
  readonly error?: string;
}

export interface CompileResult {
  readonly runId: string;
  readonly status: 'succeeded' | 'failed' | 'budget_exceeded';
  readonly sources: { readonly compiled: string[]; readonly skipped: { id: string; reason: 'pending' | 'stale' }[] };
  readonly items: number;
  readonly artifacts: number;
  readonly findings: number;
  readonly cost_usd: number;
  readonly stages: StageSummary[];
  readonly notes: string[];
}

interface SourceRow {
  id: string;
  kind: string;
}

async function approvedSources(db: Db, orgId: string, requireApproval: boolean, only?: readonly string[]): Promise<CompileResult['sources']> {
  const org = await db.query<{ settings: Record<string, unknown> }>('select settings from orgs where id = $1', [orgId]);
  const settings = org.rows[0]?.settings ?? {};
  const sources = await db.query<SourceRow>("select id, kind from sources where org_id = $1 and status <> 'disconnected' order by created_at", [orgId]);
  const compiled: string[] = [];
  const skipped: { id: string; reason: 'pending' | 'stale' }[] = [];
  for (const s of sources.rows) {
    if (only && !only.includes(s.id)) continue;
    if (!requireApproval) {
      compiled.push(s.id);
      continue;
    }
    const review = isApproved(settings, s.id, mapPermissions(await loadAclGroups(db, s.id)));
    if (review === 'approved') compiled.push(s.id);
    else skipped.push({ id: s.id, reason: review });
  }
  return { compiled, skipped };
}

const GAP_KINDS = new Set(['contradiction', 'low_confidence', 'query_miss', 'drift']);

export async function compileOrg(opts: CompileOptions): Promise<CompileResult> {
  const { db, orgId } = opts;
  const pipeline = opts.pipeline ?? evalPipeline;
  const log = opts.log ?? (() => undefined);
  const notes: string[] = [];

  const sources = await approvedSources(db, orgId, opts.requireApproval ?? true, opts.sourceIds);
  for (const s of sources.skipped) notes.push(`source ${s.id} skipped: permission review ${s.reason}`);
  const loaded = await loadItems(db, orgId, sources.compiled);
  if (loaded.skipped_no_scope > 0) notes.push(`${loaded.skipped_no_scope} item(s) skipped: no scope key recorded at ingest`);
  if (loaded.skipped_no_content > 0) notes.push(`${loaded.skipped_no_content} item(s) skipped: no content`);

  const run = await db.query<{ id: string }>(
    "insert into pipeline_runs (org_id, kind, status, budget_usd, started_at, detail) values ($1, $2, 'running', $3, now(), $4::jsonb) returning id",
    [orgId, opts.kind ?? 'initial', opts.budgetUsd, JSON.stringify({ sources: sources.compiled, items: loaded.items.length })],
  );
  const runId = run.rows[0]?.id;
  if (!runId) throw new Error('could not create the pipeline_runs row');
  log({ event: 'compile_start', run_id: runId, org_id: orgId, sources: sources.compiled.length, items: loaded.items.length, budget_usd: opts.budgetUsd });

  let items: readonly EvalSyncItem[] = loaded.items;
  let claims: ExtractedClaim[] = [];
  let artifacts: EvalArtifact[] = [];
  let findings: Finding[] = [];
  let cost = 0;
  let status: CompileResult['status'] = 'succeeded';
  const stages: StageSummary[] = [];

  for (const name of STAGE_ORDER) {
    const runner = pipeline.stages[name];
    if (!runner) continue;
    try {
      const result = await runner({ org_id: orgId, run_id: runId, items, claims, artifacts, findings, budget_usd: opts.budgetUsd, ...(opts.people ? { people: opts.people } : {}) });
      artifacts = result.replace_artifacts ? [...result.artifacts] : [...artifacts, ...result.artifacts];
      const replaced = new Set(result.replace_finding_kinds ?? []);
      findings = [...findings.filter((f) => !replaced.has(f.kind)), ...result.findings];
      if (result.items) items = result.items;
      if (result.claims) claims = [...claims, ...result.claims];
      cost += result.usage.cost_usd;
      stages.push({ stage: name, artifacts: result.artifacts.length, findings: result.findings.length, calls: result.usage.model_calls, cached: result.usage.cached_calls ?? 0, cost_usd: result.usage.cost_usd });
      for (const n of result.notes ?? []) notes.push(n);
      log({ event: 'compile_stage', run_id: runId, org_id: orgId, stage: name, artifacts: artifacts.length, findings: findings.length, calls: result.usage.model_calls, cached: result.usage.cached_calls ?? 0, cost_usd: result.usage.cost_usd, in_tokens: result.usage.in_tokens, out_tokens: result.usage.out_tokens });
      if (cost > opts.budgetUsd) {
        status = 'budget_exceeded';
        notes.push(`budget exceeded after ${name}: $${cost.toFixed(2)} > $${opts.budgetUsd.toFixed(2)}; later stages skipped`);
        break;
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      stages.push({ stage: name, artifacts: 0, findings: 0, calls: 0, cached: 0, cost_usd: 0, error: message });
      status = err instanceof BudgetExceededError ? 'budget_exceeded' : 'failed';
      notes.push(`stage ${name} failed: ${message}; later stages skipped`);
      log({ event: 'compile_stage_error', run_id: runId, org_id: orgId, stage: name, message });
      break;
    }
  }

  // Persist what we have — even a partial compile is knowledge with provenance — then close the run.
  let saved = 0;
  let gaps = 0;
  if (artifacts.length > 0 || findings.length > 0) {
    await atomic(db, async (c) => {
      const store = new PgArtifactStore(c);
      const ids = await store.saveCompiled(orgId, artifacts);
      saved = ids.size;
      for (const f of findings) {
        if (!GAP_KINDS.has(f.kind)) continue;
        await c.query("insert into gaps (org_id, kind, detail, artifact_ids) values ($1, $2, $3::jsonb, '{}')", [
          orgId,
          f.kind,
          JSON.stringify({ run_id: runId, summary: f.summary, refs: f.refs, suggested_knowers: f.suggested_knowers ?? [], confidence: f.confidence ?? null }),
        ]);
        gaps += 1;
      }
    });
  }
  await db.query('update pipeline_runs set status = $2, spent_usd = $3, finished_at = now(), detail = detail || $4::jsonb where id = $1', [
    runId,
    status,
    cost,
    JSON.stringify({ artifacts: saved, gaps, stages: stages.map((s) => ({ stage: s.stage, calls: s.calls, cached: s.cached, cost_usd: s.cost_usd, ...(s.error ? { error: s.error } : {}) })) }),
  ]);
  log({ event: 'compile_done', run_id: runId, org_id: orgId, status, artifacts: saved, gaps, cost_usd: cost });

  return { runId, status, sources, items: loaded.items.length, artifacts: saved, findings: gaps, cost_usd: cost, stages, notes };
}
