// routing.yaml loader. Stage routing lives in the YAML, never in code (CLAUDE.md #3).
import { readFileSync } from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { z } from 'zod';

export const STAGES = ['filter', 'extract', 'draft', 'judge', 'contradict', 'contradict_verify', 'interview', 'eval_judge'] as const;
export type Stage = (typeof STAGES)[number];

export const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
export type Effort = (typeof EFFORTS)[number];

export const ROUTING_PATH = path.resolve(import.meta.dirname, '../../../routing.yaml');

const PricingSchema = z.object({
  input_per_mtok: z.number().nonnegative(),
  output_per_mtok: z.number().nonnegative(),
  cache_write_per_mtok: z.number().nonnegative(),
  cache_read_per_mtok: z.number().nonnegative(),
});
export type Pricing = z.infer<typeof PricingSchema>;

const StageRouteSchema = z.object({
  model: z.string().min(1),
  effort: z.enum(EFFORTS).optional(),
  max_tokens: z.number().int().positive().optional(),
  fallbacks: z.array(z.string().min(1)).default([]),
  cache_system: z.boolean().default(true),
});
export type StageRoute = z.infer<typeof StageRouteSchema>;

export const RoutingSchema = z
  .object({
    version: z.literal(1),
    defaults: z.object({
      provider: z.literal('anthropic'),
      max_tokens: z.number().int().positive(),
      effort: z.enum(EFFORTS),
    }),
    models: z.record(z.string(), PricingSchema),
    stages: z.object(Object.fromEntries(STAGES.map((s) => [s, StageRouteSchema])) as Record<Stage, typeof StageRouteSchema>),
  })
  .superRefine((routing, ctx) => {
    for (const stage of STAGES) {
      const route = routing.stages[stage];
      for (const model of [route.model, ...route.fallbacks]) {
        if (!(model in routing.models)) {
          ctx.addIssue({ code: 'custom', path: ['stages', stage], message: `model "${model}" has no pricing entry under models` });
        }
      }
    }
  });
export type Routing = z.infer<typeof RoutingSchema>;

export function parseRouting(yamlText: string): Routing {
  return RoutingSchema.parse(YAML.parse(yamlText));
}

export function loadRouting(file: string = ROUTING_PATH): Routing {
  return parseRouting(readFileSync(file, 'utf8'));
}

export interface ResolvedRoute {
  readonly model: string;
  readonly effort: Effort;
  readonly maxTokens: number;
  readonly fallbacks: readonly string[];
  readonly cacheSystem: boolean;
}

export function resolveRoute(routing: Routing, stage: Stage): ResolvedRoute {
  const route = routing.stages[stage];
  return {
    model: route.model,
    effort: route.effort ?? routing.defaults.effort,
    maxTokens: route.max_tokens ?? routing.defaults.max_tokens,
    fallbacks: route.fallbacks,
    cacheSystem: route.cache_system,
  };
}

export function isStage(value: string): value is Stage {
  return (STAGES as readonly string[]).includes(value);
}
