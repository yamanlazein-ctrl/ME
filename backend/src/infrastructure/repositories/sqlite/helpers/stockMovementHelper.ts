// PORTED-FROM: src/infrastructure/repositories/stockMovementHelper.ts sha256=6e2ec20fa335434e3396d93f880a1ef91008c1c0e8b635aa0ae650d325c1d542
// SQLite twin (specs/001-desktop-sqlite-engine S4). Keep behavior identical to the PG source.
import { stockMovements } from "../../../orm/sqlite/schemas/index.js";
import type { Tx } from "../../../orm/sqlite/drizzleCompat.js";
import type { TenantContext, UUID } from "../../../../domain/types/index.js";

export interface StockMovementFields {
  rollId: UUID;
  direction: "in" | "out";
  movementType:
    | "invoice_sale"
    | "invoice_entry"
    | "return_sale"
    | "return_entry"
    | "print_send"
    | "print_receive"
    | "print_waste"
    | "adjustment"
    | "initial";
  quantityKg: number;
  /** rolls.remaining_kg AFTER the change is applied */
  balanceAfterKg: number;
  referenceType?: string;
  referenceId?: UUID;
  referenceNumber?: string;
  movementDate: string;
  description?: string;
}

/**
 * Record a stock movement atomically inside the caller's transaction.
 * MUST be called in the same tx that mutates rolls.remaining_kg.
 */
export async function recordStockMovement(
  tx: Tx,
  input: StockMovementFields,
  ctx: TenantContext,
): Promise<void> {
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
