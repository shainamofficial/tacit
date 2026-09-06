// A DriveApi served from the generated Northwind Drive export (drive/index.json
// + markdown bodies), with in-memory mutations that surface through the
// changes API. Test-only.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { DOC_MIME, FOLDER_MIME, type DriveApi, type DriveChange, type DriveFile, type DrivePermission } from '../api';

interface IndexEntry {
  id: string;
  title: string;
  path: string;
  folder: string;
  mimeType: string;
  modifiedTime: string;
  owners: string[];
  acl: { kind: 'domain'; domain: string } | { kind: 'users'; emails: string[] };
}

export interface CorpusDrive extends DriveApi {
  /** Overwrite a doc's body and register a change. */
  update(fileId: string, content: string): void;
  /** Trash a doc and register a change. */
  remove(fileId: string): void;
  readonly docs: readonly DriveFile[];
}

export function corpusDriveApi(corpusDir: string): CorpusDrive {
  const index = JSON.parse(readFileSync(path.join(corpusDir, 'drive/index.json'), 'utf8')) as IndexEntry[];
  const bodies = new Map<string, string>();
  const trashed = new Set<string>();
  const changes: DriveChange[] = [];
  const modified = new Map<string, string>();

  const permissions = (e: IndexEntry): DrivePermission[] => {
    const owner: DrivePermission[] = e.owners.map((o) => ({ type: 'user', emailAddress: o, role: 'owner' }));
    if (e.acl.kind === 'domain') return [...owner, { type: 'domain', domain: e.acl.domain, role: 'reader' }];
    return [...owner, ...e.acl.emails.map((em): DrivePermission => ({ type: 'user', emailAddress: em, role: 'reader' }))];
  };
  const folderId = (name: string): string => `folder:${name}`;
  const toFile = (e: IndexEntry): DriveFile => ({
    id: e.id,
    name: e.title,
    mimeType: DOC_MIME,
    modifiedTime: modified.get(e.id) ?? e.modifiedTime,
    parents: [folderId(e.folder)],
    folderPath: e.folder,
    permissions: permissions(e),
    trashed: trashed.has(e.id),
    webViewLink: `https://docs.google.example/document/d/${e.id}`,
  });
  const folders: DriveFile[] = [...new Set(index.map((e) => e.folder))].map((name) => ({
    id: folderId(name),
    name,
    mimeType: FOLDER_MIME,
    modifiedTime: '2025-01-01T00:00:00Z',
    parents: [],
    folderPath: '',
    permissions: [{ type: 'domain', domain: 'northwindrobotics.example', role: 'reader' }],
    trashed: false,
  }));
  for (const e of index) bodies.set(e.id, readFileSync(path.join(corpusDir, e.path), 'utf8'));
  const byId = new Map(index.map((e) => [e.id, e] as const));

  return {
    get docs() {
      return index.map(toFile);
    },
    async listFiles() {
      return [...folders, ...index.map(toFile)];
    },
    async getText(file) {
      if (file.mimeType !== DOC_MIME) return null;
      return bodies.get(file.id) ?? null;
    },
    async getStartPageToken() {
      return String(changes.length);
    },
    async listChanges(pageToken) {
      const from = Number(pageToken);
      return { changes: changes.slice(from), newStartPageToken: String(changes.length) };
    },
    update(fileId, content) {
      const e = byId.get(fileId);
      if (!e) throw new Error(`unknown doc ${fileId}`);
      bodies.set(fileId, content);
      modified.set(fileId, new Date(Date.parse(e.modifiedTime) + 86_400_000).toISOString());
      changes.push({ fileId, removed: false, file: toFile(e) });
    },
    remove(fileId) {
      const e = byId.get(fileId);
      if (!e) throw new Error(`unknown doc ${fileId}`);
      trashed.add(fileId);
      changes.push({ fileId, removed: true });
    },
  };
}
