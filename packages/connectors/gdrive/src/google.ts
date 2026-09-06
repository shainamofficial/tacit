// googleapis-backed DriveApi (read-only scope: drive.readonly). Docs are
// exported as text/plain; text-like files are read as media; other types
// (Sheets, Slides, images, PDFs) are skipped in P0.
import { auth as googleAuth, drive, type drive_v3 } from '@googleapis/drive';
import { DOC_MIME, FOLDER_MIME, type DriveApi, type DriveChange, type DriveFile, type DrivePermission } from './api';

export const DRIVE_READONLY_SCOPE = 'https://www.googleapis.com/auth/drive.readonly';

/** Service account with domain-wide delegation, impersonating `subject` (an admin or the owner). */
export function driveFromServiceAccount(key: { client_email: string; private_key: string }, subject?: string): drive_v3.Drive {
  // The JWT class re-exported by @googleapis/drive keeps auth and client on one google-auth-library version.
  const jwt = new googleAuth.JWT({ email: key.client_email, key: key.private_key, scopes: [DRIVE_READONLY_SCOPE], ...(subject ? { subject } : {}) });
  return drive({ version: 'v3', auth: jwt });
}

const FILE_FIELDS = 'id,name,mimeType,modifiedTime,parents,trashed,webViewLink,permissions(type,emailAddress,domain,role)';
const TEXT_MIMES = new Set(['text/plain', 'text/markdown', 'text/csv', 'application/json', 'text/x-markdown']);

export class GoogleDriveApi implements DriveApi {
  private readonly folderCache = new Map<string, { name: string; parents: readonly string[] }>();

  constructor(private readonly d: drive_v3.Drive) {}

  private toPermission(p: drive_v3.Schema$Permission): DrivePermission | null {
    if (p.type !== 'user' && p.type !== 'group' && p.type !== 'domain' && p.type !== 'anyone') return null;
    return {
      type: p.type,
      ...(p.emailAddress ? { emailAddress: p.emailAddress } : {}),
      ...(p.domain ? { domain: p.domain } : {}),
      role: p.role ?? 'reader',
    };
  }

  private async folderPath(parents: readonly string[]): Promise<string> {
    const names: string[] = [];
    let current = parents[0];
    const guard = new Set<string>();
    while (current && !guard.has(current)) {
      guard.add(current);
      let folder = this.folderCache.get(current);
      if (!folder) {
        const { data } = await this.d.files.get({ fileId: current, fields: 'id,name,parents,mimeType', supportsAllDrives: true });
        if (data.mimeType !== FOLDER_MIME) break;
        folder = { name: data.name ?? '', parents: data.parents ?? [] };
        this.folderCache.set(current, folder);
      }
      if (folder.name === 'My Drive' && folder.parents.length === 0) break;
      names.unshift(folder.name);
      current = folder.parents[0];
    }
    return names.join('/');
  }

  private async toFile(f: drive_v3.Schema$File): Promise<DriveFile> {
    const parents = f.parents ?? [];
    const permissions = f.permissions ? f.permissions.map((p) => this.toPermission(p)).filter((p): p is DrivePermission => p !== null) : null;
    return {
      id: f.id ?? '',
      name: f.name ?? '',
      mimeType: f.mimeType ?? '',
      modifiedTime: f.modifiedTime ?? new Date(0).toISOString(),
      parents,
      folderPath: await this.folderPath(parents),
      permissions,
      trashed: f.trashed ?? false,
      ...(f.webViewLink ? { webViewLink: f.webViewLink } : {}),
    };
  }

  async listFiles(): Promise<DriveFile[]> {
    const out: DriveFile[] = [];
    let pageToken: string | undefined;
    do {
      const { data } = await this.d.files.list({
        q: 'trashed = false',
        fields: `nextPageToken, files(${FILE_FIELDS})`,
        pageSize: 1000,
        includeItemsFromAllDrives: true,
        supportsAllDrives: true,
        ...(pageToken ? { pageToken } : {}),
      });
      for (const f of data.files ?? []) {
        if (f.mimeType === FOLDER_MIME && f.id) this.folderCache.set(f.id, { name: f.name ?? '', parents: f.parents ?? [] });
      }
      for (const f of data.files ?? []) out.push(await this.toFile(f));
      pageToken = data.nextPageToken ?? undefined;
    } while (pageToken);
    return out;
  }

  async getText(file: DriveFile): Promise<string | null> {
    if (file.mimeType === DOC_MIME) {
      const res = await this.d.files.export({ fileId: file.id, mimeType: 'text/plain' }, { responseType: 'text' });
      return typeof res.data === 'string' ? res.data : null;
    }
    if (TEXT_MIMES.has(file.mimeType) || file.mimeType.startsWith('text/')) {
      const res = await this.d.files.get({ fileId: file.id, alt: 'media', supportsAllDrives: true }, { responseType: 'text' });
      return typeof res.data === 'string' ? res.data : null;
    }
    return null;
  }

  async getStartPageToken(): Promise<string> {
    const { data } = await this.d.changes.getStartPageToken({ supportsAllDrives: true });
    if (!data.startPageToken) throw new Error('Drive returned no startPageToken');
    return data.startPageToken;
  }

  async listChanges(pageToken: string): Promise<{ changes: DriveChange[]; newStartPageToken: string }> {
    const changes: DriveChange[] = [];
    let token: string | undefined = pageToken;
    let newStart = pageToken;
    while (token) {
      const { data }: { data: drive_v3.Schema$ChangeList } = await this.d.changes.list({
        pageToken: token,
        fields: `nextPageToken, newStartPageToken, changes(fileId, removed, file(${FILE_FIELDS}))`,
        includeRemoved: true,
        includeItemsFromAllDrives: true,
        supportsAllDrives: true,
        pageSize: 1000,
      });
      for (const c of data.changes ?? []) {
        changes.push({ fileId: c.fileId ?? '', removed: c.removed ?? false, ...(c.file ? { file: await this.toFile(c.file) } : {}) });
      }
      if (data.newStartPageToken) newStart = data.newStartPageToken;
      token = data.nextPageToken ?? undefined;
    }
    return { changes, newStartPageToken: newStart };
  }
}
