// Sync parity scenarios (tasks T052, G2). Documents are created by calling use-cases directly (no UI) on the phone, and
// through the real HTTP API on the desktop; after each scenario phone, desktop and hub are compared field by field.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { parityAvailable, startParity, type Parity } from "./harness";
import { cashboxBalanceAt } from "../../src/core/cashbox";
import { claimLossAlerts } from "../../src/core/claimLoss";
import { listRejectedDocuments } from "../../src/core/syncQueries";

const DATE = "2026-03-01";

describe.skipIf(!parityAvailable())("sync parity scenarios (T052)", () => {
  let p: Parity;
  const customers: string[] = [];
  let fabric = "";
  let color = "";
  const rolls: string[] = [];
  let shared = "";

  const saleInput = (
    customerId: string,
    rollId: string,
    lines: Array<{ kg: number; price: number }>,
    paid = 0,
  ) => ({
    type: "sale" as const,
    date: DATE,
    partyId: customerId,
    partyType: "customer" as const,
    currency: "USD",
    exchangeRate: 1,
    lines: lines.map((l) => ({
      fabricId: fabric,
      colorId: color,
      rollId,
      quantityKg: l.kg,
      pieces: 1,
      pricePerKg: l.price,
    })),
    paid,
  });

  beforeAll(async () => {
    p = await startParity(18300);
    const D = p.desktop.call;
    const must = p.ac8.must;
    const ensured = await must(D, "desktop blocks", "POST", "/api/sync/number-blocks/ensure", {
      syncDeviceId: p.desktop.deviceId,
      entityTypes: ["customer", "supplier", "invoice", "invoice_entry", "voucher"],
    });
    expect((ensured as { ensured: unknown[] }).ensured.length).toBeGreaterThan(0);
    for (let i = 0; i < 3; i++) {
      customers.push(
        (await must(D, "customer", "POST", "/api/customers", { name: `Parity Customer ${i}` }))
          .id as string,
      );
    }
    fabric = (await must(D, "fabric", "POST", "/api/inventory/fabrics", { name: "Parity Fabric" }))
      .id as string;
    color = (
      await must(D, "color", "POST", "/api/inventory/colors", {
        fabricId: fabric,
        name: "Parity Color",
      })
    ).id as string;
    const roll = async (rollNo: string, kg: number) =>
      (
        await must(D, `roll ${rollNo}`, "POST", "/api/inventory/rolls", {
          colorId: color,
          rollNo,
          initialKg: kg,
          pieces: 500,
          pricePerKg: 2,
          currency: "USD",
          entryDate: DATE,
        })
      ).id as string;
    for (let i = 0; i < 4; i++) rolls.push(await roll(`PAR-R${i}`, 5000));
    shared = await roll("PAR-RS", 100);
    await p.syncAll();
    expect(await p.compareAll()).toEqual([]);
  }, 900_000);

  afterAll(async () => {
    await p?.stop();
  }, 120_000);

  it("(a) a receipt recorded on the phone converges", async () => {
    const r = await p.phone.documents.createVoucher("receipt", {
      date: DATE,
      partyId: customers[0] as string,
      partyKind: "customer",
      amount: 500,
      currency: "USD",
      exchangeRate: 1,
      method: "cash",
    });
    expect(r.ok, JSON.stringify(r)).toBe(true);
    expect(await p.compareAll()).toEqual([]);
  }, 300_000);

  let saleId = "";
  it("(b) a 3-line sale on the phone converges", async () => {
    const r = await p.phone.documents.createInvoice(
      saleInput(
        customers[1] as string,
        rolls[0] as string,
        [
          { kg: 10, price: 4.25 },
          { kg: 7.5, price: 4.25 },
          { kg: 2.25, price: 5 },
        ],
        20,
      ),
    );
    expect(r.ok, JSON.stringify(r)).toBe(true);
    if (r.ok) saleId = r.data.id;
    expect(await p.compareAll()).toEqual([]);
  }, 300_000);

  it("(c) the desktop cancels the phone's sale and everything converges", async () => {
    const inv = await p.ac8.must(p.desktop.call, "read sale", "GET", `/api/invoices/${saleId}`);
    await p.ac8.must(p.desktop.call, "cancel sale", "POST", `/api/invoices/${saleId}/cancel`, {
      expectedVersion: inv.version,
    });
    expect(await p.compareAll()).toEqual([]);
    const phoneInv = await p.phone.repos.invoiceRepo.findById(saleId, p.phone.context());
    expect(phoneInv?.status).toBe("cancelled");
  }, 300_000);

  it("(d) a voucher amended on the phone (replace = one transaction) converges", async () => {
    const made = await p.phone.documents.createVoucher("receipt", {
      date: DATE,
      partyId: customers[2] as string,
      partyKind: "customer",
      amount: 100,
      currency: "USD",
      exchangeRate: 1,
      method: "cash",
    });
    expect(made.ok).toBe(true);
    if (!made.ok) return;
    const replaced = await p.phone.documents.replaceVoucher(
      made.data.id,
      "receipt",
      made.data.version,
      {
        date: DATE,
        partyId: customers[2] as string,
        partyKind: "customer",
        amount: 150,
        currency: "USD",
        exchangeRate: 1,
        method: "cash",
      },
    );
    expect(replaced.ok, JSON.stringify(replaced)).toBe(true);
    expect(await p.compareAll()).toEqual([]);
  }, 300_000);

  it("(j) an expense, a new party with a receipt, and a manual cashbox movement made on the phone converge", async () => {
    const expense = await p.phone.documents.createExpense({
      category: "إيجار",
      description: "إيجار المحل",
      amount: 75,
      currency: "USD",
      date: DATE,
      method: "cash",
      paidFromCashbox: false,
    });
    expect(expense.ok, JSON.stringify(expense)).toBe(true);
    const party = await p.phone.documents.createParty("customer", {
      name: "Phone Made Customer",
      currency: "USD",
    });
    expect(party.ok, JSON.stringify(party)).toBe(true);
    if (!party.ok) return;
    const receipt = await p.phone.documents.createVoucher("receipt", {
      date: DATE,
      partyId: party.data.id,
      partyKind: "customer",
      amount: 40,
      currency: "USD",
      exchangeRate: 1,
      method: "cash",
    });
    expect(receipt.ok, JSON.stringify(receipt)).toBe(true);
    const movement = await p.phone.documents.addCashboxMovement({
      date: DATE,
      type: "capital",
      direction: "in",
      amount: 300,
      currency: "USD",
      description: "parity",
    });
    expect(movement.ok, JSON.stringify(movement)).toBe(true);
    expect(await p.compareAll()).toEqual([]);
  }, 300_000);

  it("(k) the phone's cashbox balance at a date equals the desktop's, per currency", async () => {
    await p.syncAll();
    for (const currency of ["USD", "SYP"]) {
      const desktop = await p.desktop.call(
        "GET",
        `/api/cashbox/balance/${DATE}?currency=${currency}`,
      );
      const phone = await cashboxBalanceAt(p.phone, DATE, currency);
      expect(phone, currency).toBe(Number(desktop.text));
    }
  }, 300_000);

  it("(l) the phone cancels its own sale (reversal entries) and everything converges", async () => {
    const sale = await p.phone.documents.createInvoice(
      saleInput(customers[2] as string, rolls[3] as string, [{ kg: 4, price: 3.5 }], 5),
    );
    expect(sale.ok, JSON.stringify(sale)).toBe(true);
    if (!sale.ok) return;
    const cancelled = await p.phone.documents.cancelInvoice(sale.data.id, sale.data.version);
    expect(cancelled.ok, JSON.stringify(cancelled)).toBe(true);
    expect(await p.compareAll()).toEqual([]);
    const onDesktop = await p.ac8.must(
      p.desktop.call,
      "read cancelled",
      "GET",
      `/api/invoices/${sale.data.id}`,
    );
    expect((onDesktop as { status?: string }).status).toBe("cancelled");
  }, 300_000);

  it("(f) phone block exhaustion: the 101st offline invoice is refused (no overlapping numbers), a refill fixes it", async () => {
    // Evidence (specs/002-mobile-app/evidence/T052.md): the shared allocator does NOT fall back to the shared sequence when a
    // device block runs out - it refuses with "نفدت كتلة الترقيم…" (allowGlobalFallback is not set by the invoice repository).
    const before = (await p.phone.repos.documentNumberBlockRepo.findActive(
      p.ac8.TENANT_ID as never,
      p.ac8.DEV_B as never,
      "invoice",
      new Date().getFullYear(),
    ))!;
    const left = before.endNumber - before.nextNumber + 1;
    const numbers: string[] = [];
    let refused = "";
    for (let i = 0; i < left + 1; i++) {
      const r = await p.phone.documents.createInvoice(
        saleInput(customers[i % 3] as string, rolls[1 + (i % 3)] as string, [{ kg: 1, price: 3 }]),
      );
      if (r.ok) numbers.push(r.data.number);
      else refused = r.error;
    }
    expect(numbers.length).toBe(left);
    expect(new Set(numbers).size).toBe(left);
    expect(refused).toContain("نفدت كتلة الترقيم");
    // Online again: the phone gets a new 100-number block and the numbers stay unique across the hub.
    await p.syncAll(12);
    const next = await p.phone.documents.createInvoice(
      saleInput(customers[0] as string, rolls[1] as string, [{ kg: 1, price: 3 }]),
    );
    expect(next.ok, JSON.stringify(next)).toBe(true);
    if (next.ok) numbers.push(next.data.number);
    expect(new Set(numbers).size).toBe(numbers.length);
    expect(await p.compareAll()).toEqual([]);
    const after = await p.hub.call("GET", "/api/invoices?limit=1000");
    const hubNumbers = ((after.json?.data ?? after.json) as Array<{ number: string }>).map(
      (i) => i.number,
    );
    expect(new Set(hubNumbers).size).toBe(hubNumbers.length);
  }, 600_000);

  it("(g) hub epoch change: the phone rebases (cursor reset, history re-queued) and converges", async () => {
    await p.ac8.must(p.hub.call, "rotate epoch", "POST", "/api/sync/hub/identity/rotate", {
      reason: `parity ${randomUUID().slice(0, 8)}`,
    });
    const cycle = await p.phone.syncOnce();
    const rebased = cycle.pull.rebased ?? null;
    await p.syncAll(10);
    expect(rebased === null || typeof rebased.reason === "string").toBe(true);
    expect(await p.compareAll()).toEqual([]);
  }, 600_000);
  // Runs last: the phone keeps its cancelled loser (a document the hub never accepted), so a full table comparison
  // is no longer expected to be empty afterwards - only balances, cashbox and the hub's documents are.
  it("(e) claim race: the same roll sold on both while offline — first push wins, the loser is cancelled locally", async () => {
    // Both hold the shared roll (100 kg) and sell 80 kg of it without syncing in between.
    const D = p.desktop.call;
    await p.ac8.must(
      D,
      "desktop sale",
      "POST",
      "/api/invoices",
      saleInput(customers[0] as string, shared, [{ kg: 80, price: 4 }]),
    );
    const phoneSale = await p.phone.documents.createInvoice(
      saleInput(customers[1] as string, shared, [{ kg: 80, price: 4 }]),
    );
    expect(phoneSale.ok, JSON.stringify(phoneSale)).toBe(true);
    // The desktop reaches the hub first.
    await p.ac8.syncUntilDrained(D, 4);
    const phoneCycle = await p.phone.syncOnce();
    expect(phoneCycle.push.rejected).toBeGreaterThanOrEqual(1);
    await p.syncAll();
    if (phoneSale.ok) {
      const loser = await p.phone.repos.invoiceRepo.findById(phoneSale.data.id, p.phone.context());
      expect(loser?.status).toBe("cancelled");
      // The owner is told which invoice and which roll (FR-34).
      const alerts = await claimLossAlerts(p.phone, await listRejectedDocuments(p.phone));
      expect(alerts.length).toBeGreaterThanOrEqual(1);
      const message = alerts.map((a) => a.message).join("\n");
      expect(message).toContain(phoneSale.data.number);
      expect(message).toContain("PAR-RS");
    }
    // Balances, cashbox and stock agree on all three even though the phone keeps its cancelled document.
    const diffs = (await p.compareAll()).filter(
      (d) => d.startsWith("party balances") || d.startsWith("cashbox"),
    );
    expect(diffs).toEqual([]);
  }, 300_000);
});
