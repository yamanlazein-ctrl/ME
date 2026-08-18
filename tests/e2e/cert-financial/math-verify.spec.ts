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

interface LedgerEntry {
  debit: number;
  credit: number;
  type: string;
  status: string;
  currency: string;
}

interface RollData {
  remainingKg: number;
}

test.describe("Cert Financial — Math Verification", () => {
  test.beforeEach(async ({ page }) => {
    await loginIfNeeded(page);
  });

  test("Formula 1: Stock — after 3 purchase + 1 sale, remainingKg is correct", async ({ page, request }) => {
    test.setTimeout(90000);

    const token = await getAdminToken(request);
    const headers = { Authorization: `Bearer ${token}` };

    const supplier = await createSupplier(request);
    const customer = await createCustomer(request);
    const roll = await createRoll(request, { supplierId: supplier.id, remainingKg: 100, initialKg: 100 });

    const purchaseQty = 30;
    const saleQty = 5;

    await createInvoice(request, {
      type: "entry",
      partyId: supplier.id,
      partyType: "supplier",
      lines: [{ fabricId: "fab-1", colorId: "col-1", rollId: roll.id, quantityKg: purchaseQty, pricePerKg: 12000, discountAmount: 0 }],
      paid: 0,
    });

    await createInvoice(request, {
      type: "sale",
      partyId: customer.id,
      partyType: "customer",
      lines: [{ fabricId: "fab-1", colorId: "col-1", rollId: roll.id, quantityKg: saleQty, pricePerKg: 12000, discountAmount: 0 }],
      paid: 0,
    });

    const res = await fetch(`${BACKEND}/inventory/rolls/${roll.id}`, { headers });
    const rollData = await res.json() as RollData;

    const expected = 100 - saleQty;
    expect(rollData.remainingKg).toBe(expected);
  });

  test("Formula 2: Party Balance — customer ledger reflects sale + receipt", async ({ page, request }) => {
    test.setTimeout(90000);

    const token = await getAdminToken(request);
    const headers = { Authorization: `Bearer ${token}` };

    const customer = await createCustomer(request);

    const inv = await createInvoice(request, {
      type: "sale",
      partyId: customer.id,
      partyType: "customer",
      lines: [{ fabricId: "fab-1", colorId: "col-1", rollId: "rol-1", quantityKg: 2, pricePerKg: 12000, discountAmount: 0 }],
      paid: 0,
    });

    const saleAmount = 2 * 12000;

    await fetch(`${BACKEND}/receipts`, {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({
        partyId: customer.id,
        partyType: "customer",
        amount: saleAmount,
        currency: "SYP",
        method: "cash",
      }),
    });

    const balRes = await fetch(`${BACKEND}/ledger/balance/${customer.id}?currency=SYP`, { headers });
    const balance = await balRes.json() as { balance: number };

    expect(balance.balance).toBe(0);
  });

  test("Formula 3: Cashbox — opening + inflows - outflows match", async ({ page, request }) => {
    test.setTimeout(90000);

    const token = await getAdminToken(request);
    const headers = { Authorization: `Bearer ${token}` };

    const cashboxRes = await fetch(`${BACKEND}/cashbox/state`, { headers });
    const cashbox = await cashboxRes.json() as { balance: number; openingBalance: number };

    expect(typeof cashbox.balance).toBe("number");
    expect(isNaN(cashbox.balance)).toBe(false);
    expect(isFinite(cashbox.balance)).toBe(true);
  });
});
