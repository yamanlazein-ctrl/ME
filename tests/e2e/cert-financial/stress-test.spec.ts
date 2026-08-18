import { test, expect } from "@playwright/test";
import { loginIfNeeded } from "../_helpers/login";
import {
  createRoll,
  createInvoice,
  createSupplier,
  createCustomer,
  getAdminToken,
} from "../_helpers/mock-data";

const BACKEND = process.env.PLAYWRIGHT_BACKEND_URL ?? "http://localhost:8080";

test.describe("Cert Financial — Stress Test", () => {
  test.beforeEach(async ({ page }) => {
    await loginIfNeeded(page);
  });

  test("Create 20 invoices via API — no duplicates, no crashes", async ({ page, request }) => {
    test.setTimeout(120000);

    const N = 20;
    const token = await getAdminToken(request);
    const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };

    const supplier = await createSupplier(request);
    const customer = await createCustomer(request);
    const roll = await createRoll(request, {
      supplierId: supplier.id,
      initialKg: 1000,
      remainingKg: 1000,
    });

    const ids = new Set<string>();

    for (let i = 0; i < N; i++) {
      const type = i % 2 === 0 ? "entry" : "sale";
      const partyId = type === "entry" ? supplier.id : customer.id;

      const body = {
        type,
        date: new Date().toISOString().slice(0, 10),
        partyId,
        partyType: type === "entry" ? "supplier" : "customer",
        currency: "SYP",
        lines: [
          {
            fabricId: "fab-1",
            colorId: "col-1",
            rollId: roll.id,
            quantityKg: 1,
            pricePerKg: 12000,
            discountAmount: 0,
          },
        ],
        paid: 0,
      };

      const res = await fetch(`${BACKEND}/invoices`, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
      });

      if (res.ok) {
        const data = await res.json() as { id: string };
        expect(ids.has(data.id)).toBe(false);
        ids.add(data.id);
      }
    }

    expect(ids.size).toBeGreaterThan(0);

    const rollRes = await fetch(`${BACKEND}/inventory/rolls/${roll.id}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const rollData = await rollRes.json() as { remainingKg: number };
    expect(rollData.remainingKg).toBeGreaterThanOrEqual(0);

    const cashboxRes = await fetch(`${BACKEND}/cashbox/state`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const cashbox = await cashboxRes.json() as { balance: number };
    expect(isNaN(cashbox.balance)).toBe(false);
    expect(isFinite(cashbox.balance)).toBe(true);
  });

  test("Create 20 vouchers (payments + receipts) — no duplicates", async ({ page, request }) => {
    test.setTimeout(120000);

    const N = 20;
    const token = await getAdminToken(request);
    const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };

    const supplier = await createSupplier(request);
    const customer = await createCustomer(request);

    const pairs = [
      { endpoint: "/receipts", partyId: customer.id, type: "receipt" },
      { endpoint: "/payments", partyId: supplier.id, type: "payment" },
    ];

    const ids = new Set<string>();

    for (let i = 0; i < N; i++) {
      const pair = pairs[i % 2];
      const body = {
        partyId: pair.partyId,
        partyType: pair.type === "receipt" ? "customer" : "supplier",
        amount: 1000,
        currency: "SYP",
        method: "cash",
      };

      const res = await fetch(`${BACKEND}${pair.endpoint}`, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
      });

      if (res.ok) {
        const data = await res.json() as { id: string };
        expect(ids.has(data.id)).toBe(false);
        ids.add(data.id);
      }
    }

    expect(ids.size).toBeGreaterThan(0);

    const cashboxRes = await fetch(`${BACKEND}/cashbox/state`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const cashbox = await cashboxRes.json() as { balance: number };
    expect(isNaN(cashbox.balance)).toBe(false);
    expect(isFinite(cashbox.balance)).toBe(true);
  });

  test("Create 20 expenses — no duplicates", async ({ page, request }) => {
    test.setTimeout(120000);

    const N = 20;
    const token = await getAdminToken(request);
    const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };

    const ids = new Set<string>();

    for (let i = 0; i < N; i++) {
      const body = {
        name: `مصروف-${i + 1}`,
        amount: 500,
        currency: "SYP",
        paidFromCashbox: true,
      };

      const res = await fetch(`${BACKEND}/expenses`, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
      });

      if (res.ok) {
        const data = await res.json() as { id: string };
        expect(ids.has(data.id)).toBe(false);
        ids.add(data.id);
      }
    }

    expect(ids.size).toBeGreaterThan(0);
  });

  test("Verify global ledger is consistent after stress", async ({ page, request }) => {
    test.setTimeout(30000);

    const token = await getAdminToken(request);
    const headers = { Authorization: `Bearer ${token}` };

    const res = await fetch(`${BACKEND}/ledger`, { headers });
    const entries = await res.json() as { id: string; status: string }[];

    const ids = new Set<string>();
    for (const e of entries) {
      expect(ids.has(e.id)).toBe(false);
      ids.add(e.id);
    }

    expect(ids.size).toBeGreaterThan(0);
  });
});
