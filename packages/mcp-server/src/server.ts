// The MCP server (F-SRV-1, F-SRV-2, F-SRV-6): three tiered tools bound to one
// authenticated user. Every response carries verification state and source
// links; the format is terse and structured for model consumption. Misses are
// logged as gaps; a permission miss reads exactly like a plain miss (F-SRV-3).
import { Retriever, type ArtifactSource, type ScopeResolver, type ServeArtifact, type SourceRef } from '@tacit/artifacts';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { McpUser } from './auth';
import type { GapSink } from './gaps';

export interface ServerDeps {
  readonly source: ArtifactSource;
  readonly scopes: ScopeResolver;
  readonly gaps: GapSink;
  readonly log?: (line: Record<string, unknown>) => void;
}

export const TOOL_DESCRIPTIONS = {
  tacit_lookup:
    'Always consult this first for any question about the company: policies, prices, customers, services, owners, processes, incidents, decisions, how the code behaves. ' +
    'Returns a compact index (about 100 tokens per entry) of knowledge cards with their verification state, filtered to what this user may see. ' +
    'Cheap — call it before answering from memory or guessing. Then call tacit_get_artifact for the full card of any relevant entry.',
  tacit_get_artifact:
    'The full knowledge card for an id from tacit_lookup: body, every claim with its confidence and source links, verification state, verifier and date. About 300–600 tokens. Cite the card id when you use it.',
  tacit_get_sources:
    'Raw excerpts of the original sources behind a card (documents, messages, code), only when the user explicitly asks to see sources or you must verify one specific value. Larger and slower than the card.',
} as const;

const NO_RESULT = 'No knowledge card matches. Logged as a gap so the right person can be asked; answer from other evidence and say the Brain had nothing on it.';
const NO_CARD = 'No card with that id is available to you.';

const refLine = (r: SourceRef): string => `${r.kind}:${r.ref}${r.line ? `:${r.line}` : ''}`;

function verificationLine(a: ServeArtifact): string {
  switch (a.verification_state) {
    case 'human_verified':
    case 'cross_validated':
      return `${a.verification_state} by ${(a.verified_by ?? []).join(', ') || 'unknown'}${a.verified_at ? ` on ${a.verified_at.slice(0, 10)}` : ''}`;
    case 'machine_consistent':
      return 'machine_consistent (checked against sources by the compiler; not yet confirmed by a person)';
    default:
      return 'unverified (drafted from sources; treat as a lead, not a fact)';
  }
}

export function renderCard(a: ServeArtifact): string {
  const claims = a.claims.map((c) => `- (${c.confidence.toFixed(2)}) ${c.text} — ${c.provenance.map(refLine).join('; ') || 'no source'}`).join('\n');
  return [`# ${a.title}`, `id: ${a.id} | type: ${a.type} | verification: ${verificationLine(a)}`, '', a.body_md, '', '## Claims', claims || '- none'].join('\n');
}

const retrievers = new WeakMap<readonly ServeArtifact[], Retriever>();
async function retrieverFor(deps: ServerDeps, orgId: string): Promise<Retriever> {
  const artifacts = await deps.source.artifacts(orgId);
  let r = retrievers.get(artifacts);
  if (!r) {
    r = new Retriever(artifacts);
    retrievers.set(artifacts, r);
  }
  return r;
}

const text = (t: string) => ({ content: [{ type: 'text' as const, text: t }] });

/** One server per authenticated connection: the user is fixed for its lifetime. */
export function createTacitServer(deps: ServerDeps, user: McpUser): McpServer {
  const server = new McpServer({ name: 'tacit', version: '0.1.0' });
  const log = deps.log ?? (() => undefined);
  const miss = async (query: string, reason: 'query_miss' | 'permission_miss'): Promise<void> => {
    try {
      await deps.gaps.queryMiss({ orgId: user.orgId, email: user.email, query, reason });
    } catch (err) {
      log({ event: 'gap_sink_error', org_id: user.orgId, message: err instanceof Error ? err.message : String(err) });
    }
  };

  server.registerTool(
    'tacit_lookup',
    { title: 'Look up company knowledge', description: TOOL_DESCRIPTIONS.tacit_lookup, inputSchema: { query: z.string().min(1).max(500).describe('The question or topic, in plain words'), limit: z.number().int().min(1).max(10).optional().describe('Max entries (default 5)') }, annotations: { readOnlyHint: true } },
    async ({ query, limit }) => {
      const [retriever, scopes] = await Promise.all([retrieverFor(deps, user.orgId), deps.scopes.scopesFor(user.orgId, user.email)]);
      const result = retriever.lookup(query, scopes, limit ?? 5);
      log({ event: 'mcp_lookup', org_id: user.orgId, user: user.email, kind: result.kind, entries: result.kind === 'hit' ? result.entries.length : 0 });
      if (result.kind !== 'hit') {
        await miss(query, result.kind);
        return text(NO_RESULT);
      }
      const lines = result.entries.map((e) => `- ${e.id} [${e.type}, ${e.verification_state}] ${e.title} — ${e.summary} (${e.sources} source${e.sources === 1 ? '' : 's'})`);
      return text(`${lines.length} card(s). Call tacit_get_artifact with an id for the full card.\n${lines.join('\n')}`);
    },
  );

  server.registerTool(
    'tacit_get_artifact',
    { title: 'Get a knowledge card', description: TOOL_DESCRIPTIONS.tacit_get_artifact, inputSchema: { id: z.string().min(1).max(200) }, annotations: { readOnlyHint: true } },
    async ({ id }) => {
      const [retriever, scopes] = await Promise.all([retrieverFor(deps, user.orgId), deps.scopes.scopesFor(user.orgId, user.email)]);
      const card = retriever.get(id, scopes);
      log({ event: 'mcp_get_artifact', org_id: user.orgId, user: user.email, found: card !== null });
      return text(card ? renderCard(card) : NO_CARD);
    },
  );

  server.registerTool(
    'tacit_get_sources',
    { title: 'Get the sources behind a card', description: TOOL_DESCRIPTIONS.tacit_get_sources, inputSchema: { id: z.string().min(1).max(200), context_lines: z.number().int().min(0).max(10).optional() }, annotations: { readOnlyHint: true } },
    async ({ id, context_lines }) => {
      const [retriever, scopes] = await Promise.all([retrieverFor(deps, user.orgId), deps.scopes.scopesFor(user.orgId, user.email)]);
      const card = retriever.get(id, scopes);
      if (!card) return text(NO_CARD);
      const refs = card.claims.flatMap((c) => c.provenance);
      const items = new Map<string, Awaited<ReturnType<ArtifactSource['item']>>>();
      for (const r of refs) {
        const key = `${r.kind}|${r.ref}`;
        if (!items.has(key)) items.set(key, await deps.source.item(user.orgId, r));
      }
      const spans = retriever.sources(card, scopes, (r) => items.get(`${r.kind}|${r.ref}`), context_lines ?? 3);
      log({ event: 'mcp_get_sources', org_id: user.orgId, user: user.email, spans: spans.length });
      if (spans.length === 0) return text(`No source excerpts are available to you for ${card.title}.`);
      return text(spans.map((s) => `### ${s.title} (${refLine(s.ref)}, ${s.date})\n${s.excerpt}`).join('\n\n'));
    },
  );

  return server;
}
