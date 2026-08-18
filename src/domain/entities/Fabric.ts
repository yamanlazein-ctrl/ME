import { Timestamp, UUID } from "@/domain/types";

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
    if (!props.name?.trim()) throw new Error("Fabric name is required.");
    return new Fabric({
      ...props,
      id: props.id ?? crypto.randomUUID(),
      createdAt: new Date().toISOString(),
    });
  }
}
