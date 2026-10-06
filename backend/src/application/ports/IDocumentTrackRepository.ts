/** Document tracking list (all document kinds, one page) — per engine (specs/001-desktop-sqlite-engine S4). */
import type { TenantContext } from "../../domain/types/index.js";
import type { DocumentTrackFilter, DocumentTrackPage } from "../../infrastructure/repositories/PostgresDocumentTrackRepository.js";

export type { DocumentTrackFilter, DocumentTrackPage };

export interface IDocumentTrackRepository {
  list(f: DocumentTrackFilter, ctx: TenantContext): Promise<DocumentTrackPage>;
}
