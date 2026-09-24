/**
 * "Load all" list walks use keyset cursors instead of OFFSET.
 *
 * Rows inserted by one statement share created_at to the microsecond, so the
 * cursor must break ties on id — otherwise a page boundary inside a tie would
 * skip or repeat rows. The walk must return exactly what the OFFSET walk does.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { db } from "@/infrastructure/orm/drizzle.js";
import { tenants } from "@/infrastructure/orm/schemas/tenant.table.js";
import { parties } from "@/infrastructure/orm/schemas/party.table.js";
import { ledgerEntries } from "@/infrastructure/orm/schemas/ledger-entry.table.js";
import { PostgresLedgerRepository } from "@/infrastructure/repositories/PostgresLedgerRepository.js";
import { PostgresPartyRepository } from "@/infrastructure/repositories/PostgresPartyRepository.js";
import type { TenantContext } from "@/domain/types/index.js";

const tenantId = randomUUID();
const customerId = randomUUID();
const ctx: TenantContext = { tenantId, userId: randomUUID(), userRole: "admin", userName: "keyset" };
const N = 53;

async function walk<T extends { id: string }>(
  list: (f: { page: number; limit: number; cursor?: string }) => Promise<{
    data: T[];
    meta?: { nextCursor?: string | null; hasNext: boolean; total: number };
  }>,
  limit: number,
) {
  const ids: string[] = [];
  let cursor: string | undefined;
  let pages = 0;
  for (;;) {
    const r = await list({ page: 0, limit, cursor });
    ids.push(...r.data.map((x) => x.id));
    pages++;
    const next = r.meta?.nextCursor;
    if (!next) break;
    expect(r.meta?.hasNext).toBe(true);
    cursor = next;
    if (pages > 100) throw new Error("runaway walk");
  }
  return { ids, pages };
}

describe("keyset list paging", () => {
  beforeAll(async () => {
    await db.execute(sql`select 1`);
    await db.insert(tenants).values({ id: tenantId, name: "Keyset", slug: `ks-${tenantId.slice(0, 8)}` });
    await db.insert(parties).values({
      id: customerId,
      tenantId,
      name: "KS Customer",
      code: "KS-C",
      kind: "customer",
      currency: "SYP",
    });
    // One multi-row INSERT → every row gets the same now() (a full tie).
    await db.insert(ledgerEntries).values(
      Array.from({ length: N }, (_, i) => ({
        tenantId,
        partyId: customerId,
        date: "2026-03-01",
        type: "sales_invoice" as const,
        debit: 10 + i,
        credit: 0,
        currency: "SYP",
        referenceNumber: `KS-${i}`,
        status: "active" as const,
      })),
    );
    await db.insert(parties).values(
      Array.from({ length: 23 }, (_, i) => ({
        tenantId,
        name: `KS Party ${i}`,
        code: `KS-${i}`,
        kind: "supplier" as const,
        currency: "USD",
      })),
    );
  });

  it("ledger: cursor walk inside a full timestamp tie returns every row exactly once", async () => {
    const repo = new PostgresLedgerRepository(db);
    const { ids, pages } = await walk(
      (f) => repo.list({ partyId: customerId, ...f }, ctx) as never,
      7,
    );
    expect(pages).toBe(Math.ceil(N / 7));
    expect(new Set(ids).size).toBe(N);
    expect(ids).toHaveLength(N);

    // Same set and order as the OFFSET walk.
    const offsetIds: string[] = [];
    for (let page = 0; ; page++) {
      const r = await repo.list({ partyId: customerId, page, limit: 7 }, ctx);
      offsetIds.push(...r.data.map((x) => x.id));
      if (!r.meta?.hasNext) break;
    }
    expect(ids).toEqual(offsetIds);
  });

  it("first page carries the real total; cursor pages skip the COUNT", async () => {
    const repo = new PostgresLedgerRepository(db);
    const first = await repo.list({ partyId: customerId, limit: 10 }, ctx);
    expect(first.meta?.total).toBe(N);
    expect(first.meta?.nextCursor).toBeTruthy();
    const second = await repo.list(
      { partyId: customerId, limit: 10, cursor: first.meta!.nextCursor! },
      ctx,
    );
    expect(second.data).toHaveLength(10);
    expect(second.data.map((x) => x.id)).not.toContain(first.data[0]!.id);
  });

  it("an exact-multiple page count ends without an empty extra page", async () => {
    const repo = new PostgresPartyRepository(db);
    // 23 suppliers + 1 customer in this tenant; walk suppliers only.
    const { ids, pages } = await walk(
      (f) => repo.list({ kind: "supplier", ...f }, ctx) as never,
      23,
    );
    expect(ids).toHaveLength(23);
    expect(pages).toBe(1); // the COUNT knows page 1 is the last → no cursor, no extra request
  });

  it("a garbage cursor is ignored (first page), never a 500", async () => {
    const repo = new PostgresPartyRepository(db);
    const r = await repo.list({ kind: "supplier", limit: 5, cursor: "not-a-cursor" }, ctx);
    expect(r.data).toHaveLength(5);
    expect(r.meta?.total).toBe(23);
  });
});
