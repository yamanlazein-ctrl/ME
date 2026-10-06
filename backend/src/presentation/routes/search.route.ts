/**
 * REPAIR-001 (A) — server-side typeahead search endpoints.
 */
import type { Router, Request, Response, RequestHandler } from "express";
import type { ISearchRepository } from "../../application/ports/ISearchRepository.js";
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
    if (typeof j.sortKey === "string" && typeof j.id === "string" && j.id) return j;
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
  searchRepo: ISearchRepository,
): void {
  router.get("/parties/search", auth, readGuard, async (req: Request, res: Response) => {
    const c = ctx(req);
    const q = String(req.query.q ?? "").trim();
    const kind = String(req.query.kind ?? "");
    const status = String(req.query.status ?? "active");
    const limit = Math.min(50, Math.max(1, Number(req.query.limit ?? 20)));
    const cursor = decodeCursor(typeof req.query.cursor === "string" ? req.query.cursor : undefined);
    const pattern = q ? likeContains(q) : "%";

    const list = await searchRepo.searchParties({ tenantId: c.tenantId, q, kind, status, limit, pattern, cursor });
    const page = list.slice(0, limit);
    // Page 1 pins the exact-code match first; the keyset cursor must come
    // from the last (name, id)-ordered row, never from that pinned row.
    const isPinned = (r: Record<string, unknown> | undefined) =>
      !cursor && q !== "" && String(r?.code ?? "").toLowerCase() === q.toLowerCase();
    const ordered = page.filter((r) => !isPinned(r));
    const last = ordered.at(-1);
    const next =
      list.length > limit
        ? last
          ? encodeCursor(String(last.name ?? ""), String(last.id ?? ""))
          : encodeCursor("", "00000000-0000-0000-0000-000000000000")
        : null;
    res.json({ data: page, nextCursor: next });
  });

  router.get("/fabrics/search", auth, readGuard, async (req: Request, res: Response) => {
    const c = ctx(req);
    const q = String(req.query.q ?? "").trim();
    const limit = Math.min(50, Math.max(1, Number(req.query.limit ?? 20)));
    const pattern = q ? likeContains(q) : "%";
    res.json({ data: await searchRepo.searchFabrics(c.tenantId, q, pattern, limit) });
  });

  router.get("/colors/search", auth, readGuard, async (req: Request, res: Response) => {
    const c = ctx(req);
    const q = String(req.query.q ?? "").trim();
    const fabricId = String(req.query.fabricId ?? "");
    const limit = Math.min(50, Math.max(1, Number(req.query.limit ?? 20)));
    const pattern = q ? likeContains(q) : "%";
    res.json({ data: await searchRepo.searchColors(c.tenantId, fabricId, pattern, limit) });
  });

  router.get("/rolls/search", auth, readGuard, async (req: Request, res: Response) => {
    const c = ctx(req);
    const q = String(req.query.q ?? "").trim();
    const colorId = String(req.query.colorId ?? "");
    const status = String(req.query.status ?? "in_stock");
    const limit = Math.min(50, Math.max(1, Number(req.query.limit ?? 20)));
    const pattern = q ? likeContains(q) : "%";
    res.json({ data: await searchRepo.searchRolls(c.tenantId, colorId, status, pattern, limit) });
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
    res.json({ data: await searchRepo.partiesByIds(c.tenantId, ids) });
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
    res.json({ data: await searchRepo.rollsByIds(c.tenantId, ids) });
  });
}
