import type { BaseHttpClient } from "@/infrastructure/http";

export type SettingsSection =
  "company" | "currencies" | "paymentMethods" | "taxes" | "units" | "warehouses" | "printing";

export interface SettingsData {
  id?: string;
  tenantId?: string;
  company: Record<string, unknown>;
  currencies: unknown[];
  paymentMethods: unknown[];
  taxes: unknown[];
  units: unknown[];
  warehouses: unknown[];
  printing: Record<string, unknown>;
  updatedAt?: string;
}

/**
 * Backend surface: GET /api/settings returns the whole settings object
 * (or {} when none exists yet); PUT /api/settings/:section replaces a single
 * section and returns the updated object. There are no per-resource endpoints.
 */
export class SettingsApiService {
  constructor(private client: BaseHttpClient) {}

  async getSettings(): Promise<Partial<SettingsData>> {
    const res = await this.client.get<Partial<SettingsData>>("/api/settings");
    return res.data;
  }

  async updateSection(section: SettingsSection, value: unknown): Promise<SettingsData> {
    const res = await this.client.put<SettingsData>(`/api/settings/${section}`, value);
    return res.data;
  }
}
