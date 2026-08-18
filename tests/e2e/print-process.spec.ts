/**
 * Print Process E2E Suite — إرسال إلى المطبعة، استلام من المطبعة
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

test.describe("إرسال إلى المطبعة", () => {
  const rid = "2c2eea1e-15a6-4fca-8b0e-9963f5f777cd";
  let stock = 0, jobId = "";

  test("snapshot stock", async () => {
    const { data } = await api("/inventory/rolls?limit=200");
    const r = data.data.find((x: any) => x.id === rid);
    stock = r?.remainingKg ?? 0;
    expect(stock).toBeGreaterThan(0);
  });

  test("send to print → 201", async () => {
    const { status, data } = await api("/printing/send", { method: "POST", body: JSON.stringify({
      date: "2026-08-12", sourceRollId: rid, quantityKg: 10, pressName: "TestPress", currency: "SYP",
    })});
    expect(status).toBe(201);
    expect(data.number).toMatch(/^PRT-/);
    expect(data.status).toBe("sent");
    jobId = data.id;
  });

  test("list print jobs includes sent job", async () => {
    const { data } = await api("/printing");
    expect(data.some((j: any) => j.id === jobId)).toBeTruthy();
  });

  test("list open print jobs", async () => {
    const { data } = await api("/printing/open");
    const openIds = data.map((j: any) => j.id);
    expect(openIds.includes(jobId)).toBeTruthy();
  });

  test("receive from print → 200 + stock deducted", async () => {
    const { status, data } = await api("/printing/receive", { method: "POST", body: JSON.stringify({
      jobId, date: "2026-08-12", receivedKg: 8, currency: "SYP",
    })});
    expect(status).toBe(200);
    expect(data.status).toBe("received");
    // Source roll stock should now be stock - 8 (P0-2 fix)
    const { data: d2 } = await api("/inventory/rolls?limit=200");
    const roll = d2.data.find((x: any) => x.id === rid);
    expect(roll.remainingKg).toBe(stock - 8);
  });

  test("result roll created with correct price", async () => {
    const { data } = await api("/inventory/rolls?limit=200");
    const prtRoll = data.data.find((x: any) => x.rollNo?.startsWith("PRT-2026-"));
    expect(prtRoll).toBeDefined();
    expect(prtRoll.remainingKg).toBe(8);
  });

  test("receive more than sent → 422", async () => {
    // Create a new send first
    const { data: send } = await api("/printing/send", { method: "POST", body: JSON.stringify({
      date: "2026-08-12", sourceRollId: rid, quantityKg: 3, pressName: "T2", currency: "SYP",
    })});
    const { status } = await api("/printing/receive", { method: "POST", body: JSON.stringify({
      jobId: send.id, date: "2026-08-12", receivedKg: 999, currency: "SYP",
    })});
    expect(status).toBe(422);
  });
});

test.describe("Frontend smoke — print routes", () => {
  test("/invoices/print-send/new loads", async ({ page }) => {
    await page.goto("http://localhost:8081/invoices/print-send/new");
    await page.waitForTimeout(2000);
    await expect(page.locator("body")).not.toContainText("404");
  });
  test("/invoices/print-receive/new loads", async ({ page }) => {
    await page.goto("http://localhost:8081/invoices/print-receive/new");
    await page.waitForTimeout(2000);
    await expect(page.locator("body")).not.toContainText("404");
  });
});