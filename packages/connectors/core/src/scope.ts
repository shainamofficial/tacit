// Scope keys (F-SEC-1). Every synced item carries one in `meta.scope_key`,
// written at ingest by its connector; an artifact's permission_scope is the
// set of scope keys of everything it cites, and a reader must hold all of
// them. The key names the ACL boundary, not the item: one per Drive file
// (each has its own sharing), one per Slack conversation, one per repo.

export const scopeKeys = {
  driveDoc: (fileId: string): string => `gdrive:doc:${fileId}`,
  slackConversation: (c: { id: string; isIm?: boolean; isMpim?: boolean }): string => (c.isIm || c.isMpim ? `slack:dm:${c.id}` : `slack:channel:${c.id}`),
  githubRepo: (owner: string, repo: string): string => `github:repo:${owner}/${repo}`,
  zendesk: (): string => 'zendesk:all',
} as const;

/** The scope key recorded on an item at ingest, or null when the connector did not set one (fail closed). */
export function scopeKeyOf(meta: Readonly<Record<string, unknown>> | null | undefined): string | null {
  const v = meta?.scope_key;
  return typeof v === 'string' && v.length > 0 ? v : null;
}
