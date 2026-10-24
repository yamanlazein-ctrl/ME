/**
 * Folder organizer: resolves/creates the Drive hierarchy
 *   root → <year> → <YYYY-MM — شهر> → <section>
 * against a DriveClient, caching IDs in motard_drive_folders. Idempotent by
 * construction: every level is looked up before it is created, and the cache
 * is re-verified on demand (reconcile).
 */
import { and, eq, isNull } from "drizzle-orm";
import { motardDriveFolders } from "../orm/sqlite/schemas/drive-archive.table.js";
import {
  categoryFolder,
  companyFolderName,
  monthFolder,
  yearFolder,
  type ArchiveCategory,
} from "@erp/shared";
import type { DriveClient } from "./driveClient.js";
import type { DB } from "../orm/sqlite/drizzleCompat.js";

export type FolderChain = { rootId: string; yearId: string; monthId: string; sectionId: string };

/** Legacy root label written before Phase 2 (kept only to find and rename the existing folder). */
export const LEGACY_ROOT_LABEL = "Motard ERP - أرشيف النظام";

function nowIso(): string {
  return new Date().toISOString();
}

export class FolderOrganizer {
  constructor(
    private readonly db: DB,
    private readonly drive: DriveClient,
    /** Reads the company name when a root is needed (a pass, not boot), so a rename applies. */
    private readonly companyName: () => Promise<string | null> = async () => null,
  ) {}

  /** The company-named root for this pass. Resolved per call so a rename in Settings is picked up. */
  private async rootNameNow(): Promise<string> {
    return companyFolderName(await this.companyName());
  }

  /** Cache row for (kind, parent, label) — miss when absent or reconciled invalid. */
  private async cached(kind: string, parent: string | null, label: string): Promise<string | null> {
    const rows = await this.db
      .select()
      .from(motardDriveFolders)
      .where(
        parent === null
          ? and(
              eq(motardDriveFolders.kind, kind),
              eq(motardDriveFolders.label, label),
              isNull(motardDriveFolders.parentDriveId),
            )
          : and(
              eq(motardDriveFolders.kind, kind),
              eq(motardDriveFolders.label, label),
              eq(motardDriveFolders.parentDriveId, parent),
            ),
      )
      .limit(1);
    return rows[0]?.driveFileId ?? null;
  }

  /** The single cached root row, whatever its label (the company name at the time it was written). */
  private async anyCachedRoot(): Promise<{ driveFileId: string; label: string } | null> {
    const rows = await this.db
      .select({ driveFileId: motardDriveFolders.driveFileId, label: motardDriveFolders.label })
      .from(motardDriveFolders)
      .where(and(eq(motardDriveFolders.kind, "root"), isNull(motardDriveFolders.parentDriveId)))
      .limit(1);
    return rows[0] ?? null;
  }

  private async remember(
    kind: string,
    parent: string | null,
    label: string,
    driveFileId: string,
  ): Promise<void> {
    await this.db
      .insert(motardDriveFolders)
      .values({
        kind,
        parentDriveId: parent,
        label,
        driveFileId,
        verifiedAt: nowIso(),
        createdAt: nowIso(),
      })
      .onConflictDoNothing();
  }

  /** Resolve-or-create one level, through the cache first. */
  private async resolve(kind: string, parent: string | null, label: string): Promise<string> {
    const hit = await this.cached(kind, parent, label);
    if (hit) {
      const still = await this.drive.getFile(hit);
      if (still) return hit;
      // Stale cache row (folder deleted out-of-band): drop it and fall through.
      await this.db.delete(motardDriveFolders).where(eq(motardDriveFolders.driveFileId, hit));
    }
    if (parent !== null) {
      const existing = await this.drive.findChild(parent, label);
      if (existing) {
        await this.remember(kind, parent, label, existing.id);
        return existing.id;
      }
    }
    const created = await this.drive.createFolder(parent, label);
    await this.remember(kind, parent, label, created.id);
    return created.id;
  }

  /**
   * Resolve the company root. If a root from before Phase 2 exists under the legacy label, it is
   * renamed IN PLACE (same Drive id, so no files move) and its cache row is relabelled. Owner decision:
   * rename the existing folder rather than create a second root.
   */
  private async resolveRoot(): Promise<string> {
    const rootName = await this.rootNameNow();
    const current = await this.cached("root", null, rootName);
    if (current && (await this.drive.getFile(current))) return current;

    // Any root we created before, under the legacy label or an earlier company name, is renamed in
    // place: the same Drive folder id, so no archive files are moved or duplicated.
    const previous = await this.anyCachedRoot();
    if (previous && (await this.drive.getFile(previous.driveFileId))) {
      if (previous.label !== rootName) await this.drive.renameFile(previous.driveFileId, rootName);
      await this.db
        .update(motardDriveFolders)
        .set({ label: rootName, verifiedAt: nowIso() })
        .where(eq(motardDriveFolders.driveFileId, previous.driveFileId));
      return previous.driveFileId;
    }
    return this.resolve("root", null, rootName);
  }

  /** Full chain for a document upload; every step idempotent. */
  async ensureChain(businessDate: string, category: ArchiveCategory): Promise<FolderChain> {
    const rootId = await this.resolveRoot();
    const yearId = await this.resolve("year", rootId, yearFolder(businessDate));
    const monthId = await this.resolve("month", yearId, monthFolder(businessDate));
    const sectionId = await this.resolve("section", monthId, categoryFolder(category));
    return { rootId, yearId, monthId, sectionId };
  }

  /** Verify a cached id still exists (used before marking `done`). */
  async verify(sectionDriveId: string): Promise<boolean> {
    return (await this.drive.getFile(sectionDriveId)) !== null;
  }
}
