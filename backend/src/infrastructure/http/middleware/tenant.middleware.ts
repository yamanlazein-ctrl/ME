import type { Request, Response, NextFunction } from "express";
import { pool } from "../../orm/drizzle.js";

/**
 * Sets the PostgreSQL app.current_tenant_id session variable
 * for RLS policies on the current pooled connection.
 *
 * Uses pool.query() with SET SESSION so that RLS has a fallback
 * tenant context. Combined with explicit WHERE tenant_id = ctx.tenantId
 * in every repository query for defense-in-depth.
 *
 * In Phase 2/3, upgrade to request-scoped database client
 * with SET LOCAL per-transaction for proper per-request isolation.
 */
export async function setTenantRlsMiddleware(req: Request, _res: Response, next: NextFunction) {
  const ctx = req.tenantContext;
  if (!ctx) {
    next();
    return;
  }

  try {
    await pool.query("SET SESSION app.current_tenant_id = $1", [ctx.tenantId]);
    next();
  } catch (err) {
    next(err);
  }
}
