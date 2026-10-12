/**
 * Folder organizer: resolves/creates the Drive hierarchy
 *   root → <year> → <YYYY-MM — شهر> → <section>
 * against a DriveClient, caching IDs in motard_drive_folders. Idempotent by
 * construction: every level is looked up before it is created, and the cache
 * is re-verified on demand (reconcile).
 */
import { and, eq, isNull } from "drizzle-orm";
import { motardDriveFolders } from "../orm/sqlite/schemas/drive-archive.table.js";
import { DRIVE_ROOT_NAME, monthFolderName, type SectionKey, sectionLabel } from "./archiveCore.js";
import type { DriveClient } from "./driveClient.js";
import type { DB } from "../orm/sqlite/drizzleCompat.js";

export type FolderChain = { rootId: string; yearId: string; monthId: string; sectionId: string };

function nowIso(): string {
  return new Date().toISOString();
}

export class FolderOrganizer {
  constructor(
    private readonly db: DB,
    private readonly drive: DriveClient,
  ) {}

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

  /** Full chain for a document upload; every step idempotent. */
  async ensureChain(businessDate: string, section: SectionKey): Promise<FolderChain> {
    const year = businessDate.slice(0, 4);
    const periodKey = businessDate.slice(0, 7);
    const rootId = await this.resolve("root", null, DRIVE_ROOT_NAME);
    const yearId = await this.resolve("year", rootId, year);
    const monthId = await this.resolve("month", yearId, monthFolderName(periodKey));
    const sectionId = await this.resolve("section", monthId, sectionLabel(section));
    return { rootId, yearId, monthId, sectionId };
  }

  /** Verify a cached id still exists (used before marking `done`). */
  async verify(sectionDriveId: string): Promise<boolean> {
    return (await this.drive.getFile(sectionDriveId)) !== null;
  }
}
