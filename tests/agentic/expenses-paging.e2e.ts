import { describe, test } from "@e2e-dev/web";
import { expect } from "e2e";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";

// Same isolated stack as e2e.config.ts. Login goes through the real API (the UI's sign-in screen is
// the PIN user picker), and the session is handed to the page exactly as the app stores it.
const BACKEND = `http://localhost:${process.env.CERT_BACKEND_PORT ?? "18080"}`;
const stack = () =>
  JSON.parse(readFileSync("tests/e2e/.cert-stack.json", "utf8")) as { tenantId: string; email: string };

async function apiLogin() {
  const { tenantId, email } = stack();
  const res = await fetch(`${BACKEND}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password: process.env.E2E_ADMIN_PASSWORD ?? "", tenantId }),
  });
  expect(res.status, "admin login").toBe(200);
  const body = (await res.json()) as { accessToken: string; refreshToken?: string };
  return { tenantId, access: body.accessToken, refresh: body.refreshToken ?? "" };
}

type Session = Awaited<ReturnType<typeof apiLogin>>;

// Financial writes must carry an Idempotency-Key (the API answers 428 without one), one per request.
const api = (s: Session, path: string, init: RequestInit = {}) =>
  fetch(`${BACKEND}/api${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${s.access}`,
      ...(init.method && init.method !== "GET" ? { "Idempotency-Key": randomUUID() } : {}),
      ...init.headers,
    },
  });

describe("expenses list", () => {
  test("an admin session opens the dashboard", async ({ app, browser, screen }) => {
    const s = await apiLogin();
    await browser.addInitScript(
      ([access, refresh, tenant]) => {
        localStorage.setItem("erp.auth.accessToken", access);
        localStorage.setItem("erp.auth.refreshToken", refresh);
        localStorage.setItem("erp.install.tenantId", tenant);
      },
      [s.access, s.refresh, s.tenantId],
    );
    await app.open("/");
    await expect(screen.getByText("لوحة التحكم", { exact: false }).first()).toBeVisible({ timeout: 30_000 });
  });

  // FE-03 regression: the screen used to fetch one 20-row page and show the truncated length as the
  // total. It must show the server's total and page through every row.
  test("more than 20 expenses: true total and a second page", async ({ app, browser, screen }) => {
    const s = await apiLogin();
    const tag = `E2E-${Date.now()}`;
    const today = new Date().toISOString().slice(0, 10);
    for (let i = 1; i <= 21; i++) {
      const r = await api(s, "/expenses", {
        method: "POST",
        body: JSON.stringify({
          category: "e2e",
          description: `${tag} #${i}`,
          amount: 1,
          currency: "USD",
          date: today,
          method: "transfer",
          paidFromCashbox: false,
        }),
      });
      expect(r.status, `create expense ${i}: ${r.status === 201 ? "" : await r.text()}`).toBeLessThan(300);
    }
    const list = await (await api(s, "/expenses?limit=1")).json();
    const total = Number((list as { meta: { total: number } }).meta.total);
    expect(total).toBeGreaterThanOrEqual(21);

    await browser.addInitScript(
      ([access, refresh, tenant]) => {
        localStorage.setItem("erp.auth.accessToken", access);
        localStorage.setItem("erp.auth.refreshToken", refresh);
        localStorage.setItem("erp.install.tenantId", tenant);
      },
      [s.access, s.refresh, s.tenantId],
    );
    await app.open("/expenses");

    // The header counts what the server holds, not the rows on screen.
    await expect(screen.getByText(`${total} مصروف.`)).toBeVisible({ timeout: 30_000 });
    await expect(screen.getByText(`إجمالي المصاريف: ${total}`, { exact: false })).toBeVisible();

    const ourRows = () => screen.getByRole("row").filter({ hasText: tag });
    const firstPage = await ourRows().count();
    expect(firstPage).toBeGreaterThan(0);
    expect(firstPage).toBeLessThanOrEqual(20);

    await screen.getByRole("button", "التالي").tap();
    // The rest of ours are on the next page(s); with a fresh stack exactly 21 = 20 + 1.
    await expect(ourRows().first()).toBeVisible();
    if (total === 21) await expect(ourRows()).toHaveCount(1);
  });
});
