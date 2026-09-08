// @tacit/mcp-server — MCP server: tacit_lookup / tacit_get_artifact / tacit_get_sources,
// per-user auth, ACL filter at query time, query-miss logging (F-SRV-1..4).
export { StaticTokenAuthenticator, TokenTable, type Authenticator, type McpUser } from './auth';
export { MemoryGapSink, PgGapSink, type GapSink, type QueryMiss } from './gaps';
export { createHttpHandler, startHttpServer, type HttpDeps } from './http';
export { TOOL_DESCRIPTIONS, createTacitServer, renderCard, type ServerDeps } from './server';
