import type { EndpointMeta, ApiError } from "./_shared";

/* ── POST /api/auth/login ─────────────────────────────────────── */
export interface LoginRequest {
  email: string;
  password: string;
  tenantId?: string;
}
export interface LoginResponse {
  accessToken: string;
  refreshToken?: string;
  user: { id: string; name: string; email: string; role: string };
}
export type LoginError = ApiError & {
  code: "INVALID_CREDENTIALS" | "ACCOUNT_LOCKED" | "TENANT_NOT_FOUND";
};
export const LoginEndpoint: EndpointMeta = {
  path: "/api/auth/login",
  method: "POST",
  auth: { required: false },
  description: "Authenticate user and return JWT tokens",
};

/* ── POST /api/auth/refresh ───────────────────────────────────── */
export interface RefreshTokenRequest {
  refreshToken: string;
}
export interface RefreshTokenResponse {
  accessToken: string;
  refreshToken?: string;
}
export type RefreshTokenError = ApiError & { code: "INVALID_REFRESH_TOKEN" | "TOKEN_EXPIRED" };
export const RefreshTokenEndpoint: EndpointMeta = {
  path: "/api/auth/refresh",
  method: "POST",
  auth: { required: false },
  description: "Exchange refresh token for new access token",
};

/* ── POST /api/auth/logout ────────────────────────────────────── */
export type LogoutError = ApiError;
export const LogoutEndpoint: EndpointMeta = {
  path: "/api/auth/logout",
  method: "POST",
  auth: { required: true },
  description: "Invalidate current session",
};

/* ── GET /api/auth/me ─────────────────────────────────────────── */
export interface MeResponse {
  id: string;
  name: string;
  email: string;
  role: string;
  tenantId: string;
  permissions: string[];
}
export type MeError = ApiError & { code: "UNAUTHORIZED" | "SESSION_EXPIRED" };
export const MeEndpoint: EndpointMeta = {
  path: "/api/auth/me",
  method: "GET",
  auth: { required: true, roles: ["admin", "accountant", "warehouse", "viewer"] },
  description: "Get current authenticated user profile",
};
