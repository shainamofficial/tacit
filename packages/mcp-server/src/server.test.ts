import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { SnapshotStore, type ServeSnapshot } from '@tacit/artifacts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { StaticTokenAuthenticator } from './auth';
import { MemoryGapSink } from './gaps';
import { startHttpServer } from './http';
import { createTacitServer } from './server';

const ORG = 'org-northwind';
const PUBLIC = 'gdrive:doc:pricing';
const EXEC = 'gdrive:doc:comp';
const snapshot: ServeSnapshot = {
  org_id: ORG,
  artifacts: [
    { id: 'a1', type: 'qa_fact', title: 'Refund window', body_md: 'The refund window is 30 days on all plans [c1].', claims: [{ text: 'Refunds are 30 days on all plans.', provenance: [{ kind: 'gdrive', ref: 'drive/pricing.md', line: 2 }], confidence: 0.9 }], permission_scope: { require_all: [PUBLIC] }, verification_state: 'machine_consistent' },
    { id: 'a2', type: 'entity_card', title: 'Engineering compensation bands', body_md: 'Bands: L3 $140k–$165k; raises planned in Q3 [c1].', claims: [{ text: 'Raises planned in Q3.', provenance: [{ kind: 'gdrive', ref: 'drive/comp.md', line: 1 }], confidence: 0.9 }], permission_scope: { require_all: [EXEC] }, verification_state: 'unverified' },
  ],
  items: [
    { id: 'i1', source: 'gdrive', external_ref: 'drive/pricing.md', title: 'Pricing sheet', content: '# Pricing\nRefunds: 30 days on all plans.\nSeats: 5 minimum.', scope_key: PUBLIC, modified_at: '2026-04-04T00:00:00Z' },
    { id: 'i2', source: 'gdrive', external_ref: 'drive/comp.md', title: 'Comp bands', content: 'Raises planned in Q3.', scope_key: EXEC, modified_at: '2026-04-04T00:00:00Z' },
  ],
  scopes: { [PUBLIC]: null, [EXEC]: ['alice.chen@northwind.example'] },
};

async function connect(email: string, gaps: MemoryGapSink): Promise<Client> {
  const store = new SnapshotStore(snapshot);
  const server = createTacitServer({ source: store, scopes: store, gaps }, { email, orgId: ORG });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: 'test', version: '0' });
  await client.connect(clientTransport);
  return client;
}
const textOf = (r: Awaited<ReturnType<Client['callTool']>>): string => (r.content as Array<{ type: string; text?: string }>).map((c) => c.text ?? '').join('\n');

describe('tacit MCP server', () => {
  it('exposes the three tiered tools with adoption-oriented descriptions', async () => {
    const client = await connect('lena.fischer@northwind.example', new MemoryGapSink());
    const tools = (await client.listTools()).tools;
    expect(tools.map((t) => t.name).sort()).toEqual(['tacit_get_artifact', 'tacit_get_sources', 'tacit_lookup']);
    expect(tools.find((t) => t.name === 'tacit_lookup')?.description).toContain('Always consult this first');
  });

  it('serves visible cards with verification state and source links, and hides restricted ones identically to a miss', async () => {
    const gaps = new MemoryGapSink();
    const lena = await connect('lena.fischer@northwind.example', gaps);
    const hit = textOf(await lena.callTool({ name: 'tacit_lookup', arguments: { query: 'refund window' } }));
    expect(hit).toContain('a1 [qa_fact, machine_consistent] Refund window');
    expect(hit).not.toContain('[c1]');

    const denied = textOf(await lena.callTool({ name: 'tacit_lookup', arguments: { query: 'compensation bands raises' } }));
    const unknown = textOf(await lena.callTool({ name: 'tacit_lookup', arguments: { query: 'quantum teleportation schedule' } }));
    expect(denied).toBe(unknown); // permission miss reads exactly like a plain miss
    expect(denied).not.toContain('$140k');
    expect(gaps.misses.map((m) => m.reason)).toEqual(['permission_miss', 'query_miss']);
    expect(gaps.misses[0]).toMatchObject({ orgId: ORG, email: 'lena.fischer@northwind.example', query: 'compensation bands raises' });

    const card = textOf(await lena.callTool({ name: 'tacit_get_artifact', arguments: { id: 'a1' } }));
    expect(card).toContain('# Refund window');
    expect(card).toContain('verification: machine_consistent');
    expect(card).toContain('gdrive:drive/pricing.md:2');
    expect(textOf(await lena.callTool({ name: 'tacit_get_artifact', arguments: { id: 'a2' } }))).toBe(textOf(await lena.callTool({ name: 'tacit_get_artifact', arguments: { id: 'nope' } })));
    expect(textOf(await lena.callTool({ name: 'tacit_get_sources', arguments: { id: 'a2' } }))).not.toContain('Raises');

    const sources = textOf(await lena.callTool({ name: 'tacit_get_sources', arguments: { id: 'a1', context_lines: 1 } }));
    expect(sources).toContain('### Pricing sheet (gdrive:drive/pricing.md:2, 2026-04-04)');
    expect(sources).toContain('2: Refunds: 30 days on all plans.');

    const alice = await connect('alice.chen@northwind.example', gaps);
    expect(textOf(await alice.callTool({ name: 'tacit_lookup', arguments: { query: 'compensation bands raises' } }))).toContain('a2 [entity_card, unverified]');
    expect(textOf(await alice.callTool({ name: 'tacit_get_artifact', arguments: { id: 'a2' } }))).toContain('treat as a lead, not a fact');
  });
});

describe('HTTP endpoint', () => {
  let url = '';
  let close: () => void = () => undefined;
  const gaps = new MemoryGapSink();

  beforeAll(async () => {
    const store = new SnapshotStore(snapshot);
    const auth = new StaticTokenAuthenticator([{ token: 'lena-token-0123456789', email: 'lena.fischer@northwind.example', org_id: ORG }]);
    const started = await startHttpServer({ source: store, scopes: store, gaps, auth }, 0);
    url = started.url;
    close = () => started.server.close();
  });
  afterAll(() => close());

  it('rejects requests without a valid per-user token and serves authenticated ones', async () => {
    const anon = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: '{}' });
    expect(anon.status).toBe(401);
    expect(anon.headers.get('www-authenticate')).toContain('Bearer');
    const bad = await fetch(url, { method: 'POST', headers: { authorization: 'Bearer nope-nope-nope-nope', 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: '{}' });
    expect(bad.status).toBe(401);
    expect((await fetch(url.replace('/mcp', '/healthz'))).status).toBe(200);

    const client = new Client({ name: 'test-http', version: '0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { authorization: 'Bearer lena-token-0123456789' } } }));
    expect((await client.listTools()).tools.map((t) => t.name)).toContain('tacit_lookup');
    expect(textOf(await client.callTool({ name: 'tacit_lookup', arguments: { query: 'refund window' } }))).toContain('Refund window');
    await client.close();
  });
});
