// @tacit/connector-gdrive — Google Drive read-only connector: full listing,
// changes-API delta sync, per-file ACL capture (F-ING-1..4, F-ING-6).
export { DOC_MIME, FOLDER_MIME, type DriveApi, type DriveChange, type DriveFile, type DrivePermission, type DrivePermissionType } from './api';
export { CURSOR_KEY, FILE_PREFIX, aclFromPermissions, backfillDrive, fileInScope, syncDriveChanges, type DriveSyncOptions } from './connector';
export { DRIVE_READONLY_SCOPE, GoogleDriveApi, driveFromServiceAccount } from './google';
