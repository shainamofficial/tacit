// The gateway: complete(stage, messages, opts). Routing from routing.yaml,
// fallbacks on transient provider errors, prompt caching on the system
// prompt, cost computed from the pricing table, one model_calls row and one
// structured log line per call (no content ever), per-run budget hard stop.
import { BudgetExceededError, SpendLedger } from './budget';
import type { ModelCallLogger } from './logger';
import { ProviderRetryableError, type Message, type Provider, type Usage } from './provider';
import { loadRouting, resolveRoute, type Routing, type Stage } from './routing';

export interface CompleteOptions {
  readonly maxTokens?: number;
  /**
   * Ask for a single JSON object (an instruction is appended to the system
   * prompt). Callers still parse the text with zod: model output is untrusted.
   */
  readonly json?: boolean;
  readonly runId?: string;
  readonly orgId?: string;
  /** Hard cap for this run; the call is refused once spend reaches it. */
  readonly budgetUsd?: number;
  /** Override the route's cache_system setting. */
  readonly cacheSystem?: boolean;
  /** Judge outcome to record with the call (approve | edit | escalate). */
  readonly editRateSignal?: string;
}

export interface Completion {
  readonly text: string;
  readonly provider: string;
  readonly model: string;
  readonly usage: Usage;
  readonly cost_usd: number;
  readonly latency_ms: number;
  readonly stop_reason: string;
}

export type CompleteFn = (stage: Stage, messages: readonly Message[], opts?: CompleteOptions) => Promise<Completion>;

/** Structured per-call log line. Never contains prompt or completion content. */
export interface CallLine {
  readonly event: 'model_call';
  readonly run_id: string | null;
  readonly org_id: string | null;
  readonly stage: Stage;
  readonly provider: string;
  readonly model: string;
  readonly ok: boolean;
  readonly error?: string;
  readonly in_tokens: number;
  readonly out_tokens: number;
  readonly cache_read_tokens: number;
  readonly cache_write_tokens: number;
  readonly cost_usd: number;
  readonly latency_ms: number;
}

export class GatewayRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GatewayRequestError';
  }
}

/** Every candidate model failed with a transient error. */
export class GatewayExhaustedError extends Error {
  constructor(
    readonly stage: Stage,
    readonly attempts: ReadonlyArray<{ model: string; error: string }>,
  ) {
    super(`stage ${stage}: all models failed: ${attempts.map((a) => `${a.model} (${a.error})`).join('; ')}`);
    this.name = 'GatewayExhaustedError';
  }
}

export interface GatewayOptions {
  readonly provider: Provider;
  readonly routing?: Routing;
  readonly logger?: ModelCallLogger;
  /** Structured log sink; defaults to one JSON line on stdout per call. */
  readonly onCall?: (line: CallLine) => void;
  readonly now?: () => number;
}

export interface Gateway {
  readonly complete: CompleteFn;
  readonly ledger: SpendLedger;
  readonly routing: Routing;
}

const JSON_INSTRUCTION = 'Respond with a single JSON object and nothing else: no prose, no code fences.';

function splitMessages(messages: readonly Message[], json: boolean): {
  system: string | undefined;
  turns: Array<{ role: 'user' | 'assistant'; content: string }>;
} {
  const systemParts: string[] = [];
  const turns: Array<{ role: 'user' | 'assistant'; content: string }> = [];
  for (const m of messages) {
    if (m.role === 'system') systemParts.push(m.content);
    else turns.push({ role: m.role, content: m.content });
  }
  if (json) systemParts.push(JSON_INSTRUCTION);
  if (turns.length === 0) throw new GatewayRequestError('at least one user message is required');
  if (turns[0]?.role !== 'user') throw new GatewayRequestError('the first non-system message must be from the user');
  return { system: systemParts.length > 0 ? systemParts.join('\n\n') : undefined, turns };
}

export function createGateway(options: GatewayOptions): Gateway {
  const routing = options.routing ?? loadRouting();
  const ledger = new SpendLedger();
  const now = options.now ?? (() => Date.now());
  const onCall = options.onCall ?? ((line: CallLine) => console.log(JSON.stringify(line)));

  const complete: CompleteFn = async (stage, messages, opts = {}) => {
    const route = resolveRoute(routing, stage);
    const runId = opts.runId ?? null;
    const orgId = opts.orgId ?? null;
    if (runId && opts.budgetUsd !== undefined) ledger.assertWithin(runId, opts.budgetUsd);

    const { system, turns } = splitMessages(messages, opts.json ?? false);
    const attempts: Array<{ model: string; error: string }> = [];

    for (const model of [route.model, ...route.fallbacks]) {
      const started = now();
      try {
        const res = await options.provider.complete({
          model,
          system,
          messages: turns,
          maxTokens: opts.maxTokens ?? route.maxTokens,
          effort: route.effort,
          cacheSystem: opts.cacheSystem ?? route.cacheSystem,
        });
        const latency = now() - started;
        const pricing = routing.models[res.model] ?? routing.models[model];
        if (!pricing) throw new GatewayRequestError(`no pricing for model ${res.model}`);
        const cost =
          (res.usage.in_tokens * pricing.input_per_mtok +
            res.usage.out_tokens * pricing.output_per_mtok +
            res.usage.cache_write_tokens * pricing.cache_write_per_mtok +
            res.usage.cache_read_tokens * pricing.cache_read_per_mtok) /
          1_000_000;

        if (runId) ledger.add(runId, cost);
        if (options.logger && orgId) {
          await options.logger.log({
            run_id: runId,
            org_id: orgId,
            stage,
            provider: options.provider.name,
            model: res.model,
            usage: res.usage,
            cost_usd: cost,
            latency_ms: latency,
            edit_rate_signal: opts.editRateSignal ?? null,
          });
        }
        onCall({
          event: 'model_call',
          run_id: runId,
          org_id: orgId,
          stage,
          provider: options.provider.name,
          model: res.model,
          ok: true,
          ...res.usage,
          cost_usd: cost,
          latency_ms: latency,
        });
        return {
          text: res.text,
          provider: options.provider.name,
          model: res.model,
          usage: res.usage,
          cost_usd: cost,
          latency_ms: latency,
          stop_reason: res.stopReason,
        };
      } catch (err) {
        if (!(err instanceof ProviderRetryableError)) throw err;
        attempts.push({ model, error: err.message });
        onCall({
          event: 'model_call',
          run_id: runId,
          org_id: orgId,
          stage,
          provider: options.provider.name,
          model,
          ok: false,
          error: err.message,
          in_tokens: 0,
          out_tokens: 0,
          cache_read_tokens: 0,
          cache_write_tokens: 0,
          cost_usd: 0,
          latency_ms: now() - started,
        });
      }
    }
    throw new GatewayExhaustedError(stage, attempts);
  };

  return { complete, ledger, routing };
}

export { BudgetExceededError };
