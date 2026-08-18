import type { TenantContext, UUID } from "../../domain/types/index.js";
import type { Tx } from "../../infrastructure/orm/drizzle.js";

export type StockMovementDirection = "in" | "out";
export type StockMovementType =
  | "invoice_sale"
  | "invoice_entry"
  | "return_sale"
  | "return_entry"
  | "print_send"
  | "print_receive"
  | "adjustment"
  | "initial";

export interface StockMovementData {
  id: UUID;
  tenantId: UUID;
  rollId: UUID;
  direction: StockMovementDirection;
  movementType: StockMovementType;
  quantityKg: number;
  balanceAfterKg: number;
  referenceType?: string | null;
  referenceId?: UUID | null;
  referenceNumber?: string | null;
  movementDate: string;
  description?: string | null;
  status: string;
  createdBy?: UUID | null;
  createdAt: string;
}

export interface RecordStockMovementInput {
  rollId: UUID;
  direction: StockMovementDirection;
  movementType: StockMovementType;
  quantityKg: number;
  /** remaining_kg AFTER the change is applied */
  balanceAfterKg: number;
  referenceType?: string;
  referenceId?: UUID;
  referenceNumber?: string;
  movementDate: string;
  description?: string;
}

export interface StockMovementFilter {
  rollId?: UUID;
  movementType?: string;
  referenceType?: string;
  referenceId?: UUID;
  fromDate?: string;
  toDate?: string;
  limit?: number;
}

/**
 * Stock Movement Ledger — append-only. The only entry point is `record`,
 * which MUST be called inside the SAME transaction that mutates
 * `rolls.remaining_kg` so the movement never diverges from actual stock.
 */
export interface IStockMovementRepository {
  record(tx: Tx, input: RecordStockMovementInput, ctx: TenantContext): Promise<void>;
  listByRoll(rollId: UUID, ctx: TenantContext, filter?: StockMovementFilter): Promise<StockMovementData[]>;
}