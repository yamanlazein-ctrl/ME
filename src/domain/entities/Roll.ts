import { Timestamp, UUID, Currency, Mutable } from "@/domain/types";
import { reserveStock as sharedReserve, releaseStock as sharedRelease, isOutOfStock as sharedIsOutOfStock } from "@erp/shared";

/* ────────────────────────────────────────────────────────────────────────
 *  Roll Entity — physical stock unit. Optimistic-locking via version.
 * ──────────────────────────────────────────────────────────────────────── */

export interface RollData {
  id: UUID;
  tenantId: UUID;
  colorId: UUID;
  rollNo: string;
  dyeBatch: string;
  initialKg: number;
  remainingKg: number;
  pieces: number;
  pricePerKg: number;
  salePricePerKg?: number | null;
  currency: Currency;
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
  pricePerKg: number;
  salePricePerKg?: number | null;
  readonly currency: Currency;
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
    this.pricePerKg = data.pricePerKg;
    this.salePricePerKg = data.salePricePerKg;
    this.currency = data.currency;
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
