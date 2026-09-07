// The contract between compile stages and the eval harness (F-CMP-4).
//
// Stages register into `evalPipeline` as they are implemented (Sessions 7-10).
// The eval runner in evals/ feeds the Northwind corpus through whatever is
// registered, then grades `findings` and `artifacts` against the manifest.
// Nothing here touches the database: these are the pure in-memory shapes the
// stages produce; the pg-boss workers wrap them.
import type { Acl } from '@tacit/connector-core';

export type { Acl };

export type SourceKind = 'gdrive' | 'slack' | 'zendesk' | 'github';

/** One synced source item as the eval sees it (mirrors the sync_items row). */
export interface EvalSyncItem {
  readonly id: string;
  readonly source: SourceKind | 'github_commit';
  /** doc | message | channel | macro | ticket | file | commit | repo | pull_request */
  readonly kind?: string;
  /**
   * Stable reference used in SourceRef.ref:
   *   gdrive        → "drive/<Folder>/<slug>.md"
   *   slack         → "<conversation>:<ts>"
   *   zendesk       → "macro:<id>" | "ticket:<id>"
   *   github        → "repo/<path>"
   *   github_commit → "<sha>"
   */
  readonly external_ref: string;
  readonly title: string;
  readonly content: string;
  readonly acl: Acl;
  /** Permission-scope key this item contributes to an artifact's require_all (F-SEC-1). */
  readonly scope_key: string;
  readonly modified_at: string;
  /** Stage annotations (e.g. filter decisions) carried to later stages. */
  readonly meta?: Readonly<Record<string, unknown>>;
}

export interface SourceRef {
  readonly kind: SourceKind | 'github_commit';
  readonly ref: string;
  readonly line?: number;
}

export type ClaimKind = 'policy' | 'number' | 'date' | 'owner' | 'decision' | 'behavior' | 'process' | 'customer' | 'hint' | 'other';

/** An atomic fact extracted from one item (extract stage output; input to draft/contradict/drift). */
export interface ExtractedClaim {
  readonly id: string;
  readonly item_id: string;
  readonly text: string;
  readonly kind: ClaimKind;
  /** normalized lowercase topic, e.g. "refund window" */
  readonly subject: string;
  readonly value?: string;
  /** verbatim supporting span when the model supplied one that was found in the item */
  readonly quote?: string;
  readonly provenance: readonly SourceRef[];
  readonly confidence: number;
  readonly scope_key: string;
  readonly acl: Acl;
  readonly source: SourceKind | 'github_commit';
  readonly item_kind?: string;
  readonly modified_at: string;
}

export interface Finding {
  readonly kind: 'contradiction' | 'drift' | 'low_confidence' | 'query_miss';
  readonly refs: readonly SourceRef[];
  readonly summary: string;
  /** For low_confidence gaps: who the pipeline thinks knows (email, name, or handle). */
  readonly suggested_knowers?: readonly string[];
  readonly confidence?: number;
}

export interface EvalClaim {
  readonly text: string;
  readonly provenance: readonly SourceRef[];
  readonly confidence: number;
}

export interface EvalArtifact {
  readonly id: string;
  readonly type: string;
  readonly title: string;
  readonly body_md: string;
  readonly claims: readonly EvalClaim[];
  /** ACL intersection of every contributing source (F-SEC-1). */
  readonly permission_scope: { readonly require_all: readonly string[] };
  /** The pipeline can only produce these two; human states come from interviews. */
  readonly verification_state: 'unverified' | 'machine_consistent';
}

export interface StageUsage {
  readonly cost_usd: number;
  readonly model_calls: number;
  readonly in_tokens: number;
  readonly out_tokens: number;
  /** calls served from the stage cache (F-CMP-5); their cost is included in cost_usd as if fresh */
  readonly cached_calls?: number;
}

export interface StageResult {
  readonly artifacts: readonly EvalArtifact[];
  readonly findings: readonly Finding[];
  readonly usage: StageUsage;
  /** When present, replaces the item set later stages see (filter output). */
  readonly items?: readonly EvalSyncItem[];
  /** Claims produced by this stage (extract output), appended to the run's claims. */
  readonly claims?: readonly ExtractedClaim[];
  readonly notes?: readonly string[];
}

export interface StageContext {
  readonly org_id: string;
  readonly run_id: string;
  readonly items: readonly EvalSyncItem[];
  /** Everything produced by earlier stages in this run. */
  readonly claims: readonly ExtractedClaim[];
  readonly artifacts: readonly EvalArtifact[];
  readonly findings: readonly Finding[];
  /** Remaining budget for this run; stages pass it to the gateway as the hard cap. */
  readonly budget_usd: number;
}

export type StageName = 'filter' | 'extract' | 'draft' | 'judge' | 'contradict' | 'drift';
export const STAGE_ORDER: readonly StageName[] = ['filter', 'extract', 'draft', 'judge', 'contradict', 'drift'];

export type StageRunner = (ctx: StageContext) => Promise<StageResult>;

export interface ServeRequest {
  readonly query: string;
  readonly user: { readonly email: string };
}

export interface ServeResponse {
  readonly answer: string;
  readonly refs: readonly SourceRef[];
  readonly artifact_ids: readonly string[];
}

export interface EvalPipeline {
  readonly stages: Partial<Record<StageName, StageRunner>>;
  /** The MCP read path, permission-filtered per user (F-SRV-3). */
  readonly serve?: (req: ServeRequest, artifacts: readonly EvalArtifact[]) => Promise<ServeResponse>;
}

/** Stages register here as they land. */
export const evalPipeline: EvalPipeline = { stages: {} };

export const ZERO_USAGE: StageUsage = { cost_usd: 0, model_calls: 0, in_tokens: 0, out_tokens: 0 };
