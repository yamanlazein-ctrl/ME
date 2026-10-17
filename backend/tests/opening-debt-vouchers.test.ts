import { afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import express, { type RequestHandler } from "express";
import { and, eq } from "drizzle-orm";
import { db } from "@/infrastructure/orm/drizzle.js";
import { tenants } from "@/infrastructure/orm/schemas/tenant.table.js";
import { invoices } from "@/infrastructure/orm/schemas/invoice.table.js";
import { ledgerEntries } from "@/infrastructure/orm/schemas/ledger-entry.table.js";
import { PostgresPartyRepository } from "@/infrastructure/repositories/PostgresPartyRepository.js";
import { PostgresVoucherRepository } from "@/infrastructure/repositories/PostgresVoucherRepository.js";
import { PostgresLedgerRepository } from "@/infrastructure/repositories/PostgresLedgerRepository.js";
import { PostgresStatementRepository } from "@/infrastructure/repositories/PostgresStatementRepository.js";
import { buildContainer } from "@/infrastructure/di/container.js";
import {
  getCashboxBalanceAsOf,
  recomputeCashboxBalanceAsOf,
} from "@/infrastructure/repositories/cashboxBalanceHelper.js";
import { registerVoucherRoutes } from "@/presentation/routes/voucher.route.js";
import type { TenantContext } from "@/domain/types/index.js";
import type { PartyData } from "@/domain/entities/Party.js";

// The SQLite suite resolves these imports to the real twins and uses its own temporary database.
// PostgreSQL runs must explicitly target a disposable test database; no silent reachability skips.
const DATE = "2026-09-20";
const parties = new PostgresPartyRepository(db);
const vouchers = new PostgresVoucherRepository(db);
const ledger = new PostgresLedgerRepository(db);
const statements = new PostgresStatementRepository(db);

const servers: Server[] = [];

afterAll(async () => {
  await Promise.all(
    servers.map(
      (server) =>
        new Promise<void>((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()));
          server.closeAllConnections();
        }),
    ),
  );
});

async function fixture(
  kind: "supplier" | "customer",
  currency = "USD",
  openingCurrency = currency,
) {
  const tenantId = randomUUID();
  const ctx: TenantContext = {
    tenantId,
    userId: randomUUID(),
    userRole: "admin",
    userName: "opening-test",
  };
  await db
    .insert(tenants)
    .values({ id: tenantId, name: "Opening debt test", slug: `opening-${tenantId}` });
  const party = await parties.create(
    {
      kind,
      name: "Migrated debt, no historical invoices",
      code: "OPENING",
      currency,
      openingBalance: 100_000,
      openingCurrency,
      openingDate: DATE,
    },
    ctx,
  );
  return { ctx, party };
}

function voucherInput(party: PartyData, amount = 20_000, currency = "USD") {
  return {
    kind: party.kind === "supplier" ? ("payment" as const) : ("receipt" as const),
    date: DATE,
    partyId: party.id,
    partyKind: party.kind,
    amount,
    currency,
    exchangeRate: currency === "USD" ? 1 : 10_000,
    method: "cash" as const,
  };
}

async function cash(ctx: TenantContext, currency: string, expected: number) {
  await db.transaction(async (tx) => {
    expect(await getCashboxBalanceAsOf(tx, ctx, currency, DATE)).toBe(expected);
    expect(await recomputeCashboxBalanceAsOf(tx, ctx, currency, DATE)).toBe(expected);
  });
}

async function position(party: PartyData, ctx: TenantContext, currency: string, expected: number) {
  expect((await ledger.getBalance(party.id, ctx, currency)).balance).toBe(expected);
  const statement = await statements.getStatement(
    { partyId: party.id, kind: party.kind, currency },
    ctx,
  );
  expect(statement.finalBalance).toBe(expected);
  const list = await parties.list({ kind: party.kind }, ctx);
  const stats = list.data.find((p) => p.id === party.id)!.stats!;
  expect(stats.byCurrency?.[currency]?.remaining ?? 0).toBe(expected);
  if (currency === party.currency) expect(stats.remaining).toBe(expected);
  return { statement, stats };
}

async function noInvoices(ctx: TenantContext) {
  expect(await db.select().from(invoices).where(eq(invoices.tenantId, ctx.tenantId))).toEqual([]);
}

