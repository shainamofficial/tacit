// Production catalog: what the connectors can list with a stored credential.
// Kept apart from server.ts so the flow is testable with a static catalog.
import { FOLDER_MIME, GoogleDriveApi, driveFromOAuth } from '@tacit/connector-gdrive';
import { octokitForInstallation } from '@tacit/connector-github';
import { slackFromToken } from '@tacit/connector-slack';
import type { Catalog, CatalogEntry } from './catalog';
import type { Credential, SourceKind } from './oauth';

export interface WiringConfig {
  readonly google: { clientId: string; clientSecret: string } | null;
  readonly githubApp: { appId: string | number; privateKey: string } | null;
}

export function connectorCatalog(cfg: WiringConfig): Catalog {
  return {
    async list(kind: SourceKind, credential: Credential): Promise<CatalogEntry[]> {
      switch (kind) {
        case 'slack': {
          if (!credential.access_token) return [];
          const api = slackFromToken(credential.access_token);
          const convs = await api.listConversations();
          return convs
            .filter((c) => !c.isArchived && !c.isIm && !c.isMpim)
            .sort((a, b) => a.name.localeCompare(b.name))
            .map((c) => ({ id: c.name, label: `#${c.name}`, ...(c.isPrivate ? { detail: 'private' } : {}) }));
        }
        case 'gdrive': {
          if (!cfg.google) return [];
          const api = new GoogleDriveApi(driveFromOAuth(cfg.google, { ...(credential.refresh_token ? { refresh_token: credential.refresh_token } : {}), ...(credential.access_token ? { access_token: credential.access_token } : {}) }));
          const files = await api.listFiles();
          return files
            .filter((f) => f.mimeType === FOLDER_MIME && f.folderPath === '')
            .sort((a, b) => a.name.localeCompare(b.name))
            .map((f): CatalogEntry => (f.permissions === null ? { id: f.name, label: f.name, detail: 'permissions unreadable — will be skipped' } : { id: f.name, label: f.name }));
        }
        case 'github': {
          if (!cfg.githubApp || !credential.installation_id) return [];
          const octokit = await octokitForInstallation({ ...cfg.githubApp, installationId: credential.installation_id });
          const repos = await octokit.paginate(octokit.rest.apps.listReposAccessibleToInstallation, { per_page: 100 });
          return repos.map((r) => ({ id: r.full_name, label: r.full_name, ...(r.private ? { detail: 'private' } : {}) })).sort((a, b) => a.id.localeCompare(b.id));
        }
      }
    },
  };
}
