import { Timestamp, UUID, Currency, Mutable } from "@/domain/types";
import {
  reserveStock as sharedReserve,
  releaseStock as sharedRelease,
  isOutOfStock as sharedIsOutOfStock,
} from "@erp/shared";

/* ────────────────────────────────────────────────────────────────────────
 *  Roll Entity — physical stock unit. Optimistic-locking via version.
 * ──────────────────────────────────────────────────────────────────────── */

export type RollEntrySource = "purchase" | "press" | "stock_in";

export interface RollData {
  id: UUID;
  tenantId: UUID;
  colorId: UUID;
  rollNo: string;
  dyeBatch: string;
  initialKg: number;
  remainingKg: number;
  pieces: number;
  /** Live piece stock — moves with entry/sale/return transactions. */
  remainingPieces?: number;
  pricePerKg: number;
  salePricePerKg?: number | null;
  currency: Currency;
  /**
   * The ACTUAL price this exact roll entered stock at (purchase line, printing-factory receive or
   * stock-in), in entryCurrency. Fixed at entry — an edit of pricePerKg never changes it. Shown on
   * the sales screen as a reference only.
   */
  entryPricePerKg?: number | null;
  entryCurrency?: Currency | null;
  entrySource?: RollEntrySource | null;
  entryReference?: string | null;
  supplierId: UUID;
  entryDate: string; // yyyy-mm-dd
  widthCm?: number | null;
  weightGsm?: number | null;
  version: number;
  createdAt: Timestamp;
}

export class Roll implements RollData {
  readonly id: UUID;
  readonly tenantId: UUID;
  readonly colorId: UUID;
  readonly rollNo: string;
  readonly dyeBatch: string;
  readonly initialKg: number;
  remainingKg: number;
  pieces: number;
  remainingPieces?: number;
  pricePerKg: number;
  salePricePerKg?: number | null;
  readonly currency: Currency;
  readonly entryPricePerKg?: number | null;
  readonly entryCurrency?: Currency | null;
  readonly entrySource?: RollEntrySource | null;
  readonly entryReference?: string | null;
  readonly supplierId: UUID;
  readonly entryDate: string;
  widthCm?: number | null;
  weightGsm?: number | null;
  version: number;
  readonly createdAt: Timestamp;

  private constructor(data: RollData) {
    this.id = data.id;
    this.tenantId = data.tenantId;
    this.colorId = data.colorId;
    this.rollNo = data.rollNo;
    this.dyeBatch = data.dyeBatch;
    this.initialKg = data.initialKg;
    this.remainingKg = data.remainingKg;
    this.pieces = data.pieces ?? 1;
    this.remainingPieces = data.remainingPieces;
    this.pricePerKg = data.pricePerKg;
    this.salePricePerKg = data.salePricePerKg;
    this.currency = data.currency;
    this.entryPricePerKg = data.entryPricePerKg;
    this.entryCurrency = data.entryCurrency;
    this.entrySource = data.entrySource;
    this.entryReference = data.entryReference;
    this.supplierId = data.supplierId;
    this.entryDate = data.entryDate;
    this.widthCm = data.widthCm;
    this.weightGsm = data.weightGsm;
    this.version = data.version;
    this.createdAt = data.createdAt;
  }

  /** Reconstitute from persistence (skip validation). */
  static reconstitute(data: RollData): Roll {
    return new Roll(data);
  }

  static create(props: Omit<RollData, "id" | "remainingKg" | "version" | "createdAt">): Roll {
    const initial = Math.max(0, props.initialKg);
    return new Roll({
      ...props,
      pieces: props.pieces ?? 1,
      id: crypto.randomUUID(),
      remainingKg: initial,
      remainingPieces: props.remainingPieces ?? (initial > 0 ? (props.pieces ?? 1) : 0),
      version: 1,
      createdAt: new Date().toISOString(),
    });
  }

  /** Reduce remaining stock; fail if insufficient or negative. */
  reserve(kg: number): void {
    const data = this as unknown as import("@erp/shared").RollData;
    sharedReserve(data, kg);
  }

  /** Restore stock (idempotent). */
  release(kg: number): void {
    const data = this as unknown as import("@erp/shared").RollData;
    sharedRelease(data, kg);
  }

  isOutOfStock(): boolean {
    return sharedIsOutOfStock(this as unknown as import("@erp/shared").RollData);
  }

  isLowStock(): boolean {
    return this.remainingKg > 0 && this.remainingKg <= 10; // threshold injected later
  }

  toJSON(): RollData {
    return { ...this };
  }
}
