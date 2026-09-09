// @tacit/pipeline — compile stages: filter -> extract -> draft -> judge -> contradict;
// idempotent, resumable, budget-capped (F-CMP-2). Stages register into
// evalPipeline as they land so the eval harness can grade them.
import { complete as gatewayComplete } from '@tacit/gateway';
import { cachedGatewayComplete } from './cache';
import { evalPipeline } from './contract';
import { Retriever } from '@tacit/artifacts';
import { createContradictStage } from './stages/contradict';
import { createDraftStage } from './stages/draft';
import { createDriftStage } from './stages/drift';
import { createExtractStage } from './stages/extract';
import { createJudgeStage } from './stages/judge';
import { createFilterStage } from './stages/filter';

export * from './contract';
export { compileOrg, type CompileOptions, type CompileResult, type StageSummary } from './compile';
export { loadItems, type LoadedItems } from './db-items';
export { FileCompletionCache, cacheKey, cachedGatewayComplete, wasCached } from './cache';
export { capClaims, createContradictStage, groupByTopic, isCodeRef, isRecordRef, mergeSubsetTopics, orderForDiscovery, resolveKnower, type ContradictDeps, type ContradictStats, type Topic } from './stages/contradict';
export { createDraftStage, mergeClaims, normalizeSubject, variantsFor, type DraftDeps, type MergedClaim, type Variant } from './stages/draft';
export { batchItems, createExtractStage, locateQuote, type ExtractDeps } from './stages/extract';
export { drain, parseWithSalvage } from './json';
export { buildIndex, createDriftStage, docStatements, excerptWindows, isCodeItem, isDocItem, isTechnical, isTechnicalLine, queryTokens, search, sharedRareTerms, tokenize, type CodeIndex, type DocStatement, type DriftDeps, type DriftStats } from './stages/drift';
export { createJudgeStage, itemAuthors, sourceExcerpt, type JudgeDeps, type JudgeStats } from './stages/judge';
export { createFilterStage, ruleDecision, type FilterDecision, type FilterDeps } from './stages/filter';

// Every stage shares one gateway entry point; with TACIT_STAGE_CACHE_DIR set,
// identical requests are served from disk (F-CMP-5).
const complete = cachedGatewayComplete(gatewayComplete);
evalPipeline.stages.filter = createFilterStage({ complete });
evalPipeline.stages.extract = createExtractStage({ complete });
evalPipeline.stages.draft = createDraftStage({ complete });
evalPipeline.stages.judge = createJudgeStage({ complete });
evalPipeline.stages.contradict = createContradictStage({ complete });
evalPipeline.stages.drift = createDriftStage({ complete });
// The eval's read path (F-SRV-3): the same permission-filtered retriever the MCP server uses,
// answering with the visible cards' bodies. No model call; the leak probes grade the filter.
evalPipeline.serve = async (req, artifacts) => {
  const scopes = new Set(req.user.scopes);
  const result = new Retriever(artifacts).lookup(req.query, scopes, 3);
  if (result.kind !== 'hit') return { answer: 'I do not have information on that.', refs: [], artifact_ids: [] };
  const byId = new Map(artifacts.map((a) => [a.id, a] as const));
  const cards = result.entries.map((e) => byId.get(e.id)).filter((a): a is (typeof artifacts)[number] => a !== undefined);
  const refs = new Map(cards.flatMap((a) => a.claims.flatMap((c) => c.provenance)).map((r) => [`${r.kind}|${r.ref}|${r.line ?? ''}`, r] as const));
  return { answer: cards.map((a) => `${a.title}\n${a.body_md}`).join('\n\n'), refs: [...refs.values()], artifact_ids: cards.map((a) => a.id) };
};
