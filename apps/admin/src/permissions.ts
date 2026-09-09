// Permission-mapping review helpers live in @tacit/connector-core so the compiler's gate and the
// admin's review use the same digest. Re-exported here for the admin app's own modules.
export { approvalFor, approvePatch, isApproved, mapPermissions, type Approval, type MappingRow, type PermissionMapping } from '@tacit/connector-core';
