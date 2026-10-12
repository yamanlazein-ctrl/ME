import { describe, test } from "@e2e-dev/web";
import { expect } from "e2e";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";

// Stock count in the real UI on the isolated stack (e2e.config.ts): a 50 kg roll counted at 48 kg,
// reviewed and posted — the roll must end at 48 kg on the server.
const BACKEND = `http://localhost:${process.env.CERT_BACKEND_PORT ?? "18080"}`;
const stack = () =>
  JSON.parse(readFileSync("tests/e2e/.cert-stack.json", "utf8")) as {
    tenantId: string;
    email: string;
  };

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

async function api<T>(s: Session, method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${BACKEND}/api${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${s.access}`,
      ...(method !== "GET" ? { "Idempotency-Key": randomUUID() } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  expect(res.status, `${method} ${path}: ${text.slice(0, 300)}`).toBeLessThan(300);
  return (text ? JSON.parse(text) : {}) as T;
}
const idOf = (r: unknown) => ((r as { data?: { id: string } }).data ?? (r as { id: string })).id;

describe("inventory count", () => {
  test("a roll counted short is posted and the stock follows", async ({ app, browser, screen }) => {
    const s = await apiLogin();
    const run = Date.now().toString(36);
    const fabricId = idOf(await api(s, "POST", "/inventory/fabrics", { name: `جرد ${run}` }));
    const colorId = idOf(
      await api(s, "POST", "/inventory/colors", {
        fabricId,
        name: `أزرق ${run}`,
        code: `B-${run}`,
      }),
    );
    const rollNo = `CNT-${run}`;
    const rollId = idOf(
      await api(s, "POST", "/inventory/rolls", {
        colorId,
        rollNo,
        initialKg: 50,
        pieces: 2,
        pricePerKg: 4,
        currency: "USD",
        entryDate: "2026-10-01",
      }),
    );

    await browser.addInitScript(
      ([access, refresh, tenant]) => {
        localStorage.setItem("erp.auth.accessToken", access);
        localStorage.setItem("erp.auth.refreshToken", refresh);
        localStorage.setItem("erp.install.tenantId", tenant);
      },
      [s.access, s.refresh, s.tenantId],
    );

    await app.open("/inventory/count");
    const row = screen.getByRole("row").filter({ hasText: rollNo });
    await expect(row).toBeVisible({ timeout: 10_000 });
    // The operator types the search and, while it is still being applied (debounced), already types
    // the count into the row on screen. The filtered list then arrives — the typed count must survive
    // it (it used to be thrown away unsaved: the table unmounted for the fetch).
    const filtered = browser.waitForResponse(new RegExp(`count-sheet\\?.*q=${rollNo}`));
    await screen.getByRole("textbox", "القماش، اللون، رقم الصبغة أو الدفعة").fill(rollNo);
    await row.getByPlaceholder("غير معدود").fill("48");
    await filtered;
    await expect(row.getByPlaceholder("غير معدود")).toHaveValue("48");
    await row.getByPlaceholder("غير معدود").press("Enter");
    await expect(screen.getByRole("main")).toContainText("عجز 2 كغ");

    await screen.getByRole("button", "مراجعة وترحيل الفروقات").tap();
    const review = screen.getByRole("dialog");
    await expect(review).toContainText(rollNo);
    await review.getByRole("button").filter({ hasText: "ترحيل" }).last().tap();

    await expect
      .poll(
        async () => {
          const r = await api<{ data?: { remainingKg: number }; remainingKg?: number }>(
            s,
            "GET",
            `/inventory/rolls/${rollId}`,
          );
          return Number(r.data?.remainingKg ?? r.remainingKg);
        },
        { timeout: 10_000 },
      )
      .toBe(48);
  });
});
