import { and, asc, eq, sql } from "drizzle-orm";
import type { DB, Tx } from "../orm/drizzle.js";
import { runWithTenantContext } from "../orm/tenant-context.js";
import type {
  ClaimDocumentNumberBlockInput,
  DocumentNumberBlockRow,
  DocumentNumberBlockStatus,
  IDocumentNumberBlockRepository,
} from "../../application/ports/IDocumentNumberBlockRepository.js";
import { documentNumberBlocks } from "../orm/schemas/document-number-block.table.js";

function mapRow(row: typeof documentNumberBlocks.$inferSelect): DocumentNumberBlockRow {
  return {
    id: row.id,
    tenantId: row.tenantId,
    syncDeviceId: row.syncDeviceId,
    entityType: row.entityType,
    year: row.year,
    prefix: row.prefix,
    startNumber: row.startNumber,
    endNumber: row.endNumber,
    nextNumber: row.nextNumber,
    status: row.status as DocumentNumberBlockStatus,
    claimedAt: row.claimedAt,
    updatedAt: row.updatedAt,
    reclaimedAt: row.reclaimedAt,
  };
}

export class PostgresDocumentNumberBlockRepository implements IDocumentNumberBlockRepository {
  constructor(private readonly db: DB) {}

  async findActive(
    tenantId: string,
    syncDeviceId: string,
    entityType: string,
    year: number,
  ): Promise<DocumentNumberBlockRow | null> {
    return runWithTenantContext({ tenantId }, async () => {
      const [row] = await this.db
        .select()
        .from(documentNumberBlocks)
        .where(
          and(
            eq(documentNumberBlocks.tenantId, tenantId),
            eq(documentNumberBlocks.syncDeviceId, syncDeviceId),
            eq(documentNumberBlocks.entityType, entityType),
            eq(documentNumberBlocks.year, year),
            eq(documentNumberBlocks.status, "active"),
          ),
        )
        .orderBy(asc(documentNumberBlocks.startNumber))
        .limit(1);
      return row ? mapRow(row) : null;
    });
  }

  async listForDevice(tenantId: string, syncDeviceId: string): Promise<DocumentNumberBlockRow[]> {
    return runWithTenantContext({ tenantId }, async () => {
      const rows = await this.db
        .select()
        .from(documentNumberBlocks)
        .where(
          and(
            eq(documentNumberBlocks.tenantId, tenantId),
            eq(documentNumberBlocks.syncDeviceId, syncDeviceId),
          ),
        )
        .orderBy(asc(documentNumberBlocks.claimedAt));
      return rows.map(mapRow);
    });
  }

  async insertClaimed(input: ClaimDocumentNumberBlockInput): Promise<DocumentNumberBlockRow> {
    return runWithTenantContext({ tenantId: input.tenantId }, async () => {
      const [row] = await this.db
        .insert(documentNumberBlocks)
        .values({
          tenantId: input.tenantId,
          syncDeviceId: input.syncDeviceId,
          entityType: input.entityType,
          year: input.year,
          prefix: input.prefix,
          startNumber: input.startNumber,
          endNumber: input.endNumber,
          nextNumber: input.startNumber,
          status: "active",
        })
        .returning();
      return mapRow(row);
    });
  }

  async consumeNext(
    tenantId: string,
    syncDeviceId: string,
    entityType: string,
    year: number,
  ): Promise<{ numberValue: number; block: DocumentNumberBlockRow } | null> {
    return runWithTenantContext({ tenantId }, async () => {
      return this.db.transaction(async (tx) => {
        return consumeNextInTx(tx, tenantId, syncDeviceId, entityType, year);
      });
    });
  }

  async reclaimTail(
    tenantId: string,
    blockId: string,
    currentGlobalLast: number,
  ): Promise<{ reclaimed: number; block: DocumentNumberBlockRow | null }> {
    return runWithTenantContext({ tenantId }, async () => {
      const [row] = await this.db
        .select()
        .from(documentNumberBlocks)
        .where(
          and(eq(documentNumberBlocks.id, blockId), eq(documentNumberBlocks.tenantId, tenantId)),
        )
        .limit(1);
      if (!row || row.status !== "active") {
        return { reclaimed: 0, block: row ? mapRow(row) : null };
      }
      // Only reclaim if this block is still the tip of the global counter —
      // otherwise later blocks already own higher numbers.
      if (row.endNumber !== currentGlobalLast) {
        return { reclaimed: 0, block: mapRow(row) };
      }
      const unused = row.endNumber - row.nextNumber + 1;
      if (unused <= 0) {
        const [exhausted] = await this.db
          .update(documentNumberBlocks)
          .set({ status: "exhausted", updatedAt: new Date() })
          .where(eq(documentNumberBlocks.id, row.id))
          .returning();
        return { reclaimed: 0, block: exhausted ? mapRow(exhausted) : mapRow(row) };
      }
      const newEnd = row.nextNumber - 1;
      const [updated] = await this.db
        .update(documentNumberBlocks)
        .set({
          endNumber: Math.max(newEnd, row.startNumber - 1),
          status: row.nextNumber > row.endNumber || newEnd < row.startNumber ? "exhausted" : "reclaimed",
          reclaimedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(documentNumberBlocks.id, row.id))
        .returning();
      return { reclaimed: unused, block: updated ? mapRow(updated) : mapRow(row) };
    });
  }
}

/** Consume inside an existing tx (invoice create shares the same transaction). */
export async function consumeNextInTx(
  tx: Tx,
  tenantId: string,
  syncDeviceId: string,
  entityType: string,
  year: number,
): Promise<{ numberValue: number; block: DocumentNumberBlockRow } | null> {
  const [row] = await tx
    .select()
    .from(documentNumberBlocks)
    .where(
      and(
        eq(documentNumberBlocks.tenantId, tenantId),
        eq(documentNumberBlocks.syncDeviceId, syncDeviceId),
        eq(documentNumberBlocks.entityType, entityType),
        eq(documentNumberBlocks.year, year),
        eq(documentNumberBlocks.status, "active"),
        sql`${documentNumberBlocks.nextNumber} <= ${documentNumberBlocks.endNumber}`,
      ),
    )
    .orderBy(asc(documentNumberBlocks.startNumber))
    .limit(1)
    .for("update");

  if (!row) return null;

  const numberValue = row.nextNumber;
  const exhausted = numberValue >= row.endNumber;
  const [updated] = await tx
    .update(documentNumberBlocks)
    .set({
      nextNumber: numberValue + 1,
      status: exhausted ? "exhausted" : "active",
      updatedAt: new Date(),
    })
    .where(eq(documentNumberBlocks.id, row.id))
    .returning();

  return {
    numberValue,
    block: mapRow(updated ?? { ...row, nextNumber: numberValue + 1, status: exhausted ? "exhausted" : "active" }),
  };
}
