// @tacit/prompts — compile-stage prompts as versioned markdown with a YAML
// front matter (stage, version, params). PROPOSE-ONLY: prompt text changes
// land via PR with the eval scorecard delta. This file is only the loader.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { z } from 'zod';

const FrontMatter = z.object({
  stage: z.string().min(1),
  version: z.number().int().positive(),
  params: z.record(z.string(), z.unknown()).default({}),
});

export interface Prompt {
  readonly name: string;
  readonly stage: string;
  readonly version: number;
  readonly params: Readonly<Record<string, unknown>>;
  /** The prompt body (system prompt), trimmed. */
  readonly text: string;
}

export const PROMPTS_DIR = path.resolve(import.meta.dirname, '..');

export function parsePrompt(name: string, raw: string): Prompt {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/.exec(raw);
  if (!match) throw new Error(`prompt ${name}: missing YAML front matter`);
  const front = FrontMatter.parse(YAML.parse(match[1] ?? ''));
  const text = (match[2] ?? '').trim();
  if (!text) throw new Error(`prompt ${name}: empty body`);
  return { name, stage: front.stage, version: front.version, params: front.params, text };
}

export function loadPrompt(name: string): Prompt {
  return parsePrompt(name, readFileSync(path.join(PROMPTS_DIR, `${name}.md`), 'utf8'));
}
