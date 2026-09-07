// @tacit/pipeline — compile stages: filter -> extract -> draft -> judge -> contradict;
// idempotent, resumable, budget-capped (F-CMP-2). Stages register into
// evalPipeline as they land so the eval harness can grade them.
import { complete as gatewayComplete } from '@tacit/gateway';
import { cachedGatewayComplete } from './cache';
import { evalPipeline } from './contract';
import { createDraftStage } from './stages/draft';
import { createExtractStage } from './stages/extract';
import { createFilterStage } from './stages/filter';

export * from './contract';
export { FileCompletionCache, cacheKey, cachedGatewayComplete, wasCached } from './cache';
export { createDraftStage, mergeClaims, normalizeSubject, variantsFor, type DraftDeps, type MergedClaim, type Variant } from './stages/draft';
export { batchItems, createExtractStage, locateQuote, type ExtractDeps } from './stages/extract';
export { drain, parseWithSalvage } from './json';
export { createFilterStage, ruleDecision, type FilterDecision, type FilterDeps } from './stages/filter';

// Every stage shares one gateway entry point; with TACIT_STAGE_CACHE_DIR set,
// identical requests are served from disk (F-CMP-5).
const complete = cachedGatewayComplete(gatewayComplete);
evalPipeline.stages.filter = createFilterStage({ complete });
evalPipeline.stages.extract = createExtractStage({ complete });
evalPipeline.stages.draft = createDraftStage({ complete });
