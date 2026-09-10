import type { Request, Response, NextFunction } from "express";

/**
 * DEPRECATED — replaced by the AsyncLocalStorage tenant context.
 *
 * This middleware previously set `app.current_tenant_id` via a session-level
 * `SET SESSION` on the shared pg Pool, which is racy (PLATFORM_FOUNDATION_NOTES
 * §2): the pooled connection is reused across requests, so the GUC could leak
 * from one tenant's request into another's. Tenant context is now established
 * by `auth.middleware.ts` using `runWithTenantContext`, and `TenantScopedPool`
 * stamps the GUC at connection checkout time.
 *
 * It is kept as a no-op passthrough so that any existing call site that still
 * references it does not break; it is currently NOT registered in `server.ts`.
 */
export async function setTenantRlsMiddleware(_req: Request, _res: Response, next: NextFunction) {
  next();
}
