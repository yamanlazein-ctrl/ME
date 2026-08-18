import { useMemo } from "react";
import { TenantContext, UUID } from "@/domain/types";

/**
 * Build a TenantContext from the currently logged-in user.
 * Tries to resolve from a real auth token; falls back to mock/dev defaults.
 */
export function buildTenantContext(): TenantContext {
  const envTenant = import.meta.env.VITE_DEFAULT_TENANT_ID as string | undefined;
  const tokenProvider = getTokenProvider();
  const token = tokenProvider?.getToken();

  if (token) {
    try {
      const payload = parseJwtPayload(token);
      if (payload && (payload.tenantId || payload.sub)) {
        return {
          tenantId: String(payload.tenantId ?? envTenant ?? "dev-tenant") as UUID,
          userId: String(payload.sub ?? payload.userId ?? "usr-1") as UUID,
          userName: String(payload.name ?? "مستخدم"),
          userRole: String(payload.role ?? "admin") as TenantContext["userRole"],
        };
      }
    } catch {
      /* fall through to defaults */
    }
  }

  const fallbackUserId = (import.meta.env.VITE_DEFAULT_USER_ID ?? "usr-1") as UUID;
  return {
    tenantId: (envTenant ?? "dev-tenant") as UUID,
    userId: fallbackUserId,
    userName: (import.meta.env.VITE_DEFAULT_USER_NAME as string) || "أحمد المصري",
    userRole: (import.meta.env.VITE_DEFAULT_USER_ROLE as TenantContext["userRole"]) ?? "admin",
  };
}

function getTokenProvider(): { getToken(): string | null } | null {
  try {
    const token =
      typeof window !== "undefined" ? localStorage.getItem("erp.auth.accessToken") : null;
    return { getToken: () => token };
  } catch {
    return null;
  }
}

function parseJwtPayload(token: string): Record<string, unknown> | null {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return null;
    return JSON.parse(atob(parts[1]));
  } catch {
    return null;
  }
}

/** React hook wrapper so components can react to auth changes. */
export function useTenantContext(): TenantContext {
  return useMemo(() => buildTenantContext(), []);
}
