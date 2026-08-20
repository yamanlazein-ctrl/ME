import { Timestamp, UUID } from "@/domain/types";
import { createFabricData as sharedCreateFabricData } from "@erp/shared";

export interface FabricData {
  id: UUID;
  tenantId: UUID;
  name: string;
  category?: string | null;
  minStockKg?: number | null;
  notes?: string | null;
  unit?: "meter" | "yard" | "kg" | null;
  imageUrl?: string | null;
  createdBy?: string | null;
  createdAt: Timestamp;
}

export class Fabric implements FabricData {
  readonly id: UUID;
  readonly tenantId: UUID;
  readonly name: string;
  readonly category: string | null;
  readonly minStockKg: number | null;
  readonly notes: string | null;
  readonly unit: "meter" | "yard" | "kg" | null;
  readonly imageUrl: string | null;
  readonly createdBy: string | null;
  readonly createdAt: Timestamp;

  private constructor(data: FabricData) {
    this.id = data.id;
    this.tenantId = data.tenantId;
    this.name = data.name;
    this.category = data.category ?? null;
    this.minStockKg = data.minStockKg ?? null;
    this.notes = data.notes ?? null;
    this.unit = data.unit ?? "kg";
    this.imageUrl = data.imageUrl ?? null;
    this.createdBy = data.createdBy ?? null;
    this.createdAt = data.createdAt;
  }

  static reconstitute(data: FabricData): Fabric {
    return new Fabric(data);
  }

  static create(props: Omit<FabricData, "id" | "createdAt"> & { id?: UUID }): Fabric {
    const base = sharedCreateFabricData({
      name: props.name,
      category: props.category ?? undefined,
      minStockKg: props.minStockKg ?? undefined,
      notes: props.notes ?? undefined,
      unit: props.unit ?? undefined,
      imageUrl: props.imageUrl ?? undefined,
      createdBy: props.createdBy ?? undefined,
    });
    return new Fabric({
      ...base,
      id: (props.id as string) ?? base.id,
      tenantId: props.tenantId,
      name: base.name,
      category: base.category as string | null,
      minStockKg: base.minStockKg as number | null,
      notes: base.notes as string | null,
      unit: base.unit as FabricData["unit"],
      imageUrl: base.imageUrl as string | null,
      createdBy: base.createdBy as string | null,
      createdAt: base.createdAt,
    } as FabricData);
  }
}
