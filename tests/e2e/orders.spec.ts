/**
 * Orders E2E Suite — طلبات العملاء وتحويلها
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

test.describe("طلبات العملاء", () => {
  let orderId = "";

  test("create order → 201", async () => {
    const { status, data } = await api("/orders", { method: "POST", body: JSON.stringify({
      customerNameSnapshot: "زبون اختبار", date: "2026-08-12", currency: "SYP",
      items: [{ fabricName: "جاكار", colorName: "أحمر", requestedKg: 15 }],
    })});
    expect(status).toBe(201);
    expect(data.code).toMatch(/^ORD-/);
    expect(data.status).toBe("open");
    orderId = data.id;
  });

  test("list orders includes new order", async () => {
    const { data } = await api("/orders?limit=5");
    const ids = data.data.map((o: any) => o.id);
    expect(ids.includes(orderId)).toBeTruthy();
  });

  test("fetch order by code", async () => {
    const { data: list } = await api("/orders?limit=5");
    const code = list.data.find((o: any) => o.id === orderId)?.code;
    const { status, data } = await api(`/orders/by-code?code=${code}`);
    expect(status).toBe(200);
    expect(data.id).toBe(orderId);
  });

  test("update order notes → 200", async () => {
    const { status } = await api(`/orders/${orderId}`, {
      method: "PUT", body: JSON.stringify({ notes: "ملاحظة اختبار" }),
    });
    expect(status).toBe(200);
  });

  test("cancel order → 200", async () => {
    const { status, data } = await api(`/orders/${orderId}/cancel`, { method: "POST" });
    expect(status).toBe(200);
    expect(data.status).toBe("cancelled");
  });

  test("cancel already-cancelled → 422", async () => {
    const { status } = await api(`/orders/${orderId}/cancel`, { method: "POST" });
    expect(status).toBe(422);
  });

  test("fulfill without invoiceId → 400", async () => {
    // create a new order
    const { data: ord } = await api("/orders", { method: "POST", body: JSON.stringify({
      customerNameSnapshot: "اختبار fulfill", date: "2026-08-12", currency: "SYP",
      items: [{ fabricName: "قطن", colorName: "أبيض", requestedKg: 5 }],
    })});
    const { status } = await api(`/orders/${ord.id}/fulfill`, {
      method: "POST", body: JSON.stringify({}),
    });
    expect(status).toBe(400);
    // cleanup
    await api(`/orders/${ord.id}/cancel`, { method: "POST" });
  });
});

test.describe("Frontend smoke — orders routes", () => {
  test("/orders loads", async ({ page }) => {
    await page.goto("http://localhost:8081/orders");
    await page.waitForTimeout(2000);
    await expect(page.locator("body")).not.toContainText("404");
  });
  test("/orders/new loads", async ({ page }) => {
    await page.goto("http://localhost:8081/orders/new");
    await page.waitForTimeout(2000);
    await expect(page.locator("body")).not.toContainText("404");
  });
});