/**
 * PostgreSQL search queries — moved verbatim from presentation/routes/search.route.ts
 * (specs/001-desktop-sqlite-engine S1). Behavior is unchanged.
 */
import { sql } from "drizzle-orm";
import type { DB } from "../orm/drizzle.js";
import type { ISearchRepository, PartySearchInput, SearchRow } from "../../application/ports/ISearchRepository.js";

const rowsOf = (r: unknown): SearchRow[] => (r as { rows?: SearchRow[] }).rows ?? [];

export class PostgresSearchRepository implements ISearchRepository {
  constructor(private readonly db: DB) {}

  async searchParties({ tenantId, q, kind, status, limit, pattern, cursor }: PartySearchInput): Promise<SearchRow[]> {
    const rows = await this.db.execute(sql`
      SELECT id, name, code, kind, status, currency
        FROM parties
       WHERE tenant_id = ${tenantId}::uuid
         AND (${kind} = '' OR kind = ${kind})
         AND (${status} = '' OR status = ${status})
         AND (name ILIKE ${pattern} ESCAPE '\\' OR COALESCE(code,'') ILIKE ${pattern} ESCAPE '\\')
         AND (
           ${cursor?.sortKey ?? null}::text IS NULL
           OR (
             (name, id) > (${cursor?.sortKey ?? ""}, ${cursor?.id ?? "00000000-0000-0000-0000-000000000000"}::uuid)
             -- the exact-code match is pinned to page 1 only; never repeat it
             AND (${q} = '' OR lower(COALESCE(code,'')) <> lower(${q}))
           )
         )
       ORDER BY
         CASE WHEN lower(COALESCE(code,'')) = lower(${q}) THEN 0 ELSE 1 END,
         name ASC, id ASC
       LIMIT ${limit + 1}
    `);
    return rowsOf(rows);
  }

  async searchFabrics(tenantId: string, q: string, pattern: string, limit: number): Promise<SearchRow[]> {
    const rows = await this.db.execute(sql`
      SELECT id, name FROM fabrics
       WHERE tenant_id = ${tenantId}::uuid AND name ILIKE ${pattern} ESCAPE '\\'
       ORDER BY CASE WHEN lower(name) = lower(${q}) THEN 0 ELSE 1 END, name ASC
       LIMIT ${limit}`);
    return rowsOf(rows);
  }

  async searchColors(tenantId: string, fabricId: string, pattern: string, limit: number): Promise<SearchRow[]> {
    const rows = await this.db.execute(sql`
      SELECT id, name, fabric_id AS "fabricId", code FROM colors
       WHERE tenant_id = ${tenantId}::uuid
         AND (${fabricId} = '' OR fabric_id = ${fabricId}::uuid)
         AND name ILIKE ${pattern} ESCAPE '\\'
       ORDER BY name ASC LIMIT ${limit}`);
    return rowsOf(rows);
  }

  async searchRolls(tenantId: string, colorId: string, status: string, pattern: string, limit: number): Promise<SearchRow[]> {
    const rows = await this.db.execute(sql`
      SELECT id, roll_no AS "rollNo", color_id AS "colorId", status,
             remaining_kg AS "remainingKg", remaining_pieces AS "remainingPieces",
             currency, price_per_kg AS "pricePerKg"
        FROM rolls
       WHERE tenant_id = ${tenantId}::uuid
         AND (${colorId} = '' OR color_id = ${colorId}::uuid)
         AND (${status} = '' OR status = ${status})
         AND roll_no ILIKE ${pattern} ESCAPE '\\'
       ORDER BY roll_no ASC LIMIT ${limit}`);
    return rowsOf(rows);
  }

  async partiesByIds(tenantId: string, ids: string[]): Promise<SearchRow[]> {
    const rows = await this.db.execute(sql`
      SELECT id, name, code, kind, status, currency FROM parties
       WHERE tenant_id = ${tenantId}::uuid AND id = ANY(${ids}::uuid[])`);
    return rowsOf(rows);
  }

  async rollsByIds(tenantId: string, ids: string[]): Promise<SearchRow[]> {
    const rows = await this.db.execute(sql`
      SELECT id, roll_no AS "rollNo", color_id AS "colorId", status,
             remaining_kg AS "remainingKg", remaining_pieces AS "remainingPieces"
        FROM rolls
       WHERE tenant_id = ${tenantId}::uuid AND id = ANY(${ids}::uuid[])`);
    return rowsOf(rows);
  }
}
