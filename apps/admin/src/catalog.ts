// What an admin can include or exclude before the first compile (F-ING-4):
// Slack conversations, Drive top-level folders, GitHub repositories the app
// installation can reach. The production wiring lives in wiring.ts; tests use
// a fake.
import type { Credential, SourceKind } from './oauth';

export interface CatalogEntry {
  readonly id: string;
  readonly label: string;
  readonly detail?: string;
}

export interface Catalog {
  list(kind: SourceKind, credential: Credential): Promise<CatalogEntry[]>;
}

export class StaticCatalog implements Catalog {
  constructor(private readonly entries: Readonly<Partial<Record<SourceKind, readonly CatalogEntry[]>>>) {}
  async list(kind: SourceKind): Promise<CatalogEntry[]> {
    return [...(this.entries[kind] ?? [])];
  }
}
