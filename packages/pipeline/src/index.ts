// @tacit/pipeline — compile stages: filter -> extract -> draft -> judge -> contradict;
// idempotent, resumable, budget-capped (F-CMP-2). Stages register into
// evalPipeline as they land so the eval harness can grade them.
import { evalPipeline } from './contract';
import { createFilterStage } from './stages/filter';

export * from './contract';
export { createFilterStage, ruleDecision, type FilterDecision, type FilterDeps } from './stages/filter';

evalPipeline.stages.filter = createFilterStage();
