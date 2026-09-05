import js from '@eslint/js';
import tacit from '@tacit/eslint-plugin';
import { defineConfig } from 'eslint/config';
import globals from 'globals';
import tseslint from 'typescript-eslint';

// Non-negotiable #3 (CLAUDE.md) / F-CMP-3: all model calls go through @tacit/gateway.
// Importing an LLM SDK anywhere else is a lint error. The Agent SDK is the one
// exception and is confined to packages/agents (bounded harnesses, non-negotiable #4).
const LLM_SDKS = [
  '@anthropic-ai/sdk',
  '@anthropic-ai/bedrock-sdk',
  '@anthropic-ai/vertex-sdk',
  'openai',
  '@openai/*',
  '@google/generative-ai',
  '@google/genai',
  '@google-cloud/vertexai',
  '@aws-sdk/client-bedrock-runtime',
  '@azure/openai',
  '@azure-rest/ai-inference',
  'cohere-ai',
  '@mistralai/mistralai',
  'groq-sdk',
  'together-ai',
  'ollama',
  'replicate',
  '@huggingface/inference',
  'ai',
  '@ai-sdk/*',
  'langchain',
  '@langchain/*',
  'llamaindex',
  '@llamaindex/*',
  'litellm',
];
const AGENT_SDKS = ['@anthropic-ai/claude-agent-sdk', '@anthropic-ai/claude-code'];
const RULE = 'tacit/no-llm-sdk-outside-gateway';

export default defineConfig(
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/.turbo/**',
      '**/.next/**',
      '**/coverage/**',
      // The synthetic Northwind corpus (Phase 0) is test data, not our code.
      'evals/corpus/generated/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: { globals: globals.node },
    plugins: { tacit },
    rules: {
      [RULE]: ['error', { forbid: [...LLM_SDKS, ...AGENT_SDKS] }],
    },
  },
  {
    // The gateway is the only place raw LLM SDKs may live.
    files: ['packages/gateway/**'],
    rules: { [RULE]: ['error', { forbid: AGENT_SDKS }] },
  },
  {
    // Agent harnesses may use the Agent SDK, never raw LLM SDKs.
    files: ['packages/agents/**'],
    rules: { [RULE]: ['error', { forbid: LLM_SDKS }] },
  },
);
