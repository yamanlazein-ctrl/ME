/**
 * REPAIR-001 (A) — server-side typeahead search endpoints.
 */
import type { Router, Request, Response, RequestHandler } from "express";
import { sql } from "drizzle-orm";
import { db } from "../../infrastructure/orm/drizzle.js";
import { likeContains } from "../../infrastructure/utils/likeEscape.js";
import type { TenantContext } from "../../domain/types/index.js";

function ctx(req: Request): TenantContext {
  return (req as unknown as { tenantContext: TenantContext }).tenantContext;
}

function decodeCursor(raw: string | undefined): { sortKey: string; id: string } | null {
  if (!raw) return null;
  try {
    const j = JSON.parse(Buffer.from(raw, "base64url").toString("utf8")) as {
      sortKey: string;
      id: string;
    };
    if (j.sortKey && j.id) return j;
  } catch {
    /* ignore */
  }
  return null;
}

function encodeCursor(sortKey: string, id: string): string {
  return Buffer.from(JSON.stringify({ sortKey, id }), "utf8").toString("base64url");
}

export function registerSearchRoutes(
  router: Router,
  auth: RequestHandler,
  readGuard: RequestHandler,
): void {
  router.get("/parties/search", auth, readGuard, async (req: Request, res: Response) => {
    const c = ctx(req);
    const q = String(req.query.q ?? "").trim();
    const kind = String(req.query.kind ?? "");
    const status = String(req.query.status ?? "active");
    const limit = Math.min(50, Math.max(1, Number(req.query.limit ?? 20)));
    const cursor = decodeCursor(typeof req.query.cursor === "string" ? req.query.cursor : undefined);
    const pattern = q ? likeContains(q) : "%";

    const rows = await db.execute(sql`
      SELECT id, name, code, kind, status, currency
        FROM parties
       WHERE tenant_id = ${c.tenantId}::uuid
         AND (${kind} = '' OR kind = ${kind})
         AND (${status} = '' OR status = ${status})
         AND (name ILIKE ${pattern} ESCAPE '\\' OR COALESCE(code,'') ILIKE ${pattern} ESCAPE '\\')
         AND (
           ${cursor?.sortKey ?? null}::text IS NULL
           OR (name, id) > (${cursor?.sortKey ?? ""}, ${cursor?.id ?? "00000000-0000-0000-0000-000000000000"}::uuid)
         )
       ORDER BY
         CASE WHEN lower(COALESCE(code,'')) = lower(${q}) THEN 0 ELSE 1 END,
         name ASC, id ASC
       LIMIT ${limit + 1}
    `);
    const list = (rows as unknown as { rows: Array<Record<string, unknown>> }).rows ?? [];
    const page = list.slice(0, limit);
    const next =
      list.length > limit
        ? encodeCursor(String(page.at(-1)?.name ?? ""), String(page.at(-1)?.id ?? ""))
        : null;
    res.json({ data: page, nextCursor: next });
  });

  router.get("/fabrics/search", auth, readGuard, async (req: Request, res: Response) => {
    const c = ctx(req);
    const q = String(req.query.q ?? "").trim();
    const limit = Math.min(50, Math.max(1, Number(req.query.limit ?? 20)));
    const pattern = q ? likeContains(q) : "%";
    const rows = await db.execute(sql`
      SELECT id, name FROM fabrics
       WHERE tenant_id = ${c.tenantId}::uuid AND name ILIKE ${pattern} ESCAPE '\\'
       ORDER BY CASE WHEN lower(name) = lower(${q}) THEN 0 ELSE 1 END, name ASC
       LIMIT ${limit}`);
    res.json({ data: (rows as unknown as { rows: unknown[] }).rows ?? [] });
  });

  router.get("/colors/search", auth, readGuard, async (req: Request, res: Response) => {
    const c = ctx(req);
    const q = String(req.query.q ?? "").trim();
    const fabricId = String(req.query.fabricId ?? "");
    const limit = Math.min(50, Math.max(1, Number(req.query.limit ?? 20)));
    const pattern = q ? likeContains(q) : "%";
    const rows = await db.execute(sql`
      SELECT id, name, fabric_id AS "fabricId", code FROM colors
       WHERE tenant_id = ${c.tenantId}::uuid
         AND (${fabricId} = '' OR fabric_id = ${fabricId}::uuid)
         AND name ILIKE ${pattern} ESCAPE '\\'
       ORDER BY name ASC LIMIT ${limit}`);
    res.json({ data: (rows as unknown as { rows: unknown[] }).rows ?? [] });
  });

  router.get("/rolls/search", auth, readGuard, async (req: Request, res: Response) => {
    const c = ctx(req);
    const q = String(req.query.q ?? "").trim();
    const colorId = String(req.query.colorId ?? "");
    const status = String(req.query.status ?? "in_stock");
    const limit = Math.min(50, Math.max(1, Number(req.query.limit ?? 20)));
    const pattern = q ? likeContains(q) : "%";
    const rows = await db.execute(sql`
      SELECT id, roll_no AS "rollNo", color_id AS "colorId", status,
             remaining_kg AS "remainingKg", remaining_pieces AS "remainingPieces",
             currency, price_per_kg AS "pricePerKg"
        FROM rolls
       WHERE tenant_id = ${c.tenantId}::uuid
         AND (${colorId} = '' OR color_id = ${colorId}::uuid)
         AND (${status} = '' OR status = ${status})
         AND roll_no ILIKE ${pattern} ESCAPE '\\'
       ORDER BY roll_no ASC LIMIT ${limit}`);
    res.json({ data: (rows as unknown as { rows: unknown[] }).rows ?? [] });
  });

  router.get("/parties/by-ids", auth, readGuard, async (req: Request, res: Response) => {
    const c = ctx(req);
    const ids = String(req.query.ids ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
      .slice(0, 200);
    if (ids.length === 0) {
      res.json({ data: [] });
      return;
    }
    const rows = await db.execute(sql`
      SELECT id, name, code, kind, status, currency FROM parties
       WHERE tenant_id = ${c.tenantId}::uuid AND id = ANY(${ids}::uuid[])`);
    res.json({ data: (rows as unknown as { rows: unknown[] }).rows ?? [] });
  });

  router.get("/rolls/by-ids", auth, readGuard, async (req: Request, res: Response) => {
    const c = ctx(req);
    const ids = String(req.query.ids ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
      .slice(0, 200);
    if (ids.length === 0) {
      res.json({ data: [] });
      return;
    }
    const rows = await db.execute(sql`
      SELECT id, roll_no AS "rollNo", color_id AS "colorId", status,
             remaining_kg AS "remainingKg", remaining_pieces AS "remainingPieces"
        FROM rolls
       WHERE tenant_id = ${c.tenantId}::uuid AND id = ANY(${ids}::uuid[])`);
    res.json({ data: (rows as unknown as { rows: unknown[] }).rows ?? [] });
  });
}
