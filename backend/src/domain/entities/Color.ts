import type { UUID } from "../types/index.js";

export interface ColorData {
  id: UUID;
  tenantId: UUID;
  fabricId: UUID;
  name: string;
  code?: string;
  // Real visual color (e.g. "#000000"). Always separate from `code`.
  hex?: string;
  imageUrl?: string;
  createdAt: string;
  updatedAt: string;
}

export class Color {
  private constructor(private readonly data: ColorData) {}

  static create(input: CreateColorInput): Color {
    return new Color({
      id: "" as UUID,
      tenantId: "" as UUID,
      fabricId: input.fabricId,
      name: input.name.trim(),
      code: input.code?.trim(),
      hex: input.hex?.trim(),
      imageUrl: input.imageUrl?.trim(),
      createdAt: "",
      updatedAt: "",
    });
  }

  static reconstitute(data: ColorData): Color {
    return new Color(data);
  }

  update(updates: Partial<CreateColorInput>): void {
    const d = this.data;
    if (updates.name !== undefined) d.name = updates.name.trim();
    if (updates.code !== undefined) d.code = updates.code?.trim();
    if (updates.hex !== undefined) d.hex = updates.hex?.trim();
    if (updates.imageUrl !== undefined) d.imageUrl = updates.imageUrl?.trim();
    d.updatedAt = new Date().toISOString();
  }

  toData(): ColorData {
    return { ...this.data };
  }

  get id(): UUID {
    return this.data.id;
  }
  get name(): string {
    return this.data.name;
  }
  get fabricId(): UUID {
    return this.data.fabricId;
  }
}

export interface CreateColorInput {
  fabricId: UUID;
  name: string;
  code?: string;
  hex?: string;
  imageUrl?: string;
}
