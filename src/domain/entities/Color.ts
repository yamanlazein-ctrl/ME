import { Timestamp, UUID } from "@/domain/types";

export interface ColorData {
  id: UUID;
  tenantId: UUID;
  fabricId: UUID;
  name: string;
  code: string;
  // Real visual color (e.g. "#000000"). Always separate from `code` (code is a
  // commercial/product color identifier, NOT a hex value).
  hex?: string | null;
  imageUrl?: string | null;
  createdAt: Timestamp;
}

export class Color implements ColorData {
  readonly id: UUID;
  readonly tenantId: UUID;
  readonly fabricId: UUID;
  readonly name: string;
  readonly code: string;
  readonly hex: string | null;
  readonly imageUrl: string | null;
  readonly createdAt: Timestamp;

  private constructor(data: ColorData) {
    this.id = data.id;
    this.tenantId = data.tenantId;
    this.fabricId = data.fabricId;
    this.name = data.name;
    this.code = data.code;
    this.hex = data.hex ?? null;
    this.imageUrl = data.imageUrl ?? null;
    this.createdAt = data.createdAt;
  }

  static reconstitute(data: ColorData): Color {
    return new Color(data);
  }

  static create(props: Omit<ColorData, "id" | "createdAt"> & { id?: UUID }): Color {
    if (!props.name?.trim()) throw new Error("Color name is required.");
    if (!props.code?.trim()) throw new Error("Color code is required.");
    return new Color({
      ...props,
      id: props.id ?? crypto.randomUUID(),
      createdAt: new Date().toISOString(),
    });
  }
}
