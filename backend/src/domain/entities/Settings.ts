import type { UUID } from "../types/index.js";

export interface SettingsData {
  id: UUID;
  tenantId: UUID;
  company: Record<string, unknown>;
  currencies: unknown[];
  paymentMethods: unknown[];
  taxes: unknown[];
  units: unknown[];
  warehouses: unknown[];
  printing: Record<string, unknown>;
  updatedAt: string;
}

export class Settings {
  private constructor(private readonly data: SettingsData) {}

  static createDefault(tenantId: UUID): Settings {
    return new Settings({
      id: "" as UUID,
      tenantId,
      company: {},
      currencies: [],
      paymentMethods: [],
      taxes: [],
      units: [],
      warehouses: [],
      printing: {},
      updatedAt: "",
    });
  }

  static reconstitute(data: SettingsData): Settings {
    return new Settings(data);
  }

  updateSection(section: string, value: unknown): void {
    const s = section as keyof SettingsData;
    if (s in this.data && s !== "id" && s !== "tenantId" && s !== "updatedAt") {
      (this.data as unknown as Record<string, unknown>)[section] = value;
    }
    this.data.updatedAt = new Date().toISOString();
  }

  toData(): SettingsData {
    return { ...this.data };
  }
}
