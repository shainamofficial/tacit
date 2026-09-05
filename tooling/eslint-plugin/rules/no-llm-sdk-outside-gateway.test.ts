import { RuleTester } from 'eslint';
import { describe, expect, it } from 'vitest';
import rule, { matches } from './no-llm-sdk-outside-gateway.js';

describe('matches', () => {
  it('matches exact names and subpaths', () => {
    expect(matches('openai', 'openai')).toBe(true);
    expect(matches('openai/helpers/zod', 'openai')).toBe(true);
    expect(matches('openai-fake', 'openai')).toBe(false);
  });
  it('matches whole scopes with a trailing /*', () => {
    expect(matches('@ai-sdk/anthropic', '@ai-sdk/*')).toBe(true);
    expect(matches('@ai-sdk', '@ai-sdk/*')).toBe(false);
  });
});

describe('no-llm-sdk-outside-gateway', () => {
  it('reports every import form of a forbidden module and nothing else', () => {
    const tester = new RuleTester({
      languageOptions: { ecmaVersion: 2022, sourceType: 'module' },
    });
    const options = [{ forbid: ['@anthropic-ai/sdk', 'openai', '@ai-sdk/*'] }];
    tester.run('no-llm-sdk-outside-gateway', rule, {
      valid: [
        { code: "import { complete } from '@tacit/gateway';", options },
        { code: "import pg from 'pg';", options },
        { code: "import x from 'openai-fake';", options },
        // No options => nothing forbidden.
        { code: "import Anthropic from '@anthropic-ai/sdk';" },
      ],
      invalid: [
        {
          code: "import Anthropic from '@anthropic-ai/sdk';",
          options,
          errors: [{ messageId: 'forbidden' }],
        },
        {
          code: "import { Message } from '@anthropic-ai/sdk/resources';",
          options,
          errors: [{ messageId: 'forbidden' }],
        },
        { code: "export * from 'openai';", options, errors: [{ messageId: 'forbidden' }] },
        {
          code: "export { OpenAI } from 'openai/index';",
          options,
          errors: [{ messageId: 'forbidden' }],
        },
        { code: "const m = await import('openai');", options, errors: [{ messageId: 'forbidden' }] },
        { code: "const m = require('@ai-sdk/anthropic');", options, errors: [{ messageId: 'forbidden' }] },
      ],
    });
  });
});
