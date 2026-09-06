// Provider abstraction. The gateway talks to providers only through this
// interface; the Anthropic implementation lives in anthropic.ts. Open-weight
// providers (Fireworks/Together) arrive in P1 behind the same shape.
import type { Effort } from './routing';

export interface Message {
  readonly role: 'system' | 'user' | 'assistant';
  readonly content: string;
}

export interface Usage {
  readonly in_tokens: number;
  readonly out_tokens: number;
  readonly cache_read_tokens: number;
  readonly cache_write_tokens: number;
}

export interface ProviderRequest {
  readonly model: string;
  readonly system: string | undefined;
  /** user/assistant turns only; system content is passed separately */
  readonly messages: ReadonlyArray<{ role: 'user' | 'assistant'; content: string }>;
  readonly maxTokens: number;
  readonly effort: Effort;
  /** mark the system prompt as a prompt-cache breakpoint (F-CMP-5) */
  readonly cacheSystem: boolean;
}

export interface ProviderResponse {
  readonly text: string;
  /** model that actually served the request (may differ under server-side fallback) */
  readonly model: string;
  readonly usage: Usage;
  readonly stopReason: string;
}

export interface Provider {
  readonly name: string;
  complete(req: ProviderRequest): Promise<ProviderResponse>;
}

/** Transient failure (429 / 5xx / connection) after the provider's own retries: the gateway may fail over. */
export class ProviderRetryableError extends Error {
  constructor(
    message: string,
    readonly status: number | undefined,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'ProviderRetryableError';
  }
}

/** No usable credentials for the provider in this environment. */
export class ProviderCredentialsError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'ProviderCredentialsError';
  }
}

/** The model declined the request. Never retried on another model by the gateway. */
export class ProviderRefusalError extends Error {
  constructor(
    readonly model: string,
    readonly category: string | null,
    readonly explanation: string | null,
  ) {
    super(`model ${model} refused the request${category ? ` (category: ${category})` : ''}`);
    this.name = 'ProviderRefusalError';
  }
}
