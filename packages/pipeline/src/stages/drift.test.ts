import { BudgetExceededError, type CompleteFn, type Completion } from '@tacit/gateway';
import { describe, expect, it } from 'vitest';
import type { EvalSyncItem, ExtractedClaim, StageContext } from '../contract';
import { buildIndex, createDriftStage, docStatements, excerptWindows, isTechnical, isTechnicalLine, queryTokens, search, sharedRareTerms, tokenize } from './drift';

const item = (id: string, over: Partial<EvalSyncItem> = {}): EvalSyncItem => ({
  id,
  source: 'gdrive',
  external_ref: `drive/${id}.md`,
  title: id,
  content: '',
  acl: { kind: 'domain', domain: 'x' },
  scope_key: `gdrive:doc:${id}`,
  modified_at: '2026-04-04T00:00:00Z',
  ...over,
});
const claim = (id: string, itemId: string, text: string, over: Partial<ExtractedClaim> = {}): ExtractedClaim => ({
  id,
  item_id: itemId,
  text,
  kind: 'behavior',
  subject: 'x',
  provenance: [{ kind: 'gdrive', ref: `drive/${itemId}.md`, line: 2 }],
  confidence: 0.9,
  scope_key: `gdrive:doc:${itemId}`,
  acl: { kind: 'domain', domain: 'x' },
  source: 'gdrive',
  modified_at: '2026-04-04T00:00:00Z',
  ...over,
});
const completion = (text: string): Completion => ({ text, provider: 'fake', model: 'fake', usage: { in_tokens: 100, out_tokens: 40, cache_read_tokens: 0, cache_write_tokens: 0 }, cost_usd: 0.02, latency_ms: 1, stop_reason: 'end_turn' });

const deployGuide = item('deploy-guide', { title: 'Deploy guide', content: '# Deploy\n\nSet NW_DB_URL to the production connection string before running migrations.\nDeploys are frozen on Fridays.\n\n```\nconst robots = await client.robots.list();\n```' });
const configTs = item('config', { source: 'github', external_ref: 'repo/services/control-plane/src/config.ts', title: 'repo/services/control-plane/src/config.ts', scope_key: 'github:repo:nw', content: "import { required } from './env';\n\nexport const config = {\n  databaseUrl: required('DATABASE_URL'),\n  port: Number(process.env.PORT ?? 8080),\n};" });
const renameCommit = item('c110', { source: 'github_commit', external_ref: 'abc123', title: '#110 rename NW_DB_URL to DATABASE_URL', scope_key: 'github:repo:nw', content: 'rename NW_DB_URL to DATABASE_URL\n\nAuthor: jenna.ortiz@northwind.example' });
const clientTs = item('client', { source: 'github', external_ref: 'repo/packages/sdk/src/client.ts', title: 'repo/packages/sdk/src/client.ts', scope_key: 'github:repo:nw', content: 'export class Client {\n  readonly fleet = new FleetApi(this);\n}' });
const billingTs = item('billing', { source: 'github', external_ref: 'repo/services/billing-service/src/config.ts', title: 'repo/services/billing-service/src/config.ts', scope_key: 'github:repo:nw', content: 'export const MAX_RETRIES = 5;' });
const readme = item('readme', { source: 'github', external_ref: 'repo/docs/api.md', title: 'repo/docs/api.md', scope_key: 'github:repo:nw', content: 'Rate limit: 60 requests per minute per client.' });
const ticket = item('t1', { source: 'zendesk', kind: 'ticket', external_ref: 'ticket:1', title: 'Ticket #1', scope_key: 'zendesk:all', content: 'Set NW_DB_URL please' });

describe('drift helpers', () => {
  it('tokenizes identifiers so code and prose meet', () => {
    expect(tokenize('rename NW_DB_URL to DATABASE_URL')).toEqual(['rename', 'nw', 'database', 'url', 'database', 'url']);
    expect(tokenize("databaseUrl: required('DATABASE_URL')")).toEqual(['database', 'url', 'requir', 'database', 'url']);
    expect(tokenize('client.robots.list()')).toEqual(['client', 'robot', 'list']);
    expect(tokenize('Webhook deliveries are retried; DELIVERY_RETRIES')).toEqual(['webhook', 'delivery', 'retry', 'delivery', 'retry']);
    expect(queryTokens('time out after 30 seconds')).toEqual(['time', '30', 'second', 'timeout']);
    expect(tokenize('Authenticate against the db')).toEqual(['auth', 'against', 'database']);
  });

  it('recognises technical statements and lines', () => {
    expect(isTechnical('Set NW_DB_URL before running migrations')).toBe(true);
    expect(isTechnical('The agent listens on port 8080 by default.')).toBe(true);
    expect(isTechnical('Full-time employees accrue 20 days of PTO.')).toBe(false);
    expect(isTechnicalLine('const robots = await client.robots.list();')).toBe(true);
    expect(isTechnicalLine('Deploys are frozen on Fridays.')).toBe(false);
    expect(isTechnicalLine('# Deploy')).toBe(false);
  });

  it('ranks the code file and the commit that share identifiers, and excerpts around the matching line', () => {
    const index = buildIndex([configTs, renameCommit, clientTs, billingTs]);
    const hits = search(index, 'Set NW_DB_URL to the production connection string', 3);
    expect(hits.map((h) => h.item.id)).toEqual(['c110', 'config']);
    const windows = excerptWindows(configTs, 'NW_DB_URL connection string', 1, 2);
    expect(windows).toHaveLength(1);
    expect(windows[0]?.line).toBe(4);
    expect(windows[0]?.text).toContain("4:   databaseUrl: required('DATABASE_URL'),");
  });

  it('builds statements from technical doc claims plus uncovered technical lines, never from tickets or code', () => {
    const index = buildIndex([configTs, renameCommit, clientTs, billingTs]);
    expect(sharedRareTerms(index, 'Failed payment webhooks are retried 3 times')).toEqual(['retry']);
    const claims = [claim('c1', 'deploy-guide', 'Set NW_DB_URL to the production connection string before running migrations.', { provenance: [{ kind: 'gdrive', ref: 'drive/deploy-guide.md', line: 3 }] }), claim('c2', 'deploy-guide', 'Deploys are frozen on Fridays.', { provenance: [{ kind: 'gdrive', ref: 'drive/deploy-guide.md', line: 4 }] })];
    const statements = docStatements([deployGuide, configTs, renameCommit, readme, ticket], claims, 25, index);
    expect(statements.map((s) => `${s.origin}:${s.ref.ref}:${s.ref.line}`)).toEqual(['claim:drive/deploy-guide.md:3', 'line:drive/deploy-guide.md:7', 'line:repo/docs/api.md:1']);
    expect(statements[1]?.text).toContain('client.robots.list()');
  });
});

