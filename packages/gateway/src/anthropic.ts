// Anthropic provider. The only file in the repo that imports an LLM SDK.
import Anthropic from '@anthropic-ai/sdk';
import {
  ProviderCredentialsError,
  ProviderRefusalError,
  ProviderRetryableError,
  type Provider,
  type ProviderRequest,
  type ProviderResponse,
} from './provider';

/** The server-side `fallbacks` parameter is accepted on Opus 5 and Fable; Sonnet/Haiku return 400. */
export function supportsServerFallback(model: string): boolean {
  return model.startsWith('claude-opus-5') || model.startsWith('claude-fable') || model.startsWith('claude-mythos');
}

export class AnthropicProvider implements Provider {
  readonly name = 'anthropic';

  constructor(private readonly client: Anthropic) {}

  /** Credentials resolve from ANTHROPIC_API_KEY, ANTHROPIC_AUTH_TOKEN, or an `ant auth login` profile. */
  static fromEnv(): AnthropicProvider {
    return new AnthropicProvider(new Anthropic());
  }

  async complete(req: ProviderRequest): Promise<ProviderResponse> {
    const params: Anthropic.Beta.MessageCreateParamsNonStreaming = {
      model: req.model,
      max_tokens: req.maxTokens,
      messages: req.messages.map((m) => ({ role: m.role, content: m.content })),
      // Thinking is adaptive by default on current models; effort controls depth.
      output_config: { effort: req.effort },
      // Server-side refusal fallback: a policy decline re-runs on a fallback model
      // inside the same call. Opus 5 / Fable only; other models reject the parameter.
      ...(supportsServerFallback(req.model) ? { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' } : {}),
    };
    if (req.system !== undefined) {
      params.system = [
        {
          type: 'text',
          text: req.system,
          ...(req.cacheSystem ? { cache_control: { type: 'ephemeral' } } : {}),
        },
      ];
    }

    let res: Anthropic.Beta.BetaMessage;
    try {
      res = await this.client.beta.messages.create(params);
    } catch (err) {
      if (err instanceof Anthropic.AuthenticationError) {
        throw new ProviderCredentialsError('Anthropic rejected the credentials', { cause: err });
      }
      // The SDK resolves credentials lazily and, when none of api key / auth
      // token / profile exist, throws a plain Error (no typed class) from
      // validateHeaders before any request is made. Message match is the only
      // available signal; kept narrow and documented here.
      if (err instanceof Error && !(err instanceof Anthropic.AnthropicError) && err.message.startsWith('Could not resolve authentication method')) {
        throw new ProviderCredentialsError(
          'no Anthropic credentials found (set ANTHROPIC_API_KEY or run `ant auth login`)',
          { cause: err },
        );
      }
      if (err instanceof Anthropic.APIConnectionError) {
        throw new ProviderRetryableError(`anthropic connection error: ${err.message}`, undefined, { cause: err });
      }
      if (err instanceof Anthropic.APIError && (err.status === 429 || (err.status ?? 0) >= 500)) {
        throw new ProviderRetryableError(`anthropic ${err.status}: ${err.message}`, err.status, { cause: err });
      }
      throw err;
    }

    if (res.stop_reason === 'refusal') {
      throw new ProviderRefusalError(res.model, res.stop_details?.category ?? null, res.stop_details?.explanation ?? null);
    }

    return {
      text: res.content
        .filter((block): block is Anthropic.Beta.BetaTextBlock => block.type === 'text')
        .map((block) => block.text)
        .join(''),
      model: res.model,
      usage: {
        in_tokens: res.usage.input_tokens ?? 0,
        out_tokens: res.usage.output_tokens,
        cache_read_tokens: res.usage.cache_read_input_tokens ?? 0,
        cache_write_tokens: res.usage.cache_creation_input_tokens ?? 0,
      },
      stopReason: res.stop_reason ?? 'end_turn',
    };
  }
}

export function isCredentialsError(err: unknown): err is ProviderCredentialsError {
  return err instanceof ProviderCredentialsError;
}
