import type { UUID, RollStatus } from "../types/index.js";
import { reserveStock as sharedReserve, releaseStock as sharedRelease } from "@erp/shared";

export interface RollData {
  id: UUID;
  tenantId: UUID;
  colorId: UUID;
  rollNo: string;
  dyeBatch?: string;
  initialKg: number;
  remainingKg: number;
  pieces: number;
  pricePerKg: number;
  salePricePerKg?: number;
  currency: string;
  supplierId?: UUID;
  entryDate: string;
  widthCm?: number;
  weightGsm?: number;
  status: RollStatus;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export class Roll {
  private constructor(private readonly data: RollData) {}

  static create(input: CreateRollInput): Roll {
    return new Roll({
      id: "" as UUID,
      tenantId: "" as UUID,
      colorId: input.colorId,
      rollNo: input.rollNo.trim(),
      dyeBatch: input.dyeBatch?.trim(),
      initialKg: input.initialKg,
      remainingKg: input.initialKg,
      pieces: input.pieces ?? 1,
      pricePerKg: input.pricePerKg,
      salePricePerKg: input.salePricePerKg,
      currency: input.currency ?? "SYP",
      supplierId: input.supplierId,
      entryDate: input.entryDate,
      widthCm: input.widthCm,
      weightGsm: input.weightGsm,
      status: "in_stock" as RollStatus,
      version: 1,
      createdAt: "",
      updatedAt: "",
    });
  }

  static reconstitute(data: RollData): Roll {
    return new Roll(data);
  }

  decrement(kg: number): void {
    sharedReserve(this.data as unknown as import("@erp/shared").RollData, kg);
    this.data.updatedAt = new Date().toISOString();
  }

  increment(kg: number): void {
    sharedRelease(this.data as unknown as import("@erp/shared").RollData, kg);
    this.data.updatedAt = new Date().toISOString();
  }

  update(updates: Partial<CreateRollInput>): void {
    const d = this.data;
    if (updates.rollNo !== undefined) d.rollNo = updates.rollNo.trim();
    if (updates.dyeBatch !== undefined) d.dyeBatch = updates.dyeBatch?.trim();
    if (updates.pricePerKg !== undefined) d.pricePerKg = updates.pricePerKg;
    if (updates.salePricePerKg !== undefined) d.salePricePerKg = updates.salePricePerKg;
    if (updates.currency !== undefined) d.currency = updates.currency;
    if (updates.widthCm !== undefined) d.widthCm = updates.widthCm;
    if (updates.weightGsm !== undefined) d.weightGsm = updates.weightGsm;
    d.version++;
    d.updatedAt = new Date().toISOString();
  }

  toData(): RollData {
    return { ...this.data };
  }

  get id(): UUID {
    return this.data.id;
  }
  get rollNo(): string {
    return this.data.rollNo;
  }
  get remainingKg(): number {
    return this.data.remainingKg;
  }
  get status(): RollStatus {
    return this.data.status;
  }
  get version(): number {
    return this.data.version;
  }
  get colorId(): UUID {
    return this.data.colorId;
  }
}

export interface CreateRollInput {
  colorId: UUID;
  rollNo: string;
  dyeBatch?: string;
  initialKg: number;
  pieces?: number;
  pricePerKg: number;
  salePricePerKg?: number;
  currency?: string;
  supplierId?: UUID;
  entryDate: string;
  widthCm?: number;
  weightGsm?: number;
}