describe('drift stage', () => {
  const items = [deployGuide, configTs, renameCommit, clientTs, billingTs, readme, ticket];
  const claims = [claim('c1', 'deploy-guide', 'Set NW_DB_URL to the production connection string before running migrations.', { provenance: [{ kind: 'gdrive', ref: 'drive/deploy-guide.md', line: 3 }] })];
  const ctx = (): StageContext => ({ org_id: 'org', run_id: 'run', items, claims, artifacts: [], findings: [], budget_usd: 5 });

  it('emits diff-linked drift findings only for drift verdicts with cited code', async () => {
    const complete: CompleteFn = async (stage, messages) => {
      expect(stage).toBe('drift');
      const user = messages[1]?.content ?? '';
      const cands = JSON.parse(user.slice(user.indexOf('Candidates:\n') + 12)) as Array<{ id: string; doc: { statement: string; line: number | null }; code: Array<{ id: string; path: string; excerpts: string[] }> }>;
      return completion(
        JSON.stringify({
          results: cands.map((c) => {
            if (c.doc.statement.includes('NW_DB_URL')) {
              const commit = c.code.find((k) => k.path.startsWith('commit'));
              const cfg = c.code.find((k) => k.path.endsWith('config.ts'));
              expect(cfg?.excerpts[0]).toContain("databaseUrl: required('DATABASE_URL')");
              return { id: c.id, verdict: 'drift', code_says: 'the variable is DATABASE_URL', evidence: [{ code: commit?.id, line: 1 }, { code: cfg?.id, line: 4 }], summary: 'Deploy guide says NW_DB_URL; config.ts reads DATABASE_URL (renamed in #110).' };
            }
            if (c.doc.statement.includes('client.robots.list')) return { id: c.id, verdict: 'drift', code_says: 'client.fleet', evidence: [], summary: 'no evidence cited' };
            return { id: c.id, verdict: 'unrelated' };
          }),
        }),
      );
    };
    const result = await createDriftStage({ complete })(ctx());
    expect(result.findings).toHaveLength(1);
    const f = result.findings[0];
    expect(f?.kind).toBe('drift');
    expect(f?.refs).toEqual([
      { kind: 'gdrive', ref: 'drive/deploy-guide.md', line: 3 },
      { kind: 'github_commit', ref: 'abc123' },
      { kind: 'github', ref: 'repo/services/control-plane/src/config.ts', line: 4 },
    ]);
    expect(f?.summary).toContain('Docs vs code — Deploy guide');
    expect(f?.summary).toContain('rename NW_DB_URL to DATABASE_URL');
    expect(result.stats).toMatchObject({ statements: 3, from_claims: 1, from_lines: 2, drift: 2, unrelated: 1, findings: 1 });
  });

  it('survives garbage output, retries cut-off batches, and stops at the budget', async () => {
    const r1 = await createDriftStage({ complete: async () => completion('nope') })(ctx());
    expect(r1.findings).toHaveLength(0);
    expect(r1.notes?.join(' ')).toContain('no parseable JSON');

    let calls = 0;
    const cut: CompleteFn = async (_s, messages) => {
      calls += 1;
      const user = messages[1]?.content ?? '';
      const cands = JSON.parse(user.slice(user.indexOf('Candidates:\n') + 12)) as Array<{ id: string }>;
      const full = JSON.stringify({ results: cands.map((c) => ({ id: c.id, verdict: 'consistent' })) });
      return completion(cands.length > 1 ? full.slice(0, full.lastIndexOf('{"id"') - 1) : full);
    };
    const r2 = await createDriftStage({ complete: cut })(ctx());
    expect(calls).toBeGreaterThan(1);
    expect(r2.stats?.consistent).toBe(3);

    const r3 = await createDriftStage({
      complete: async () => {
        throw new BudgetExceededError('run', 5, 5);
      },
    })(ctx());
    expect(r3.notes?.join(' ')).toContain('budget reached');
  });
});
