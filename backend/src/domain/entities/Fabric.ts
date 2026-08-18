import type { UUID, EntityStatus } from "../types/index.js";

export interface FabricData {
  id: UUID;
  tenantId: UUID;
  name: string;
  category?: string;
  minStockKg: number;
  unit?: string;
  notes?: string;
  imageUrl?: string;
  createdAt: string;
  createdBy?: UUID;
  updatedAt: string;
}

export class Fabric {
  private constructor(private readonly data: FabricData) {}

  static create(input: CreateFabricInput): Fabric {
    return new Fabric({
      id: "" as UUID,
      tenantId: "" as UUID,
      name: input.name.trim(),
      category: input.category?.trim(),
      minStockKg: input.minStockKg ?? 0,
      unit: input.unit?.trim(),
      notes: input.notes?.trim(),
      imageUrl: input.imageUrl?.trim(),
      createdAt: "",
      createdBy: undefined,
      updatedAt: "",
    });
  }

  static reconstitute(data: FabricData): Fabric {
    return new Fabric(data);
  }

  update(updates: Partial<CreateFabricInput>): void {
    const d = this.data;
    if (updates.name !== undefined) d.name = updates.name.trim();
    if (updates.category !== undefined) d.category = updates.category?.trim();
    if (updates.minStockKg !== undefined) d.minStockKg = updates.minStockKg;
    if (updates.unit !== undefined) d.unit = updates.unit?.trim();
    if (updates.notes !== undefined) d.notes = updates.notes?.trim();
    if (updates.imageUrl !== undefined) d.imageUrl = updates.imageUrl?.trim();
    d.updatedAt = new Date().toISOString();
  }

  toData(): FabricData {
    return { ...this.data };
  }

  get id(): UUID {
    return this.data.id;
  }
  get name(): string {
    return this.data.name;
  }
  get minStockKg(): number {
    return this.data.minStockKg;
  }
}

export interface CreateFabricInput {
  name: string;
  category?: string;
  minStockKg?: number;
  unit?: string;
  notes?: string;
  imageUrl?: string;
}
