// Reproduction for the first-download stop seen on a real hub (40 units applied, then "تعذّر إكمال التسجيل"):
// the desktop builds a company-shaped hub (every document kind, SYP + USD, cancellations, expenses, cashbox, company
// profile) and a NEW phone must finish its first download with nothing parked or left unapplied.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { parityAvailable, startParity, type Parity } from "./harness";
import { runFirstDownload } from "../../src/core/firstDownload";
import { deviceFirstDownloadDeps } from "../../src/core/firstDownloadDeps";

vi.mock("expo-file-system/legacy", () => ({
  getFreeDiskStorageAsync: async () => 10 ** 12,
  documentDirectory: "file:///docs/",
  cacheDirectory: "file:///cache/",
}));

describe.skipIf(!parityAvailable())("first download of a company-shaped hub", () => {
  let p: Parity;
  let customerId = "";
  let supplierId = "";
  let fabricId = "";

  beforeAll(async () => {
    p = await startParity(18500);
    const D = p.desktop.call;
    const must = p.ac8.must;
    await must(D, "blocks", "POST", "/api/sync/number-blocks/ensure", {
      syncDeviceId: p.desktop.deviceId,
      entityTypes: [
        "customer",
        "supplier",
        "invoice",
        "invoice_entry",
        "voucher",
        "return",
        "expense",
        "order",
        "settlement",
      ],
    });
    await must(D, "company", "PUT", "/api/company/profile", {
      name: "شركة الاختبار",
      phone: "0944000000",
      address: "دمشق",
    });
    const c1: string = (
      await must(D, "customer", "POST", "/api/customers", {
        name: "عميل أ",
        phone: "0944111222",
        openingBalance: 120.5,
      })
    ).id as string;
    const s1: string = (
      await must(D, "supplier", "POST", "/api/suppliers", {
        kind: "supplier",
        name: "مورد أ",
        openingBalance: 830.4,
      })
    ).id as string;
    const fabric = (await must(D, "fabric", "POST", "/api/inventory/fabrics", { name: "قطن" }))
      .id as string;
    const color = (
      await must(D, "color", "POST", "/api/inventory/colors", { fabricId: fabric, name: "أبيض" })
    ).id as string;
    const line = (rollId: string, kg: number, price: number) => ({
      fabricId: fabric,
      colorId: color,
      rollId,
      quantityKg: kg,
      pieces: 1,
      pricePerKg: price,
    });
    const roll = async (no: string, remainingKg?: number) =>
      (
        await must(D, `roll ${no}`, "POST", "/api/inventory/rolls", {
          colorId: color,
          rollNo: no,
          initialKg: 900,
          ...(remainingKg === undefined ? {} : { remainingKg }),
          supplierId: s1,
          pieces: 50,
          pricePerKg: 2,
          currency: "USD",
          entryDate: "2026-02-01",
        })
      ).id as string;
    const r1 = await roll("R1", 0);
    const r2 = await roll("R2");
    const entry = (
      await must(D, "entry", "POST", "/api/invoices", {
        type: "entry",
        date: "2026-02-01",
        partyId: s1,
        partyType: "supplier",
        currency: "USD",
        lines: [line(r1, 50, 2)],
        paid: 10,
        paymentMethod: "cash",
      })
    ).id as string;
    const sale = (
      await must(D, "sale", "POST", "/api/invoices", {
        type: "sale",
        date: "2026-02-10",
        partyId: c1,
        partyType: "customer",
        currency: "SYP",
        exchangeRate: 14800,
        lines: [line(r2, 33.33, 26500.5)],
        discount: 5000,
        paid: 400000,
        paymentMethod: "cash",
      })
    ).id as string;
    await must(D, "receipt", "POST", "/api/receipts", {
      kind: "receipt",
      date: "2026-02-15",
      partyId: c1,
      partyKind: "customer",
      invoiceId: sale,
      amount: 150000.75,
      discount: 2500.25,
      currency: "SYP",
      exchangeRate: 14800,
      method: "cash",
    });
    await must(D, "payment", "POST", "/api/payments", {
      kind: "payment",
      date: "2026-02-16",
      partyId: s1,
      partyKind: "supplier",
      amount: 20,
      currency: "USD",
      method: "cash",
    });
    await must(D, "return", "POST", "/api/returns", {
      kind: "sale",
      date: "2026-02-18",
      partyId: c1,
      originalInvoiceId: sale,
      reason: "defect",
      currency: "SYP",
      lines: [{ rollId: r2, quantityKg: 3.33, pieces: 1, pricePerKg: 26500.5 }],
    });
    await must(D, "expense", "POST", "/api/expenses", {
      category: "نقل",
      description: "شحن",
      amount: 35000,
      currency: "SYP",
      date: "2026-02-05",
      method: "cash",
      paidFromCashbox: true,
    });
    await must(D, "cashbox opening", "POST", "/api/cashbox/opening-balance", {
      openingBalance: 5000000,
      openingDate: "2026-01-31",
      currency: "SYP",
    });
    await must(D, "cashbox manual", "POST", "/api/cashbox/manual-movements", {
      date: "2026-02-03",
      type: "capital",
      direction: "in",
      amount: 750000.5,
      currency: "SYP",
    });
    await must(D, "close day", "POST", "/api/cashbox/close-day", {
      date: "2026-02-05",
      counted: 5595000.5,
      currency: "SYP",
    });
    const cur = await must(D, "get entry", "GET", `/api/invoices/${entry}`);
    void cur;
    // A desktop stock adjustment: 900 → 850.5 kg on R1's sibling lot R2 is sold from, so movements carry all kinds.
    const r2now = (await must(D, "roll R2", "GET", `/api/inventory/rolls/${r2}`)) as {
      version: number;
    };
    await must(D, "adjust R2", "POST", `/api/inventory/rolls/${r2}/adjust`, {
      newKg: 850.5,
      reason: "جرد فعلي",
      expectedVersion: r2now.version,
    });
    fabricId = fabric;
    await p.ac8.syncUntilDrained(D, 10);
    customerId = c1;
    supplierId = s1;
  }, 900_000);

  afterAll(async () => {
    await p?.stop();
  }, 120_000);

  it("a new phone finishes its first download and holds exactly what the hub holds", async () => {
    const result = await runFirstDownload(deviceFirstDownloadDeps(p.phone));
    const stuck = await p.phone.repos.syncInboxRepo.listByStatus(
      p.phone.context().tenantId,
      ["received", "dead"],
      20,
    );
    expect(
      stuck.map((r) => `${r.entityType} ${r.operation} ${JSON.stringify(r.materializeError)}`),
    ).toEqual([]);
    expect(result).toMatchObject({ done: true });
    // Business rows exist on the phone (ids of derived singletons differ by design, so no row-by-row diff here).
    const inv = await p.phone.repos.invoiceRepo.list({ limit: 100 } as never, p.phone.context());
    expect(inv.data.length).toBe(2);
  }, 900_000);

  it("the phone's statements equal the desktop's for the same customer and supplier (all currencies, and a period)", async () => {
    const { loadStatement } = await import("../../src/core/parties");
    const cases = [
      { id: customerId, kind: "customer" as const, base: "customers" },
      { id: supplierId, kind: "supplier" as const, base: "suppliers" },
    ];
    for (const c of cases) {
      for (const period of [
        { from: null, to: null },
        { from: "2026-02-11", to: "2026-02-28" },
      ]) {
        const qs = new URLSearchParams({ currency: "ALL", limit: "500" });
        if (period.from) qs.set("from", period.from);
        if (period.to) qs.set("to", period.to);
        const desktop = await p.ac8.must(
          p.desktop.call,
          `desktop statement ${c.kind}`,
          "GET",
          `/api/${c.base}/${c.id}/statement?${qs.toString()}`,
        );
        const phone = await loadStatement(p.phone, {
          partyId: c.id,
          kind: c.kind,
          currency: "ALL",
          from: period.from,
          to: period.to,
        });
        const desktopTotals = Object.entries(
          (desktop as { totalsByCurrency: Record<string, Record<string, number>> })
            .totalsByCurrency,
        )
          .map(([currency, t]) => ({
            currency,
            previous: t.previousBalance,
            debit: t.totalDebit,
            credit: t.totalCredit,
            closing: t.finalBalance,
          }))
          .sort((a, b) => a.currency.localeCompare(b.currency));
        expect(
          phone.totals.map(({ side, ...rest }) => {
            void side;
            return rest;
          }),
          `${c.kind} ${period.from ?? "all"}`,
        ).toEqual(desktopTotals);
        const desktopRows = (desktop as { entries: Array<Record<string, unknown>> }).entries.map(
          (e) => [
            e.type,
            e.referenceNumber,
            Number(e.debit),
            Number(e.credit),
            Number(e.runningBalance),
          ],
        );
        expect(
          phone.entries.map((e) => [
            e.type,
            e.referenceNumber,
            Number(e.debit),
            Number(e.credit),
            Number(e.runningBalance),
          ]),
        ).toEqual(desktopRows);
      }
    }
  }, 900_000);

  it("stock on the phone equals the desktop's: every lot's kg and pieces, every movement, the fabric totals", async () => {
    const { listFabrics, loadColorLots, loadFabric, loadLot, MOVEMENT_LABEL } =
      await import("../../src/core/stock");
    const D = p.desktop.call;
    const rolls = (
      (await p.ac8.must(D, "desktop rolls", "GET", "/api/inventory/rolls?limit=200")) as {
        data: Array<{
          id: string;
          rollNo: string;
          remainingKg: number;
          remainingPieces: number;
          initialKg: number;
          pieces: number;
          colorId: string;
        }>;
      }
    ).data;
    expect(rolls.length).toBeGreaterThanOrEqual(2);
    for (const r of rolls) {
      const lot = await loadLot(p.phone, r.id);
      expect(lot, r.rollNo).not.toBeNull();
      expect(
        [lot!.remainingKg, lot!.remainingPieces, lot!.initialKg, lot!.pieces],
        r.rollNo,
      ).toEqual([
        Number(r.remainingKg),
        Number(r.remainingPieces),
        Number(r.initialKg),
        Number(r.pieces),
      ]);
      const desktopMoves = (
        (await p.ac8.must(
          D,
          `movements ${r.rollNo}`,
          "GET",
          `/api/inventory/rolls/${r.id}/movements`,
        )) as {
          data: Array<{
            id: string;
            direction: string;
            quantityKg: number;
            balanceAfterKg: number;
            movementType: string;
          }>;
        }
      ).data;
      // Movement rows are derived on each device by replaying the documents, so their ids differ by design; their
      // content must not.
      const phoneKeys = lot!.movements.map(
        (m) => `${m.label}|${m.direction}|${m.quantityKg}|${m.balanceAfterKg}`,
      );
      const desktopKeys = desktopMoves.map(
        (m) =>
          `${MOVEMENT_LABEL[m.movementType] ?? m.movementType}|${m.direction}|${Number(m.quantityKg)}|${Number(m.balanceAfterKg)}`,
      );
      expect(phoneKeys.sort(), `movements ${r.rollNo}`).toEqual(desktopKeys.sort());
    }
    // The adjustment, the sale and the return all reached the phone's movement list of R2.
    const r2 = rolls.find((r) => r.rollNo === "R2")!;
    const labels = (await loadLot(p.phone, r2.id))!.movements.map((m) => m.label).sort();
    expect(labels).toEqual(expect.arrayContaining(["تعديل يدوي", "فاتورة بيع", "مرتجع بيع"]));
    // Fabric and colour totals are the sums of the desktop's lots.
    const sumKg = rolls.reduce((s, r) => s + Number(r.remainingKg), 0);
    const sumPieces = rolls.reduce((s, r) => s + Number(r.remainingPieces), 0);
    const f = (await listFabrics(p.phone, "")).find((x) => x.id === fabricId)!;
    expect([Math.round(f.remainingKg * 100) / 100, f.pieces]).toEqual([
      Math.round(sumKg * 100) / 100,
      sumPieces,
    ]);
    const colors = (await loadFabric(p.phone, fabricId))!.colors;
    const lots = (await loadColorLots(p.phone, colors[0]!.id))!.lots;
    expect(lots.map((l) => l.rollNo).sort()).toEqual(rolls.map((r) => r.rollNo).sort());
  }, 900_000);
});
