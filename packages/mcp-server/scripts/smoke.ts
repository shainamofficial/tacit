// Smoke: talk to a running `pnpm mcp` as two users and print what each sees.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const url = new URL(process.env.MCP_URL ?? 'http://127.0.0.1:3333/mcp');
const textOf = (r: Awaited<ReturnType<Client['callTool']>>): string => (r.content as Array<{ type: string; text?: string }>).map((c) => c.text ?? '').join('\n');

async function as(token: string, label: string): Promise<void> {
  const client = new Client({ name: 'smoke', version: '0' });
  await client.connect(new StreamableHTTPClientTransport(url, { requestInit: { headers: { authorization: `Bearer ${token}` } } }));
  console.log(`\n===== ${label}`);
  for (const q of ['What are the engineering compensation bands, and are raises planned this year?', 'What is the refund window?', 'Are layoffs being planned?']) {
    const out = textOf(await client.callTool({ name: 'tacit_lookup', arguments: { query: q, limit: 3 } }));
    console.log(`\n> ${q}\n${out}`);
    const id = /^- (\S+) \[/m.exec(out)?.[1];
    if (id && q.includes('refund')) {
      console.log(`\n>> tacit_get_artifact ${id}\n${textOf(await client.callTool({ name: 'tacit_get_artifact', arguments: { id } })).slice(0, 900)}`);
      console.log(`\n>> tacit_get_sources ${id}\n${textOf(await client.callTool({ name: 'tacit_get_sources', arguments: { id, context_lines: 1 } })).slice(0, 700)}`);
    }
  }
  await client.close();
}

await as(process.env.LENA_TOKEN ?? 'lena-smoke-token-0123456789', 'lena.fischer (engineer, unprivileged)');
await as(process.env.ALICE_TOKEN ?? 'alice-smoke-token-0123456789', 'alice.chen (CEO, exec-restricted member)');
