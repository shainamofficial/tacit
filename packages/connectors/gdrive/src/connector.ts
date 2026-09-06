// Google Drive connector: backfill + changes-API delta sync into the sync
// store with per-file ACL capture (F-ING-2, F-ING-3, F-ING-4, F-ING-6).
import { SyncCursors, SyncStore, emptyStats, inScope, tally, type Acl, type SyncStats } from '@tacit/connector-core';
import { FOLDER_MIME, type DriveApi, type DriveFile, type DrivePermission } from './api';

export interface DriveSyncOptions {
  readonly sourceId: string;
  /** The company's Google Workspace domain; domain-shared and link-shared files map to it. */
  readonly domain: string;
  /** Folder paths to include ("Engineering", "Engineering/Runbooks"); default: everything visible (F-ING-4). */
  readonly include?: readonly string[];
  readonly exclude?: readonly string[];
  readonly log?: (line: Record<string, unknown>) => void;
}

export const CURSOR_KEY = 'drive:pageToken';
export const FILE_PREFIX = 'file:';

/** Permissions are inherited, never invented: unreadable permissions mean nobody can see the item. */
export function aclFromPermissions(permissions: readonly DrivePermission[] | null, domain: string): { acl: Acl; unreadable: boolean } {
  if (permissions === null) return { acl: { kind: 'users', emails: [] }, unreadable: true };
  const wide = permissions.some((p) => p.type === 'anyone' || (p.type === 'domain' && p.domain?.toLowerCase() === domain.toLowerCase()));
  if (wide) return { acl: { kind: 'domain', domain }, unreadable: false };
  const emails: string[] = [];
  for (const p of permissions) {
    if (p.type === 'user' && p.emailAddress) emails.push(p.emailAddress);
    else if (p.type === 'group' && p.emailAddress) emails.push(`group:${p.emailAddress}`);
    else if (p.type === 'domain' && p.domain) emails.push(`domain:${p.domain}`);
  }
  return { acl: { kind: 'users', emails }, unreadable: false };
}

export function fileInScope(file: DriveFile, opts: DriveSyncOptions): boolean {
  const candidates = [file.folderPath, ...(file.folderPath ? [`${file.folderPath}/${file.name}`] : [file.name])];
  return inScope(candidates, opts.include, opts.exclude);
}

async function upsertFile(api: DriveApi, store: SyncStore, opts: DriveSyncOptions, file: DriveFile, stats: SyncStats): Promise<boolean> {
  const text = await api.getText(file);
  if (text === null) return false;
  const { acl, unreadable } = aclFromPermissions(file.permissions, opts.domain);
  if (unreadable) opts.log?.({ event: 'acl_unreadable', source: 'gdrive', file_id: file.id });
  tally(
    stats,
    await store.upsert({
      sourceId: opts.sourceId,
      externalId: `${FILE_PREFIX}${file.id}`,
      kind: 'doc',
      title: file.name,
      content: text,
      acl,
      meta: {
        mime_type: file.mimeType,
        modified_time: file.modifiedTime,
        path: file.folderPath ? `${file.folderPath}/${file.name}` : file.name,
        web_view_link: file.webViewLink ?? null,
        acl_unreadable: unreadable,
      },
      updatedAt: new Date(file.modifiedTime),
    }),
  );
  return true;
}

/** Full listing. Takes the changes-API start token first so nothing between listing and the next delta is lost. */
export async function backfillDrive(api: DriveApi, store: SyncStore, cursors: SyncCursors, opts: DriveSyncOptions): Promise<SyncStats> {
  const stats = emptyStats();
  const token = await api.getStartPageToken();
  const seen = new Set<string>();
  for (const file of await api.listFiles()) {
    if (file.trashed || file.mimeType === FOLDER_MIME || !fileInScope(file, opts)) continue;
    if (await upsertFile(api, store, opts, file, stats)) seen.add(`${FILE_PREFIX}${file.id}`);
  }
  for (const active of await store.listActive(opts.sourceId, 'doc')) {
    if (!seen.has(active.externalId) && (await store.markDeleted(opts.sourceId, active.externalId))) stats.deleted += 1;
  }
  await cursors.set(opts.sourceId, CURSOR_KEY, token);
  opts.log?.({ event: 'sync', source: 'gdrive', mode: 'backfill', ...stats });
  return stats;
}

/** Delta sync from the stored page token (F-ING-2: deltas, never full rescans). */
export async function syncDriveChanges(api: DriveApi, store: SyncStore, cursors: SyncCursors, opts: DriveSyncOptions): Promise<SyncStats> {
  const stats = emptyStats();
  const token = await cursors.get(opts.sourceId, CURSOR_KEY);
  if (!token) throw new Error(`no ${CURSOR_KEY} cursor for source ${opts.sourceId}: run backfillDrive first`);
  const { changes, newStartPageToken } = await api.listChanges(token);
  for (const change of changes) {
    const externalId = `${FILE_PREFIX}${change.fileId}`;
    const gone = change.removed || !change.file || change.file.trashed || change.file.mimeType === FOLDER_MIME || !fileInScope(change.file, opts);
    if (gone) {
      if (await store.markDeleted(opts.sourceId, externalId)) stats.deleted += 1;
      continue;
    }
    await upsertFile(api, store, opts, change.file as DriveFile, stats);
  }
  await cursors.set(opts.sourceId, CURSOR_KEY, newStartPageToken);
  opts.log?.({ event: 'sync', source: 'gdrive', mode: 'delta', changes: changes.length, ...stats });
  return stats;
}
