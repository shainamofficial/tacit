// Stateless Streamable HTTP endpoint: `POST /mcp` with a bearer token. Each
// request authenticates the user, builds a server bound to that user, and
// answers through a fresh transport — no session state to leak between users.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { Authenticator } from './auth';
import { createTacitServer, type ServerDeps } from './server';

export interface HttpDeps extends ServerDeps {
  readonly auth: Authenticator;
  readonly path?: string;
}

function bearer(req: IncomingMessage): string | null {
  const h = req.headers.authorization;
  if (!h) return null;
  const m = /^Bearer\s+(.+)$/i.exec(h.trim());
  return m?.[1]?.trim() || null;
}

function reject(res: ServerResponse, status: number, message: string): void {
  if (status === 401) res.setHeader('WWW-Authenticate', 'Bearer realm="tacit"');
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ error: message }));
}

export function createHttpHandler(deps: HttpDeps): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  const path = deps.path ?? '/mcp';
  const log = deps.log ?? (() => undefined);
  return async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (url.pathname === '/healthz') {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('ok');
      return;
    }
    if (url.pathname !== path) {
      reject(res, 404, 'not found');
      return;
    }
    const token = bearer(req);
    const user = token ? await deps.auth.authenticate(token) : null;
    if (!user) {
      log({ event: 'mcp_auth_rejected', has_token: token !== null });
      reject(res, 401, 'a per-user bearer token is required');
      return;
    }
    const server = createTacitServer(deps, user);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on('close', () => {
      void transport.close();
      void server.close();
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res);
    } catch (err) {
      log({ event: 'mcp_request_error', org_id: user.orgId, message: err instanceof Error ? err.message : String(err) });
      if (!res.headersSent) reject(res, 500, 'internal error');
    }
  };
}

export async function startHttpServer(deps: HttpDeps, port: number, host = '127.0.0.1'): Promise<{ server: Server; port: number; url: string }> {
  const server = createServer((req, res) => {
    void createHttpHandler(deps)(req, res);
  });
  await new Promise<void>((resolve) => server.listen(port, host, resolve));
  const address = server.address();
  const actualPort = typeof address === 'object' && address ? address.port : port;
  return { server, port: actualPort, url: `http://${host}:${actualPort}${deps.path ?? '/mcp'}` };
}
