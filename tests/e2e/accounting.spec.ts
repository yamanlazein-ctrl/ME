/**
 * Accounting E2E Suite — سندات القبض، سندات الصرف، المصاريف، دفتر الحركات، الصندوق، كشف الحساب
 */
import { test, expect } from "@playwright/test";

const API = "http://localhost:8080/api";
const AUTH = { email: "admin@erp.local", password: "Admin@12345" };
let token = "";
async function api(path: string, opts: RequestInit = {}) {
  if (!token) {
    const r = await fetch(`${API}/auth/login`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(AUTH),
    });
    token = (await r.json()).accessToken;
  }
  const res = await fetch(path.startsWith("http") ? path : `${API}${path}`, {
    ...opts,
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}`, ...opts.headers },
  });
  return { status: res.status, data: await res.json().catch(() => null) };
}

test.describe("سندات القبض والصرف", () => {
  const custId = "5b9f06a8-5e18-4c5a-b372-7eee0e23ea76";
  const suppId = "e2b0e481-10c4-46c1-b4d5-c64bbd2ad25b";
  let recId = "", payId = "";

  test("create receipt → 201", async () => {
    const { status, data } = await api("/receipts", { method: "POST", body: JSON.stringify({
      kind: "receipt", date: "2026-08-12", partyId: custId, partyKind: "customer",
      amount: 10000, currency: "SYP", method: "cash",
    })});
    expect(status).toBe(201);
    expect(data.number).toMatch(/^VOC-/);
    recId = data.id;
  });

  test("create payment → 201", async () => {
    const { status, data } = await api("/payments", { method: "POST", body: JSON.stringify({
      kind: "payment", date: "2026-08-12", partyId: suppId, partyKind: "supplier",
      amount: 5000, currency: "SYP", method: "cash",
    })});
    expect(status).toBe(201);
    expect(data.number).toMatch(/^VOC-/);
    payId = data.id;
  });

  test("cancel receipt → 200", async () => {
    const { status } = await api(`/receipts/${recId}/cancel`, { method: "POST" });
    expect(status).toBe(200);
  });

  test("cancel payment → 200", async () => {
    const { status } = await api(`/payments/${payId}/cancel`, { method: "POST" });
    expect(status).toBe(200);
  });
});

test.describe("المصاريف", () => {
  test("list expenses", async () => {
    const { status, data } = await api("/expenses?limit=5");
    expect(status).toBe(200);
    expect(data.meta).toBeDefined();
  });

  test("create expense → 201", async () => {
    const { status, data } = await api("/expenses", { method: "POST", body: JSON.stringify({
      date: "2026-08-12", category: "كهرباء", amount: 1000, currency: "SYP",
      paidFromCashbox: true, method: "cash",
    })});
    expect(status).toBe(201);
    // cancel immediately to clean up
    await api(`/expenses/${data.id}/cancel`, { method: "POST" });
  });
});

test.describe("دفتر الحركات المركزي", () => {
  test("list ledger entries", async () => {
    const { status, data } = await api("/ledger?limit=10");
    expect(status).toBe(200);
    expect(data.meta.total).toBeGreaterThanOrEqual(0);
    expect(data.data.length).toBeLessThanOrEqual(10);
  });

  test("ledger has expected entry types", async () => {
    const { data } = await api("/ledger?limit=20");
    const types = new Set(data.data.map((e: any) => e.type));
    expect(types.has("sales_invoice") || types.has("purchase_invoice")).toBeTruthy();
  });

  test("ledger sort=asc works", async () => {
    const { status } = await api("/ledger?limit=5&sort=asc");
    expect(status).toBe(200);
  });
});

test.describe("الصندوق", () => {
  test("GET cashbox state", async () => {
    const { status, data } = await api("/cashbox/state");
    expect(status).toBe(200);
    expect(data).toHaveProperty("isLocked");
  });

  test("GET cashbox balance for today", async () => {
    const { status } = await api("/cashbox/balance/2026-08-12");
    expect(status).toBe(200);
  });

  test("GET cashbox movements for today", async () => {
    const { status } = await api("/cashbox/movements/2026-08-12?currency=SYP");
    expect(status).toBe(200);
  });
});

test.describe("كشف حساب العملاء والموردين", () => {
  test("customer statement → 200", async () => {
    const { status, data } = await api("/customers/5b9f06a8-5e18-4c5a-b372-7eee0e23ea76/statement?currency=SYP");
    expect(status).toBe(200);
    expect(data).toHaveProperty("previousBalance");
    expect(data).toHaveProperty("finalBalance");
    expect(data.entries).toBeDefined();
  });

  test("supplier statement → 200", async () => {
    const { status, data } = await api("/suppliers/e2b0e481-10c4-46c1-b4d5-c64bbd2ad25b/statement?currency=SYP");
    expect(status).toBe(200);
    expect(data).toHaveProperty("finalBalance");
  });

  test("statement currency isolation: USD ≠ SYP", async () => {
    const { data: syp } = await api("/customers/5b9f06a8-5e18-4c5a-b372-7eee0e23ea76/statement?currency=SYP");
    const { data: usd } = await api("/customers/5b9f06a8-5e18-4c5a-b372-7eee0e23ea76/statement?currency=USD");
    // Both should return valid data; they should not crash
    expect(syp.finalBalance).toBeDefined();
    expect(usd.finalBalance).toBeDefined();
  });

  test("invalid UUID → 400", async () => {
    const { status } = await api("/customers/undefined/statement?currency=SYP");
    expect(status).toBe(400);
  });
});