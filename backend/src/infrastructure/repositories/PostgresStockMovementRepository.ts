import { and, eq, desc, gte, lte } from "drizzle-orm";
import { stockMovements } from "../orm/schemas/index.js";
import type { DB, Tx } from "../orm/drizzle.js";
import type { TenantContext, UUID } from "../../domain/types/index.js";
import type {
  IStockMovementRepository,
  RecordStockMovementInput,
  StockMovementData,
  StockMovementFilter,
} from "../../application/ports/IStockMovementRepository.js";

export class PostgresStockMovementRepository implements IStockMovementRepository {
  constructor(private readonly db: DB) {}

  async record(tx: Tx, input: RecordStockMovementInput, ctx: TenantContext): Promise<void> {
    await tx.insert(stockMovements).values({
      tenantId: ctx.tenantId,
      rollId: input.rollId,
      direction: input.direction,
      movementType: input.movementType,
      quantityKg: String(input.quantityKg),
      balanceAfterKg: String(input.balanceAfterKg),
      referenceType: input.referenceType,
      referenceId: input.referenceId,
      referenceNumber: input.referenceNumber,
      movementDate: input.movementDate,
      description: input.description,
      createdBy: ctx.userId,
    });
  }

  async listByRoll(
    rollId: UUID,
    ctx: TenantContext,
    filter?: StockMovementFilter,
  ): Promise<StockMovementData[]> {
    const conds = [eq(stockMovements.rollId, rollId), eq(stockMovements.tenantId, ctx.tenantId)];
    if (filter?.movementType) conds.push(eq(stockMovements.movementType, filter.movementType));
    if (filter?.fromDate) conds.push(gte(stockMovements.movementDate, filter.fromDate));
    if (filter?.toDate) conds.push(lte(stockMovements.movementDate, filter.toDate));

    const rows = await this.db
      .select()
      .from(stockMovements)
      .where(and(...conds))
      .orderBy(desc(stockMovements.createdAt))
      .limit(filter?.limit ?? 200);

    return rows.map((r) => this.toDomain(r));
  }

  private toDomain(r: typeof stockMovements.$inferSelect): StockMovementData {
    return {
      id: r.id,
      tenantId: r.tenantId,
      rollId: r.rollId,
      direction: r.direction as StockMovementData["direction"],
      movementType: r.movementType as StockMovementData["movementType"],
      quantityKg: Number(r.quantityKg),
      balanceAfterKg: Number(r.balanceAfterKg),
      referenceType: r.referenceType,
      referenceId: r.referenceId,
      referenceNumber: r.referenceNumber,
      movementDate: r.movementDate,
      description: r.description,
      status: r.status,
      createdBy: r.createdBy,
      createdAt: r.createdAt.toISOString(),
    };
  }
}
