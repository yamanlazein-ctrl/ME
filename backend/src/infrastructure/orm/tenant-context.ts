import { AsyncLocalStorage } from "node:async_hooks";

/**
 * Request-scoped tenant context.
 *
 * Provides the PostgreSQL RLS GUC (`app.current_tenant_id`) and the platform
 * escalation flag (`app.platform_mode`) for the CURRENT request, carried
 * through the async call stack via AsyncLocalStorage.
 *
 * Why this exists: the shared pg Pool reuses connections across requests, so
 * a session-level `SET` done on the pool itself is racy (documented in
 * PLATFORM_FOUNDATION_NOTES.md §2). The only correct way to make RLS
 * tenant isolation work is to stamp the GUC on the connection AT CHECKOUT
 * TIME, keyed by the tenant that owns the current request. `TenantScopedPool`
 * (in `drizzle.ts`) reads this store when handing out a connection.
 *
 * - `tenantId` is set by the auth middleware for every authenticated request
 *   (it comes from the verified JWT, before any business query runs).
 * - `platformMode` is set ONLY by trusted platform/bootstrap code paths (the
 *   license server, setup bootstrap) so they can read system-level rows whose
 *   `tenant_id` is NULL. Regular tenant requests NEVER set it, so NULL rows
 *   stay invisible to every company — implementing the D4 "NULL rows are not
 *   auto-visible" guarantee.
 */
export interface TenantRequestContext {
  tenantId?: string;
  platformMode?: boolean;
}

export const tenantContext = new AsyncLocalStorage<TenantRequestContext>();

/**
 * Run `fn` inside a request context that stamps the tenant GUC on every
 * connection checked out during `fn`.
 */
export function runWithTenantContext<T>(
  context: TenantRequestContext,
  fn: () => T,
): T {
  return tenantContext.run(context, fn);
}

/**
 * Run `fn` inside a platform context (for bootstrap / license-server paths
 * that legitimately touch system-level NULL-tenant rows). Do NOT use this
 * for tenant business flows.
 */
export function runWithPlatformContext<T>(fn: () => T): T {
  return tenantContext.run(
    { ...tenantContext.getStore(), platformMode: true },
    fn,
  );
}
