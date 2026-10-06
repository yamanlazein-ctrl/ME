/**
 * Party deletion — completeness, exact counts, and an OCC that tells the truth.
 *
 * The bug this pins: the deletion-impact sheet capped its document list at 100
 * rows and the cascade iterated THAT list, so a customer with 150 invoices had
 * 100 cancelled and 50 left active, pointing at a customer that was itself
 * soft-cancelled. The sheet also reported the capped length as the count, so a
 * customer with 1000 invoices was described as having 100.
 *
 * Everything here runs on live Postgres with the real repositories, wired
 * through `ambientDb` exactly as the production container wires them, so the
 * cascade's single-transaction behaviour is the one under test.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { db } from "@/infrastructure/orm/drizzle.js";
import { ambientDb } from "@/infrastructure/orm/ambient-tx.js";
import { tenants } from "@/infrastructure/orm/schemas/tenant.table.js";
import { parties } from "@/infrastructure/orm/schemas/party.table.js";
import { invoices } from "@/infrastructure/orm/schemas/invoice.table.js";
import { vouchers } from "@/infrastructure/orm/schemas/voucher.table.js";
import { PostgresInvoiceRepository } from "@/infrastructure/repositories/PostgresInvoiceRepository.js";
import { PostgresVoucherRepository } from "@/infrastructure/repositories/PostgresVoucherRepository.js";
import { PostgresPartyRepository } from "@/infrastructure/repositories/PostgresPartyRepository.js";
import {
  computePartyDeletionImpact,
  listActiveLinkedIds,
  listPartyLinkedDocs,
} from "@/infrastructure/repositories/partyDeletionImpact.js";
import {
  getPartyDeletionImpactUseCase,
  purgePartyCascadeUseCase,
} from "@/application/use-cases/parties/purgePartyCascadeUseCase.js";
import { cancelPartyUseCase } from "@/application/use-cases/parties/partyUseCases.js";
import { withTenantTx } from "@/infrastructure/orm/drizzle.js";
import type { TenantContext } from "@/domain/types/index.js";
import { databaseReachable } from "./_helpers/requireDatabase.js";

const INVOICE_COUNT = 150;
const VOUCHER_COUNT = 12;

const tenantId = randomUUID();
const customerId = randomUUID();
const ctx: TenantContext = {
  tenantId,
  userId: randomUUID(),
  userRole: "admin",
  userName: "delete-tester",
};

const dbx = ambientDb(db);
const partyRepo = new PostgresPartyRepository(dbx);
const invoiceRepo = new PostgresInvoiceRepository(dbx);
const voucherRepo = new PostgresVoucherRepository(dbx);

async function activeInvoiceCount(): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(invoices)
    .where(
      and(
        eq(invoices.partyId, customerId),
        eq(invoices.tenantId, tenantId),
        eq(invoices.status, "active"),
      ),
    );
  return Number(row?.n ?? 0);
}

async function activeVoucherCount(): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(vouchers)
    .where(
      and(
        eq(vouchers.partyId, customerId),
        eq(vouchers.tenantId, tenantId),
        eq(vouchers.status, "active"),
      ),
    );
  return Number(row?.n ?? 0);
}

let reachable = false;

beforeAll(async () => {
  reachable = await databaseReachable();
  if (!reachable) return;

  await db.insert(tenants).values({
    id: tenantId,
    name: "Party Delete Completeness",
    slug: `pdc-${tenantId.slice(0, 8)}`,
  } as typeof tenants.$inferInsert);

  await db.insert(parties).values({
    id: customerId,
    tenantId,
    kind: "customer",
    name: `عميل الاختبار ${customerId.slice(0, 8)}`,
    currency: "USD",
    status: "active",
    version: 1,
  });

  // 150 line-less sale invoices and 12 receipts. Both are legitimate active
  // documents; the point is the NUMBER, which is what used to be truncated.
  await db.insert(invoices).values(
    Array.from({ length: INVOICE_COUNT }, (_, i) => ({
      tenantId,
      partyId: customerId,
      partyType: "customer",
      type: "sale" as const,
      number: `INV-${String(i + 1).padStart(4, "0")}`,
      reference: `INV-${String(i + 1).padStart(4, "0")}`,
      date: "2026-09-01",
      currency: "USD",
      subtotal: 100,
      total: 100,
      paid: 0,
      status: "active" as const,
      version: 1,
      createdBy: ctx.userId,
    })),
  );
  await db.insert(vouchers).values(
    Array.from({ length: VOUCHER_COUNT }, (_, i) => ({
      tenantId,
      partyId: customerId,
      partyKind: "customer" as const,
      kind: "receipt",
      number: `REC-${String(i + 1).padStart(4, "0")}`,
      date: "2026-09-01",
      amount: 50,
      method: "cash",
      currency: "USD",
      status: "active" as const,
      version: 1,
      createdBy: ctx.userId,
    })),
  );
});

describe("party deletion — exact counts", () => {
  it("reports the TRUE number of linked documents, not the preview length", async () => {
    if (!reachable) return;
    const impact = await getPartyDeletionImpactUseCase(customerId, ctx);
    expect(impact.ok).toBe(true);
    if (!impact.ok) return;

    expect(impact.data.counts.invoices).toBe(INVOICE_COUNT);
    expect(impact.data.counts.vouchers).toBe(VOUCHER_COUNT);
    expect(impact.data.requiresCascade).toBe(true);
    // The arrays stay small enough to render; the counts stay exact.
    expect(impact.data.invoices.length).toBeLessThanOrEqual(5);
    expect(impact.data.vouchers.length).toBeLessThanOrEqual(5);
    // The copy quotes the real totals, not "8 invoices…".
    expect(impact.data.warning).toContain(String(INVOICE_COUNT));
  });
});

describe("party deletion — every linked document is reachable", () => {
  it("pages through all 150 invoices with no gap and no duplicate", async () => {
    if (!reachable) return;
    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    let total = -1;
    for (;;) {
      const page = await withTenantTx(tenantId, (tx) =>
        listPartyLinkedDocs(tx, tenantId, customerId, {
          kind: "invoice",
          partyKind: "customer",
          limit: 25,
          cursor,
        }),
      );
      pages++;
      total = page.total;
      expect(page.items.length).toBeLessThanOrEqual(25);
      seen.push(...page.items.map((d) => d.id));
      if (!page.nextCursor) break;
      cursor = page.nextCursor;
      if (pages > 50) throw new Error("paging did not terminate");
    }
    expect(total).toBe(INVOICE_COUNT);
    expect(seen).toHaveLength(INVOICE_COUNT);
    expect(new Set(seen).size).toBe(INVOICE_COUNT);
  });

  it("search narrows the page without changing what exists", async () => {
    if (!reachable) return;
    const all = await withTenantTx(tenantId, (tx) =>
      listPartyLinkedDocs(tx, tenantId, customerId, { kind: "invoice", partyKind: "customer" }),
    );
    expect(all.total).toBe(INVOICE_COUNT);

    const one = await withTenantTx(tenantId, (tx) =>
      listPartyLinkedDocs(tx, tenantId, customerId, {
        kind: "invoice",
        partyKind: "customer",
        q: "INV-0042",
      }),
    );
    expect(one.total).toBe(1);
    expect(one.items[0]?.number).toBe("INV-0042");
  });

  it("the cascade work list contains every active document", async () => {
    if (!reachable) return;
    const ids = await withTenantTx(tenantId, (tx) =>
      listActiveLinkedIds(tx, tenantId, customerId, "customer", "invoice"),
    );
    expect(ids).toHaveLength(INVOICE_COUNT);
    expect(new Set(ids.map((i) => i.id)).size).toBe(INVOICE_COUNT);
  });
});

describe("party deletion — cascade completeness", () => {
  it("leaves ZERO active documents behind and soft-cancels the party", async () => {
    if (!reachable) return;
    expect(await activeInvoiceCount()).toBe(INVOICE_COUNT);
    expect(await activeVoucherCount()).toBe(VOUCHER_COUNT);

    const impact = await getPartyDeletionImpactUseCase(customerId, ctx);
    expect(impact.ok).toBe(true);
    if (!impact.ok) return;

    const result = await purgePartyCascadeUseCase({
      partyId: customerId,
      ctx,
      expectedVersion: impact.data.version,
      partyRepo,
      invoiceRepo,
      voucherRepo,
    });
    expect(result.ok).toBe(true);

    // THE regression: before the fix these were 50 and 12 (still active).
    expect(await activeInvoiceCount()).toBe(0);
    expect(await activeVoucherCount()).toBe(0);

    const [party] = await db.select().from(parties).where(eq(parties.id, customerId));
    expect(party?.status).toBe("cancelled");
  });
});

describe("party deletion — OCC that tells the truth", () => {
  it("re-deleting an already deleted party SUCCEEDS instead of raising a phantom conflict", async () => {
    if (!reachable) return;
    // This is the replay the desktop client used to send after the transport
    // mis-read a 204 as a network failure. It must be a no-op success.
    const replay = await cancelPartyUseCase(partyRepo, customerId, ctx.userId, ctx, 1);
    expect(replay.ok).toBe(true);
  });

  it("still refuses a genuinely stale version on an ACTIVE party", async () => {
    if (!reachable) return;
    const id = randomUUID();
    await db.insert(parties).values({
      id,
      tenantId,
      kind: "customer",
      name: `عميل الإصدار ${id.slice(0, 8)}`,
      currency: "USD",
      status: "active",
      version: 3,
    });

    const stale = await cancelPartyUseCase(partyRepo, id, ctx.userId, ctx, 1);
    expect(stale.ok).toBe(false);
    if (stale.ok) return;
    // Factual, and it does not blame a session that never existed.
    expect(stale.error).toContain("3");
    expect(stale.error).toContain("تعارض في الإصدار");
    expect(stale.error).not.toContain("جلسة أخرى");
  });

  it("a delete with the correct version succeeds and bumps the version", async () => {
    if (!reachable) return;
    const id = randomUUID();
    await db.insert(parties).values({
      id,
      tenantId,
      kind: "customer",
      name: `عميل صحيح ${id.slice(0, 8)}`,
      currency: "USD",
      status: "active",
      version: 3,
    });

    const ok = await cancelPartyUseCase(partyRepo, id, ctx.userId, ctx, 3);
    expect(ok.ok).toBe(true);
    if (!ok.ok) return;
    expect(ok.data.status).toBe("cancelled");
    expect(ok.data.version).toBe(4);
  });
});

describe("party deletion — the impact sheet is read-only", () => {
  it("computing the impact changes nothing", async () => {
    if (!reachable) return;
    const id = randomUUID();
    await db.insert(parties).values({
      id,
      tenantId,
      kind: "supplier",
      name: `مورد ${id.slice(0, 8)}`,
      currency: "USD",
      status: "active",
      version: 1,
    });
    await withTenantTx(tenantId, (tx) => computePartyDeletionImpact(tx, tenantId, id));
    const [row] = await db.select().from(parties).where(eq(parties.id, id));
    expect(row?.status).toBe("active");
    expect(row?.version).toBe(1);
  });
});