describe.each(["supplier", "customer"] as const)("%s opening debt without invoices", (kind) => {
  it("posts against equity, settles on account, separates currencies and cancels exactly", async () => {
    const { party, ctx } = await fixture(kind);
    const opening = await db
      .select()
      .from(ledgerEntries)
      .where(
        and(eq(ledgerEntries.tenantId, ctx.tenantId), eq(ledgerEntries.referenceId, party.id)),
      );
    expect(opening).toHaveLength(2);
    expect(opening.find((r) => r.type === "opening_equity")?.partyId).toBeNull();
    expect(opening.every((r) => r.cashImpact === "none")).toBe(true);
    expect(opening.reduce((sum, r) => sum + r.debit - r.credit, 0)).toBe(0);
    await position(party, ctx, "USD", 100_000);
    await cash(ctx, "USD", 0);

    const usd = await vouchers.create(voucherInput(party), ctx);
    expect(usd.invoiceId).toBeUndefined();
    expect(usd.appliedAmount).toBeUndefined();
    const { statement } = await position(party, ctx, "USD", 80_000);
    expect(statement.entries.map((e) => e.runningBalance)).toEqual([100_000, 80_000]);
    await cash(ctx, "USD", kind === "supplier" ? -20_000 : 20_000);

    const syp = await vouchers.create(voucherInput(party, 30_000, "SYP"), ctx);
    await position(party, ctx, "SYP", -30_000);
    await position(party, ctx, "USD", 80_000);
    await cash(ctx, "SYP", kind === "supplier" ? -30_000 : 30_000);
    const all = await statements.getStatement({ partyId: party.id, kind, currency: "ALL" }, ctx);
    expect(all.totalsByCurrency?.USD.finalBalance).toBe(80_000);
    expect(all.totalsByCurrency?.SYP.finalBalance).toBe(-30_000);

    await vouchers.cancel(usd.id, ctx.userId, ctx, usd.version);
    await position(party, ctx, "USD", 100_000);
    await position(party, ctx, "SYP", -30_000);
    await cash(ctx, "USD", 0);
    await vouchers.cancel(syp.id, ctx.userId, ctx, syp.version);
    await position(party, ctx, "SYP", 0);
    await cash(ctx, "SYP", 0);
    await noInvoices(ctx);
  });

  it("settles SYP opening debt without touching USD, and carries the baseline into a date window", async () => {
    const { party, ctx } = await fixture(kind, "SYP");
    await vouchers.create({ ...voucherInput(party, 20_000, "SYP"), date: "2026-09-21" }, ctx);
    await position(party, ctx, "SYP", 80_000);
    await position(party, ctx, "USD", 0);
    const window = await statements.getStatement(
      {
        partyId: party.id,
        kind,
        currency: "SYP",
        fromDate: "2026-09-21",
      },
      ctx,
    );
    expect(window.previousBalance).toBe(100_000);
    expect(window.entries).toHaveLength(1);
    expect(window.entries[0]?.runningBalance).toBe(80_000);
    expect(window.finalBalance).toBe(80_000);
    await db.transaction(async (tx) => {
      const expected = kind === "supplier" ? -20_000 : 20_000;
      expect(await getCashboxBalanceAsOf(tx, ctx, "SYP", "2026-09-21")).toBe(expected);
      expect(await recomputeCashboxBalanceAsOf(tx, ctx, "SYP", "2026-09-21")).toBe(expected);
    });
    await cash(ctx, "USD", 0);
    await noInvoices(ctx);
  });

  it("replaces/zeros/moves the opening without changing cash, with opening-first pagination", async () => {
    const { party, ctx } = await fixture(kind);
    await vouchers.create(voucherInput(party), ctx);
    // Ensure the replacement is created strictly after the same-date voucher, on both engines.
    await new Promise((resolve) => setTimeout(resolve, 10));
    const edited = await parties.setOpening(
      party.id,
      {
        openingBalance: 120_000,
        currency: "USD",
        date: DATE,
        note: "Corrected migration baseline",
      },
      ctx,
      party.version,
    );
    const { statement } = await position(party, ctx, "USD", 100_000);
    expect(statement.entries.filter((e) => e.status === "active").map((e) => e.type)).toEqual([
      "opening",
      kind === "supplier" ? "payment_out" : "receipt_in",
    ]);
    expect(
      statement.entries.filter((e) => e.status === "active").map((e) => e.runningBalance),
    ).toEqual([120_000, 100_000]);

    const ids: string[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < statement.entries.length; page++) {
      const numbered = await statements.getStatement(
        { partyId: party.id, kind, currency: "USD", limit: 1, page },
        ctx,
      );
      const keyed = await statements.getStatement(
        { partyId: party.id, kind, currency: "USD", limit: 1, cursor },
        ctx,
      );
      expect(keyed.entries).toEqual(
        numbered.entries.map((entry) => ({ ...entry, seq: keyed.entries[0]!.seq })),
      );
      expect(keyed.page?.balanceBeforePage).toBe(numbered.page?.balanceBeforePage);
      ids.push(keyed.entries[0]!.id);
      cursor = keyed.page?.nextCursor ?? undefined;
    }
    expect(ids).toEqual(statement.entries.map((e) => e.id));
    expect(new Set(ids).size).toBe(ids.length);
    await expect(
      parties.setOpening(
        party.id,
        { openingBalance: 1, currency: "USD", date: DATE },
        ctx,
        party.version,
      ),
    ).rejects.toThrow(/Stale version/);

    const moved = await parties.setOpening(
      party.id,
      { openingBalance: 50_000, currency: "SYP", date: DATE },
      ctx,
      edited.version,
    );
    await position(party, ctx, "USD", -20_000);
    await position(party, ctx, "SYP", 50_000);
    await parties.setOpening(
      party.id,
      { openingBalance: 0, currency: "SYP", date: DATE },
      ctx,
      moved.version,
    );
    await position(party, ctx, "SYP", 0);
    await position(party, ctx, "USD", -20_000);
    await cash(ctx, "USD", kind === "supplier" ? -20_000 : 20_000);
    await cash(ctx, "SYP", 0);
    await noInvoices(ctx);
  });

  it("never labels a foreign-currency opening as the default-currency scalar", async () => {
    const { party, ctx } = await fixture(kind, "SYP", "USD");
    await vouchers.create(voucherInput(party), ctx);
    const { stats } = await position(party, ctx, "USD", 80_000);
    expect(stats.remaining).toBe(0);
    await position(party, ctx, "SYP", 0);
    await noInvoices(ctx);
  });

  it("HTTP replace updates debt/cash once and a refused replacement rolls back both", async () => {
    const { party, ctx } = await fixture(kind);
    const auth: RequestHandler = (req, _res, next) => {
      req.tenantContext = ctx;
      next();
    };
    const app = express();
    app.use(express.json());
    const router = express.Router();
    // Match production wiring: route-level rollback requires ambient-aware repositories.
    const container = buildContainer();
    registerVoucherRoutes(
      router,
      container.voucherRepo,
      container.auditRepo,
      auth,
      auth,
      auth,
      undefined,
      container.partyRepo,
    );
    app.use("/api", router);
    const server = app.listen(0);
    servers.push(server);
    await new Promise<void>((resolve) => server.once("listening", resolve));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/${kind === "supplier" ? "payments" : "receipts"}`;
    const original = await vouchers.create(voucherInput(party), ctx);
    const replace = (extra: Record<string, unknown>) =>
      fetch(`${base}/${original.id}/replace`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Idempotency-Key": randomUUID() },
        body: JSON.stringify({
          expectedVersion: original.version,
          voucher: { ...voucherInput(party, 25_000), ...extra },
        }),
      });
    const refused = await replace({ partyId: randomUUID() });
    expect(refused.status).toBe(422);
    await refused.arrayBuffer();
    expect((await vouchers.findById(original.id, ctx))?.status).toBe("active");
    await position(party, ctx, "USD", 80_000);
    await cash(ctx, "USD", kind === "supplier" ? -20_000 : 20_000);
    const response = await replace({});
    const responseBody = await response.json();
    expect(response.status, JSON.stringify(responseBody)).toBe(201);
    expect((await vouchers.findById(original.id, ctx))?.status).toBe("cancelled");
    await position(party, ctx, "USD", 75_000);
    await cash(ctx, "USD", kind === "supplier" ? -25_000 : 25_000);
    await noInvoices(ctx);
  });
});
