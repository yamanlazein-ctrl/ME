/**
 * Locks the observable behavior of the typeahead search queries (moved behind
 * ISearchRepository in S1) so the SQLite implementation can be held to the same
 * results (specs/001-desktop-sqlite-engine, research R9 / task T063).
 */
import { describe, it, expect, beforeAll } from "vitest";
import { randomUUID } from "node:crypto";
import { db, ambientDb } from "@/infrastructure/orm/drizzle.js";
import { tenants } from "@/infrastructure/orm/schemas/tenant.table.js";
import { parties } from "@/infrastructure/orm/schemas/party.table.js";
import { PostgresSearchRepository } from "@/infrastructure/repositories/PostgresSearchRepository.js";
import { likeContains } from "@/infrastructure/utils/likeEscape.js";
import { databaseReachable, skipUnlessDatabase } from "./_helpers/requireDatabase.js";

const tenantId = randomUUID();
let reachable = false;
const repo = () => new PostgresSearchRepository(ambientDb(db));
const names = (rows: Array<Record<string, unknown>>) => rows.map((r) => r.name);

describe("PostgresSearchRepository — search behavior lock", () => {
  beforeAll(async () => {
    reachable = await databaseReachable();
    if (!reachable) return;
    await db.insert(tenants).values({ id: tenantId, name: "Search tenant", slug: `srch-${tenantId.slice(0, 8)}` });
    const p = (name: string, code: string | null, status = "active") => ({
      id: randomUUID(), tenantId, kind: "customer" as const, status: status as "active", name, code, currency: "SYP",
    });
    await db.insert(parties).values([
      p("محمد الأحمد", "C-001"),
      p("أحمد محمد", "C-002"),
      p("Ahmad Trading", "AH-1"),
      p("ahmad lower", "ah-2"),
      p("Zed 100% Cotton", "Z_1"),
      p("Back\\Slash", "BS"),
      p("Pinned by code", "AHMAD"),
      p("Cancelled Ahmad", "X-9", "cancelled"),
    ]);
  });

  it("matches Arabic text exactly as typed (no normalization)", async (t) => {
    skipUnlessDatabase(t, reachable);
    const rows = await repo().searchParties({ tenantId, q: "محمد", kind: "customer", status: "active", limit: 20, pattern: likeContains("محمد"), cursor: null });
    expect(names(rows).sort()).toEqual(["أحمد محمد", "محمد الأحمد"].sort());
  });

  it("is ASCII case-insensitive and pins the exact code match first", async (t) => {
    skipUnlessDatabase(t, reachable);
    const rows = await repo().searchParties({ tenantId, q: "ahmad", kind: "customer", status: "active", limit: 20, pattern: likeContains("ahmad"), cursor: null });
    expect(names(rows)).toEqual(["Pinned by code", "Ahmad Trading", "ahmad lower"]);
  });

  it("escapes % _ and \\ in the query", async (t) => {
    skipUnlessDatabase(t, reachable);
    const pct = await repo().searchParties({ tenantId, q: "100%", kind: "", status: "active", limit: 20, pattern: likeContains("100%"), cursor: null });
    expect(names(pct)).toEqual(["Zed 100% Cotton"]);
    const us = await repo().searchParties({ tenantId, q: "Z_", kind: "", status: "active", limit: 20, pattern: likeContains("Z_"), cursor: null });
    expect(names(us)).toEqual(["Zed 100% Cotton"]);
    const bs = await repo().searchParties({ tenantId, q: "k\\S", kind: "", status: "active", limit: 20, pattern: likeContains("k\\S"), cursor: null });
    expect(names(bs)).toEqual(["Back\\Slash"]);
  });

  it("respects the status filter (default active excludes cancelled)", async (t) => {
    skipUnlessDatabase(t, reachable);
    const rows = await repo().searchParties({ tenantId, q: "cancelled", kind: "", status: "active", limit: 20, pattern: likeContains("cancelled"), cursor: null });
    expect(rows).toHaveLength(0);
  });

  it("keyset pages by (name, id) without repeating rows and returns limit+1 for paging", async (t) => {
    skipUnlessDatabase(t, reachable);
    const first = await repo().searchParties({ tenantId, q: "", kind: "", status: "active", limit: 3, pattern: "%", cursor: null });
    expect(first).toHaveLength(4);
    const last = first[2]!;
    const second = await repo().searchParties({
      tenantId, q: "", kind: "", status: "active", limit: 3, pattern: "%",
      cursor: { sortKey: String(last.name), id: String(last.id) },
    });
    const seen = new Set(first.slice(0, 3).map((r) => r.id));
    for (const r of second) expect(seen.has(r.id)).toBe(false);
  });

  // PRE-EXISTING DEFECT (found 2026-10-03, recorded in research §R13c as owner decision O-1):
  // drizzle expands a JS array into a record, so `ANY(${ids}::uuid[])` fails for every non-empty
  // id list ("malformed array literal" for one id, "cannot cast type record to uuid[]" for more). GET /parties/by-ids and
  // /rolls/by-ids therefore always 500; PartyCombobox swallows the error. Not an approved
  // pre-reference fix (constitution v1.1.0), so the reference behavior is locked as-is here.
  it("partiesByIds / rollsByIds currently reject any non-empty id list (pre-existing defect O-1)", async (t) => {
    skipUnlessDatabase(t, reachable);
    const why = async (p: Promise<unknown>) => {
      try {
        await p;
        return "resolved";
      } catch (e) {
        const err = e as { message?: string; cause?: { message?: string } };
        return `${err.message ?? ""} ${err.cause?.message ?? ""}`;
      }
    };
    expect(await why(repo().partiesByIds(tenantId, [randomUUID()]))).toMatch(/cannot cast type record to uuid\[\]|malformed array literal/);
    expect(await why(repo().rollsByIds(tenantId, [randomUUID()]))).toMatch(/cannot cast type record to uuid\[\]|malformed array literal/);
  });
});
