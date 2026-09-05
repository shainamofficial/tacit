// Proves the root eslint.config.js actually wires the rule per path — the
// playbook's Session 1 review checkpoint: "the custom lint rule actually fires".
import path from 'node:path';
import { ESLint } from 'eslint';
import { describe, expect, it } from 'vitest';

const root = path.resolve(import.meta.dirname, '../..');
const RULE = 'tacit/no-llm-sdk-outside-gateway';

async function violations(relPath: string, code: string): Promise<string[]> {
  const eslint = new ESLint({ cwd: root });
  const [result] = await eslint.lintText(code, { filePath: path.join(root, relPath) });
  return (result?.messages ?? []).filter((m) => m.ruleId === RULE).map((m) => m.message);
}

const LLM = "import Anthropic from '@anthropic-ai/sdk';\nexport const client = new Anthropic();\n";
const AGENT = "import { query } from '@anthropic-ai/claude-agent-sdk';\nexport const q = query;\n";

describe('root eslint config enforces gateway-only model access (F-CMP-3)', () => {
  it('flags an LLM SDK import in the pipeline', async () => {
    expect(await violations('packages/pipeline/src/filter.ts', LLM)).toHaveLength(1);
  });
  it('flags an LLM SDK import in an app', async () => {
    expect(await violations('apps/workers/src/index.ts', LLM)).toHaveLength(1);
  });
  it('flags an LLM SDK import in evals', async () => {
    expect(await violations('evals/judge.ts', LLM)).toHaveLength(1);
  });
  it('allows LLM SDKs inside packages/gateway only', async () => {
    expect(await violations('packages/gateway/src/providers/anthropic.ts', LLM)).toHaveLength(0);
    expect(await violations('packages/gateway/src/providers/anthropic.ts', AGENT)).toHaveLength(1);
  });
  it('allows the Agent SDK inside packages/agents but not raw LLM SDKs', async () => {
    expect(await violations('packages/agents/src/archaeologist.ts', AGENT)).toHaveLength(0);
    expect(await violations('packages/agents/src/archaeologist.ts', LLM)).toHaveLength(1);
  });
  it('flags the Agent SDK outside packages/agents', async () => {
    expect(await violations('packages/pipeline/src/judge.ts', AGENT)).toHaveLength(1);
  });
  it('catches dynamic import, require, and scoped SDK families', async () => {
    const code = [
      "const a = await import('openai');",
      "const b = require('@ai-sdk/anthropic');",
      "export * from '@langchain/core';",
    ].join('\n');
    expect(await violations('packages/drift/src/x.ts', code)).toHaveLength(3);
  });
});
