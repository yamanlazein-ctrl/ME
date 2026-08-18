import type { ILicenseRepository } from "@/application/ports/ILicenseRepository";
import type { LicenseInfo } from "@/contracts/licenses";
import { BaseHttpClient } from "@/infrastructure/http/BaseHttpClient";
import {
  ActivateLicenseEndpoint,
  GetLicenseEndpoint,
  RegenerateLicenseEndpoint,
} from "@/contracts/licenses";

/**
 * API license repository (production / `VITE_REPO_MODE=api`).
 *
 * Talks to the real License Server via the same `BaseHttpClient`
 * used by every other API repository. The wire endpoints are
 * declared in `src/contracts/licenses.ts`.
 *
 * The actual server-side implementation lands in sub-batches 0E → 0J.
 * This skeleton wires the frontend to the contract so a Phase 0 UI
 * can be developed without a server stub returning 404.
 */
export class ApiLicenseRepository implements ILicenseRepository {
  constructor(private readonly http: BaseHttpClient) {}

  async getCurrent(): Promise<LicenseInfo> {
    const res = await this.http.request<LicenseInfo>({
      method: GetLicenseEndpoint.method,
      path: GetLicenseEndpoint.path,
    });
    return res.data;
  }

  async activate(input: { key: string; serverFingerprint: string }): Promise<LicenseInfo> {
    const res = await this.http.request<LicenseInfo>({
      method: ActivateLicenseEndpoint.method,
      path: ActivateLicenseEndpoint.path,
      body: { key: input.key, serverFingerprint: input.serverFingerprint },
    });
    return res.data;
  }

  async regenerate(): Promise<{ key: string }> {
    // Regenerate targets the current tenant (server resolves from JWT),
    // not a specific user. The legacy /api/users/:id/license contract
    // is still callable but Admin-only; this version uses the bulk
    // /api/licenses/regenerate endpoint introduced in 0E.
    const res = await this.http.request<{ key: string }>({
      method: RegenerateLicenseEndpoint.method,
      path: "/api/licenses/regenerate",
    });
    return res.data;
  }
}
