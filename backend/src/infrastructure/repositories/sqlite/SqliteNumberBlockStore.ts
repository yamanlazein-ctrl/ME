// PORTED-FROM: src/infrastructure/repositories/PostgresNumberBlockStore.ts sha256=a261946b48fdd79b9caaf70c02136bac78f1b98c4b88bc7e5694a64082f585b8
// SQLite twin (specs/001-desktop-sqlite-engine S4). Keep behavior identical to the PG source.
/** PostgreSQL SQL behind document-number blocks — moved verbatim from numberBlockUseCases.ts (S1). */
import { and, eq, sql } from "drizzle-orm";
import type { DB } from "../../orm/sqlite/drizzleCompat.js";
import { syncDevices } from "../../orm/sqlite/schemas/sync-device.table.js";
import { documentSequences } from "../../orm/sqlite/schemas/document-sequence.table.js";
import { claimNumberBlockInTx, reclaimNumberBlockTailInTx, resolveNumberFormat } from "./helpers/documentNumbers.js";
import type { INumberBlockStore } from "../../../application/ports/INumberBlockStore.js";
import type { UUID } from "../../../domain/types/index.js";

export class SqliteNumberBlockStore implements INumberBlockStore {
  constructor(private readonly db: DB) {}

  claimBlock(input: Parameters<INumberBlockStore["claimBlock"]>[0]) {
    return this.db.transaction(async (tx) => {
      if (
        typeof input.knownUsed === "number" &&
        Number.isFinite(input.knownUsed) &&
        input.knownUsed > 0
      ) {
        const { prefix } = resolveNumberFormat(input.entityType);
        await tx
          .insert(documentSequences)
          .values({
            tenantId: input.tenantId,
            entityType: input.entityType,
            prefix,
            lastNumber: Math.min(Math.floor(input.knownUsed), 999999),
          })
          .onConflictDoUpdate({
            target: [
              documentSequences.tenantId,
              documentSequences.entityType,
              documentSequences.prefix,
            ],
            set: {
              lastNumber: sql`min(
              max(${documentSequences.lastNumber}, ${Math.min(Math.floor(input.knownUsed), 999999)}),
              ${documentSequences.lastNumber} + 2000
            )`,
            },
          });
      }
      return claimNumberBlockInTx(tx, {
        tenantId: input.tenantId,
        syncDeviceId: input.syncDeviceId,
        entityType: input.entityType,
        size: input.size,
        year: input.year,
      });
    });
  }

  reclaimBlockTail(input: { tenantId: UUID; blockId: UUID }) {
    return this.db.transaction(async (tx) => {
      return reclaimNumberBlockTailInTx(tx, input);
    });
  }

  async remainingInActiveBlocks(tenantId: UUID, syncDeviceId: UUID, entityType: string, year: number): Promise<number> {
    const remainingRes = await this.db.execute(sql`
      SELECT COALESCE(SUM(end_number - next_number + 1), 0) AS remaining
        FROM document_number_blocks
       WHERE tenant_id = ${tenantId} AND sync_device_id = ${syncDeviceId}
         AND entity_type = ${entityType} AND year = ${year}
         AND status = 'active' AND next_number <= end_number`);
    return Number(
      ((remainingRes as unknown as { rows?: Array<{ remaining: number }> }).rows ?? [])[0]?.remaining ?? 0,
    );
  }

  async readSequenceTip(tenantId: UUID, entityType: string, prefix: string): Promise<number> {
    const [row] = await this.db
      .select({ lastNumber: documentSequences.lastNumber })
      .from(documentSequences)
      .where(
        and(
          eq(documentSequences.tenantId, tenantId),
          eq(documentSequences.entityType, entityType),
          eq(documentSequences.prefix, prefix),
        ),
      )
      .limit(1);
    return row?.lastNumber ?? 0;
  }

  async advanceSequenceTip(tenantId: UUID, entityType: string, prefix: string, target: number): Promise<void> {
    await this.db
      .insert(documentSequences)
      .values({ tenantId, entityType, prefix, lastNumber: target })
      .onConflictDoUpdate({
        target: [
          documentSequences.tenantId,
          documentSequences.entityType,
          documentSequences.prefix,
        ],
        set: {
          lastNumber: sql`max(${documentSequences.lastNumber}, ${target})`,
        },
      });
  }

  async deviceBelongsToTenant(tenantId: string, syncDeviceId: string): Promise<boolean> {
    const [row] = await this.db
      .select({ id: syncDevices.id })
      .from(syncDevices)
      .where(and(eq(syncDevices.id, syncDeviceId), eq(syncDevices.tenantId, tenantId)))
      .limit(1);
    return Boolean(row);
  }
}
