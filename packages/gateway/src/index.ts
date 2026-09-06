// @tacit/gateway — the only package allowed to import LLM SDKs (CLAUDE.md #3, F-CMP-3).
//
// Session 4 implements this: per-stage routing from routing.yaml, Anthropic
// provider, prompt caching, fallbacks, cost/latency logging to model_calls.
// Until then `complete` throws GatewayNotImplementedError so callers (the eval
// factuality judge, for one) can report "unavailable" instead of faking it.

export type Stage = 'filter' | 'extract' | 'draft' | 'judge' | 'contradict' | 'interview' | 'eval_judge';

export interface Message {
  readonly role: 'system' | 'user' | 'assistant';
  readonly content: string;
}

export interface CompleteOptions {
  readonly temperature?: number;
  readonly maxTokens?: number;
  /** Ask the provider for a JSON object response; callers still parse with zod. */
  readonly json?: boolean;
  readonly runId?: string;
  readonly orgId?: string;
}

export interface Usage {
  readonly in_tokens: number;
  readonly out_tokens: number;
  readonly cache_read_tokens: number;
  readonly cache_write_tokens: number;
}

export interface Completion {
  readonly text: string;
  readonly provider: string;
  readonly model: string;
  readonly usage: Usage;
  readonly cost_usd: number;
  readonly latency_ms: number;
}

export type CompleteFn = (stage: Stage, messages: readonly Message[], opts?: CompleteOptions) => Promise<Completion>;

export class GatewayNotImplementedError extends Error {
  constructor() {
    super('@tacit/gateway is not implemented yet (Session 4); no model calls are possible');
    this.name = 'GatewayNotImplementedError';
  }
}

export const complete: CompleteFn = async () => {
  throw new GatewayNotImplementedError();
};
