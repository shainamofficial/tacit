// The slice of Google Drive the connector needs. Implemented by the
// googleapis adapter (google.ts) and by a corpus-backed fake for tests.

export type DrivePermissionType = 'user' | 'group' | 'domain' | 'anyone';

export interface DrivePermission {
  readonly type: DrivePermissionType;
  readonly emailAddress?: string;
  readonly domain?: string;
  readonly role: string;
}

export interface DriveFile {
  readonly id: string;
  readonly name: string;
  readonly mimeType: string;
  readonly modifiedTime: string;
  readonly parents: readonly string[];
  /** "Folder/Subfolder" resolved by the adapter; "" at the root */
  readonly folderPath: string;
  /** null when the identity cannot read permissions → the connector fails closed */
  readonly permissions: readonly DrivePermission[] | null;
  readonly trashed: boolean;
  readonly webViewLink?: string;
}

export interface DriveChange {
  readonly fileId: string;
  readonly removed: boolean;
  readonly file?: DriveFile;
}

export interface DriveApi {
  /** Every non-trashed file and folder visible to the identity. */
  listFiles(): Promise<DriveFile[]>;
  /** Exported text for Docs / raw text for text files; null for anything else. */
  getText(file: DriveFile): Promise<string | null>;
  getStartPageToken(): Promise<string>;
  /** All changes since `pageToken` (adapter paginates), plus the token to store for next time. */
  listChanges(pageToken: string): Promise<{ changes: DriveChange[]; newStartPageToken: string }>;
}

export const FOLDER_MIME = 'application/vnd.google-apps.folder';
export const DOC_MIME = 'application/vnd.google-apps.document';
