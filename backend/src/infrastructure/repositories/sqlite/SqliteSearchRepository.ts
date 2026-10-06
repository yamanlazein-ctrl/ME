// PORTED-FROM: src/infrastructure/repositories/PostgresSearchRepository.ts sha256=9cda92eb6a4159d076232e434bc3e7f92ae43ce757db584c420d378cba432215
// SQLite twin (specs/001-desktop-sqlite-engine S4). Keep behavior identical to the PG source.
import { pgRawRows } from "./helpers/pgText.js";
import { canonicalUuid } from "../../orm/sqlite/types.js";
/**
 * PostgreSQL search queries — moved verbatim from presentation/routes/search.route.ts
 * (specs/001-desktop-sqlite-engine S1). Behavior is unchanged.
 */
import { sql } from "drizzle-orm";
import type { DB } from "../../orm/sqlite/drizzleCompat.js";
import type { ISearchRepository, PartySearchInput, SearchRow } from "../../../application/ports/ISearchRepository.js";

const rowsOf = (r: unknown): SearchRow[] => (r as { rows?: SearchRow[] }).rows ?? [];

/** The error PG raises for `id = ANY(${ids}::uuid[])` with a JS array (see partiesByIds). */
function pgByIdsFailure(ids: string[]): Error {
  const cause = Object.assign(
    new Error(ids.length === 1 ? `malformed array literal: "${ids[0]}"` : "cannot cast type record to uuid[]"),
    { code: ids.length === 1 ? "22P02" : "42846" },
  );
  return new Error("Failed query: by-ids lookup", { cause });
}

export class SqliteSearchRepository implements ISearchRepository {
  constructor(private readonly db: DB) {}

  async searchParties({ tenantId, q, kind, status, limit, pattern, cursor }: PartySearchInput): Promise<SearchRow[]> {
    const rows = await this.db.execute(sql`
      SELECT id, name, code, kind, status, currency
        FROM parties
       WHERE tenant_id = ${tenantId}
         AND (${kind} = '' OR kind = ${kind})
         AND (${status} = '' OR status = ${status})
         AND (name LIKE ${pattern} ESCAPE '\\' OR COALESCE(code,'') LIKE ${pattern} ESCAPE '\\')
         AND (
           ${cursor?.sortKey ?? null} IS NULL
           OR (
             (name, id) > (${cursor?.sortKey ?? ""}, ${(cursor?.id ?? "00000000-0000-0000-0000-000000000000").toLowerCase()})
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
       WHERE tenant_id = ${tenantId} AND name LIKE ${pattern} ESCAPE '\\'
       ORDER BY CASE WHEN lower(name) = lower(${q}) THEN 0 ELSE 1 END, name ASC
       LIMIT ${limit}`);
    return rowsOf(rows);
  }

  async searchColors(tenantId: string, fabricId: string, pattern: string, limit: number): Promise<SearchRow[]> {
    // PG binds `${fabricId}::uuid` even when the `= ''` branch is taken: any non-uuid text (the route
    // default "" included) fails with 22P02 before the query runs. Same cast here (owner item O-2).
    const fabricUuid = canonicalUuid(fabricId);
    const rows = await this.db.execute(sql`
      SELECT id, name, fabric_id AS "fabricId", code FROM colors
       WHERE tenant_id = ${tenantId}
         AND (${fabricId} = '' OR fabric_id = ${fabricUuid})
         AND name LIKE ${pattern} ESCAPE '\\'
       ORDER BY name ASC LIMIT ${limit}`);
    return rowsOf(rows);
  }

  async searchRolls(tenantId: string, colorId: string, status: string, pattern: string, limit: number): Promise<SearchRow[]> {
    const colorUuid = canonicalUuid(colorId); // PG `${colorId}::uuid`: see searchColors (O-2)
    const rows = await this.db.execute(sql`
      SELECT id, roll_no AS "rollNo", color_id AS "colorId", status,
             remaining_kg AS "remainingKg", remaining_pieces AS "remainingPieces",
             currency, price_per_kg AS "pricePerKg"
        FROM rolls
       WHERE tenant_id = ${tenantId}
         AND (${colorId} = '' OR color_id = ${colorUuid})
         AND (${status} = '' OR status = ${status})
         AND roll_no LIKE ${pattern} ESCAPE '\\'
       ORDER BY roll_no ASC LIMIT ${limit}`);
    // PG returns numeric columns as text ("12.50", "30000.0000")
    return pgRawRows(rowsOf(rows), { money: { remainingKg: 2, pricePerKg: 4 } });
  }

  async partiesByIds(tenantId: string, ids: string[]): Promise<SearchRow[]> {
    void tenantId;
    // OWNER DECISION O-1 (research R13c): on PostgreSQL this query always fails — Drizzle expands the
    // JS array into a record, and PG rejects `ANY(record::uuid[])`. Until the owner approves a fix for
    // both engines, the SQLite twin fails identically (locked by tests/search-repository.test.ts).
    throw pgByIdsFailure(ids);
  }


  async rollsByIds(tenantId: string, ids: string[]): Promise<SearchRow[]> {
    void tenantId;
    // OWNER DECISION O-1 (research R13c): on PostgreSQL this query always fails — Drizzle expands the
    // JS array into a record, and PG rejects `ANY(record::uuid[])`. Until the owner approves a fix for
    // both engines, the SQLite twin fails identically (locked by tests/search-repository.test.ts).
    throw pgByIdsFailure(ids);
  }

}
