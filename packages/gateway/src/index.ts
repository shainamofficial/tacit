// @tacit/gateway — the only package allowed to import LLM SDKs (CLAUDE.md #3, F-CMP-3).
//
// complete(stage, messages, opts): routes by stage via routing.yaml, caches the
// system prompt, fails over on transient errors, prices every call from the
// routing pricing table, logs to model_calls, and enforces per-run budgets.
import pg from 'pg';
import { AnthropicProvider, isCredentialsError } from './anthropic';
import { createGateway, type CompleteFn, type Gateway } from './gateway';
import { PgModelCallLogger, type ModelCallLogger } from './logger';

export { AnthropicProvider } from './anthropic';
export { BudgetExceededError, SpendLedger } from './budget';
export {
  createGateway,
  GatewayExhaustedError,
  GatewayRequestError,
  type CallLine,
  type CompleteFn,
  type CompleteOptions,
  type Completion,
  type Gateway,
  type GatewayOptions,
} from './gateway';
export { MemoryLogger, PgModelCallLogger, type ModelCallLogger, type ModelCallRecord, type Queryable } from './logger';
export {
  ProviderCredentialsError,
  ProviderRefusalError,
  ProviderRetryableError,
  type Message,
  type Provider,
  type ProviderRequest,
  type ProviderResponse,
  type Usage,
} from './provider';
export { EFFORTS, STAGES, isStage, loadRouting, parseRouting, resolveRoute, ROUTING_PATH, RoutingSchema, type Effort, type Pricing, type Routing, type Stage } from './routing';

/** No credentials (or rejected ones): the gateway cannot make model calls in this environment. */
export class GatewayUnavailableError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'GatewayUnavailableError';
  }
}

let defaultGateway: Gateway | undefined;

/**
 * The process-wide gateway: Anthropic credentials from the environment,
 * model_calls logging when DATABASE_URL is set. Built lazily on first call.
 */
export function defaultGatewayInstance(): Gateway {
  if (defaultGateway) return defaultGateway;
  let provider: AnthropicProvider;
  try {
    provider = AnthropicProvider.fromEnv();
  } catch (err) {
    throw new GatewayUnavailableError(
      'gateway unavailable: no Anthropic credentials (set ANTHROPIC_API_KEY or run `ant auth login`)',
      { cause: err },
    );
  }
  let logger: ModelCallLogger | undefined;
  const databaseUrl = process.env.DATABASE_URL;
  if (databaseUrl) logger = new PgModelCallLogger(new pg.Pool({ connectionString: databaseUrl }));
  defaultGateway = createGateway({ provider, ...(logger ? { logger } : {}) });
  return defaultGateway;
}

export const complete: CompleteFn = async (stage, messages, opts) => {
  try {
    return await defaultGatewayInstance().complete(stage, messages, opts);
  } catch (err) {
    if (isCredentialsError(err)) {
      throw new GatewayUnavailableError(`gateway unavailable: ${err.message}`, { cause: err });
    }
    throw err;
  }
};
