// @tacit/admin — the connect flow (F-ADM-1): read-only OAuth per source with
// scopes shown up front (F-ING-1), include/exclude scoping (F-ING-4), and the
// permission-mapping review derived from captured ACLs (F-ING-3), plus the
// scan-report CLI (F-ADM-4).
export { StaticCatalog, type Catalog, type CatalogEntry } from './catalog';
export { EncryptedPgCredentialStore, MemoryCredentialStore, masterKeyFromEnv, open, seal, type CredentialStore } from './credentials';
export { MemoryAdminDb, PgAdminDb, ScopeConfig, type AclGroup, type AdminDb, type OrgRow, type SourceRow, type SourceStatus } from './db';
export { githubAppProvider, googleDriveProvider, signState, slackProvider, verifyState, type Credential, type FetchFn, type OAuthProvider, type SourceKind, type StatePayload } from './oauth';
export { approvalFor, approvePatch, isApproved, mapPermissions, type Approval, type MappingRow, type PermissionMapping } from './permissions';
export { createAdminHandler, startAdminServer, type AdminDeps } from './server';
