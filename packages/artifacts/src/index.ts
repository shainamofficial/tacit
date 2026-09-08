// @tacit/artifacts — the artifact read path: lexical search, permission-filtered
// tiered retrieval (F-SRV-1..3, F-SEC-1), and the stores behind it (a local
// snapshot for dev/eval, Postgres for production; supersede-never-delete).
export { PgArtifactStore, fromRow, toRow, type Queryable } from './pg';
export { Retriever, canSee, refKey, type LookupEntry, type LookupResult, type ServeArtifact, type ServeClaim, type ServeItem, type SourceRef, type SourceSpan } from './retrieve';
export { buildSearchIndex, excerptWindows, queryTokens, searchIndex, sharedRareTerms, tokenize, type SearchDoc, type SearchHit, type SearchIndex } from './search';
export { SnapshotStore, writeSnapshot, type ArtifactSource, type ScopeResolver, type ServeSnapshot } from './snapshot';
