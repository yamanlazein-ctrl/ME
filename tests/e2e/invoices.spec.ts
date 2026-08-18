/**
 * Invoices E2E Suite — فواتير الدخول، فواتير البيع، مرتجعات، سجل المرتجعات، تتبع الفواتير
 * Tests full data lifecycle against live servers: frontend 8081, backend 8080.
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

test.describe("فاتورة دخول", () => {
  const sid = "e2b0e481-10c4-46c1-b4d5-c64bbd2ad25b";
  const fid = "847ac9b2-5dff-4f92-b1f7-67829eb7fab8";
  const cid = "1cb948a2-55c9-456d-873f-b75e12382323";
  const rid = "2c2eea1e-15a6-4fca-8b0e-9963f5f777cd";
  let invId = "";

  test("create entry invoice → 201", async () => {
    const { status, data } = await api("/invoices", { method: "POST", body: JSON.stringify({
      type: "entry", date: "2026-08-12", partyId: sid, partyType: "supplier",
      currency: "SYP", lines: [{ fabricId: fid, colorId: cid, rollId: rid, quantityKg: 5, pricePerKg: 2000 }],
    })});
    expect(status).toBe(201);
    expect(data.number).toMatch(/^INV-/);
    invId = data.id;
  });

  test("fetch entry invoice → 200", async () => {
    const { status, data } = await api(`/invoices/${invId}`);
    expect(status).toBe(200);
    expect(data.type).toBe("entry");
  });

  test("cancel entry invoice → 200", async () => {
    const { status } = await api(`/invoices/${invId}/cancel`, { method: "POST" });
    expect(status).toBe(200);
  });

  test("reject negative qty → 422", async () => {
    const { status } = await api("/invoices", { method: "POST", body: JSON.stringify({
      type: "entry", date: "2026-08-12", partyId: sid, partyType: "supplier",
      currency: "SYP", lines: [{ fabricId: fid, colorId: cid, rollId: rid, quantityKg: -5, pricePerKg: 100 }],
    })});
    expect(status).toBe(422);
test.describe("فاتورة بيع", () => {
  const cid = "5b9f06a8-5e18-4c5a-b372-7eee0e23ea76";
  const fid = "847ac9b2-5dff-4f92-b1f7-67829eb7fab8";
  const col = "1cb948a2-55c9-456d-873f-b75e12382323";
  const rid = "2c2eea1e-15a6-4fca-8b0e-9963f5f777cd";
  let stock = 0, invId = "";

  test("snapshot stock before sale", async () => {
    const { data } = await api("/inventory/rolls?limit=200");
    const r = data.data.find((x: any) => x.id === rid);
    stock = r?.remainingKg ?? 0;
    expect(stock).toBeGreaterThan(0);
  });

  test("create sale invoice → 201 + stock deducted", async () => {
    const { status, data } = await api("/invoices", { method: "POST", body: JSON.stringify({
      type: "sale", date: "2026-08-12", partyId: cid, partyType: "customer",
      currency: "SYP", lines: [{ fabricId: fid, colorId: col, rollId: rid, quantityKg: 3, pricePerKg: 5000 }],
    })});
    expect(status).toBe(201);
    expect(data.total).toBe(15000);
    invId = data.id;
    const { data: d2 } = await api("/inventory/rolls?limit=200");
    const roll = d2.data.find((x: any) => x.id === rid);
    expect(roll.remainingKg).toBe(stock - 3);
  });

  test("cancel sale → stock restored", async () => {
    await api(`/invoices/${invId}/cancel`, { method: "POST" });
    const { data } = await api("/inventory/rolls?limit=200");
    const roll = data.data.find((x: any) => x.id === rid);
    expect(roll.remainingKg).toBe(stock);
  });

  test("reject insufficient stock → 422", async () => {
    const { status } = await api("/invoices", { method: "POST", body: JSON.stringify({
      type: "sale", date: "2026-08-12", partyId: cid, partyType: "customer",
      currency: "SYP", lines: [{ fabricId: fid, colorId: col, rollId: rid, quantityKg: 99999, pricePerKg: 1 }],
    })});
    expect(status).toBe(422);
  });
});

test.describe("سجل المرتجعات", () => {
  test("list returns with pagination", async () => {
    const { status, data } = await api("/returns?limit=5");
    expect(status).toBe(200);
    expect(data.meta).toBeDefined();
    expect(data.data.length).toBeLessThanOrEqual(5);
  });
  test("filter by kind=entry", async () => {
    const { data } = await api("/returns?kind=entry&limit=5");
    for (const r of data.data) expect(r.kind).toBe("entry");
  });
  test("filter by kind=sale", async () => {
    const { data } = await api("/returns?kind=sale&limit=5");
    for (const r of data.data) expect(r.kind).toBe("sale");
  });
  test("max limit=1000 accepted", async () => {
    const { status } = await api("/returns?limit=1000");
    expect(status).toBe(200);
  });
});

test.describe("تتبع الفواتير", () => {
  test("list invoices", async () => {
    const { status, data } = await api("/invoices?limit=5");
    expect(status).toBe(200);
    expect(data.meta.total).toBeGreaterThanOrEqual(0);
  });
  test("filter active sales", async () => {
    const { data } = await api("/invoices?type=sale&status=active&limit=5");
    for (const inv of data.data) {
      expect(inv.type).toBe("sale");
      expect(inv.status).toBe("active");
    }
  });
  test("invalid UUID → 400", async () => {
    const { status } = await api("/invoices/invalid-uuid");
    expect(status).toBe(400);
  });
  test("not-found UUID → 404", async () => {
    const { status } = await api("/invoices/00000000-0000-0000-0000-000000000000");
    expect(status).toBe(404);
  });
});

test.describe("Frontend smoke", () => {
  test("/invoices/entry/new loads", async ({ page }) => {
    await page.goto("http://localhost:8081/invoices/entry/new");
    await page.waitForTimeout(2000);
    await expect(page.locator("body")).not.toContainText("404");
  });
  test("/invoices/sale/new loads", async ({ page }) => {
    await page.goto("http://localhost:8081/invoices/sale/new");
    await page.waitForTimeout(2000);
    await expect(page.locator("body")).not.toContainText("404");
  });
  test("/returns loads", async ({ page }) => {
    await page.goto("http://localhost:8081/returns");
    await page.waitForTimeout(2000);
    await expect(page.locator("body")).not.toContainText("404");
  });
  test("/invoices/tracking loads", async ({ page }) => {
    await page.goto("http://localhost:8081/invoices/tracking");
    await page.waitForTimeout(2000);
    await expect(page.locator("body")).not.toContainText("404");
  });
});
  });
});