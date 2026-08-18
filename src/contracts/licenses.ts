import type { EndpointMeta, ApiError } from "./_shared";

export interface LicenseInfo {
  key: string;
  type: "trial" | "full" | "expired";
  issuedAt: string;
  expiresAt?: string | null;
  maxUsers: number;
  features: string[];
}

export type GetLicenseResponse = LicenseInfo;
export type GetLicenseError = ApiError;
export const GetLicenseEndpoint: EndpointMeta = {
  path: "/api/licenses",
  method: "GET",
  auth: { required: true, roles: ["admin"] },
  description: "Get current license information",
};

export interface ActivateLicenseRequest {
  key: string;
}
export type ActivateLicenseResponse = LicenseInfo;
export type ActivateLicenseError = ApiError & { code: "INVALID_LICENSE" | "ALREADY_ACTIVE" };
export const ActivateLicenseEndpoint: EndpointMeta = {
  path: "/api/licenses/activate",
  method: "POST",
  auth: { required: true, roles: ["admin"] },
  description: "Activate a license key",
};

export type RegenerateLicenseResponse = { key: string };
export type RegenerateLicenseError = ApiError & { code: "NOT_FOUND" };
export const RegenerateLicenseEndpoint: EndpointMeta = {
  path: "/api/users/:id/license",
  method: "POST",
  auth: { required: true, roles: ["admin"] },
  description: "Regenerate license key for a user",
};
