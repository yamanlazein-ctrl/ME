import { describe, test } from "@e2e-dev/web";
import { expect } from "e2e";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";

// The operator's sales day in the real UI, on the isolated stack (e2e.config.ts):
// customer → sale invoice with a partial cash payment → receipt for part of the rest → statement.
// Stock (fabric, colour, roll) is set up through the API: buying it is a different journey.
//
// Customer and receipt fields are found by their accessible label (getByLabel). The sale-invoice
// totals (e.g. المدفوع) still have no accessible name, so that one is located by its visible label
// text with XPath until the invoice form's labels are tied too.
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

/** The input that follows a visible label text inside the open dialog / page. */
const fieldAfter = (label: string) =>
  `xpath=//*[normalize-space(text())='${label}']/following::input[1]`;

describe("sales journey", () => {
  test("customer → invoice with partial payment → receipt → statement", async ({
    app,
    browser,
    screen,
  }) => {
    const s = await apiLogin();
    const run = Date.now().toString(36);
    const fabricId = idOf(await api(s, "POST", "/inventory/fabrics", { name: `قطن ${run}` }));
    const colorId = idOf(
      await api(s, "POST", "/inventory/colors", {
        fabricId,
        name: `أبيض ${run}`,
        code: `W-${run}`,
      }),
    );
    await api(s, "POST", "/inventory/rolls", {
      colorId,
      rollNo: `R-${run}`,
      initialKg: 50,
      pieces: 2,
      pricePerKg: 4,
      currency: "USD",
      entryDate: "2026-10-01",
    });

    await browser.addInitScript(
      ([access, refresh, tenant]) => {
        localStorage.setItem("erp.auth.accessToken", access);
        localStorage.setItem("erp.auth.refreshToken", refresh);
        localStorage.setItem("erp.install.tenantId", tenant);
      },
      [s.access, s.refresh, s.tenantId],
    );

    // 1. Create the customer in the UI.
    const customer = `عميل ${run}`;
    await app.open("/customers");
    await screen.getByText("إضافة عميل", { exact: false }).first().tap();
    const dialog = screen.getByRole("dialog", "إضافة عميل جديد");
    await expect(dialog).toBeVisible();
    await dialog.getByLabel("اسم العميل *").fill(customer);
    await dialog.getByRole("button", "حفظ").tap();
    await expect(dialog).toBeHidden({ timeout: 10_000 });
    await expect(screen.getByText(customer).first()).toBeVisible({ timeout: 10_000 });

    // 2. Sale invoice in USD: 10 kg × $10 = $100, of which $40 paid in cash now.
    await app.open("/invoices/sale/new");
    await screen.getByRole("button", "ابحث عن عميل...").tap();
    await screen.getByRole("textbox", "ابحث عن عميل بالاسم أو الرمز...").fill(customer);
    await screen
      .getByRole("dialog")
      .getByRole("button")
      .filter({ hasText: customer })
      .first()
      .tap();

    await screen.getByRole("combobox").filter({ hasText: "اختر العملة" }).tap();
    await screen.getByRole("option", "$ USD").tap();
    await screen.getByRole("textbox", "سعر الصرف").fill("14000");

    const line = screen.getByRole("article").first();
    await line.getByRole("textbox", "القماش").pressSequentially(`قطن ${run}`);
    await line.getByRole("button", `قطن ${run}`).tap();
    await line.getByRole("textbox", "اسم اللون").pressSequentially(`أبيض ${run}`);
    await line
      .getByRole("button")
      .filter({ hasText: `أبيض ${run}` })
      .first()
      .tap();
    await line.getByRole("combobox").first().tap();
    await screen
      .getByRole("option")
      .filter({ hasText: `R-${run}` })
      .first()
      .tap();
    await line.getByRole("textbox", "الكمية").fill("10");
    await line.getByRole("textbox", "سعر الوحدة").fill("10");
    await browser.locator(fieldAfter("المدفوع")).fill("40");
    await screen.getByRole("button", "حفظ الفاتورة").tap();
    // A partial payment asks to book the rest as customer debt — and states the exact rest.
    const debt = screen.getByRole("alertdialog", "تسجيل المتبقي كدين؟");
    await expect(debt).toContainText("60 $");
    await debt.getByRole("button", "نعم، سجّل كدين وأتمم الفاتورة").tap();

    // Persisted, not just shown: the server holds one active invoice of 100 with 40 paid.
    const party = await api<{ data: Array<{ id: string; name: string }> }>(
      s,
      "GET",
      `/parties?kind=customer&search=${encodeURIComponent(customer)}`,
    );
    const partyId = party.data.find((p) => p.name === customer)?.id ?? "";
    expect(partyId).not.toBe("");
    await expect
      .poll(
        async () => {
          const inv = await api<{ data: Array<{ total: number; paid: number; status: string }> }>(
            s,
            "GET",
            `/invoices?partyId=${partyId}`,
          );
          return inv.data
            .filter((i) => i.status === "active")
            .map((i) => [Number(i.total), Number(i.paid)]);
        },
        { timeout: 10_000 },
      )
      .toEqual([[100, 40]]);

    // 3. Receipt of $25 against that invoice: the form offers it with its exact $60 rest.
    await app.open("/receipts/new");
    await screen.getByRole("button", "اختر العميل").tap();
    await screen.getByRole("textbox", "ابحث عن عميل بالاسم أو الرمز...").fill(customer);
    await screen
      .getByRole("dialog")
      .getByRole("button")
      .filter({ hasText: customer })
      .first()
      .tap();
    await screen.getByLabel("الفاتورة المرتبطة (اختياري)").tap();
    const invoiceOption = screen.getByRole("option").filter({ hasText: "INV-" });
    await expect(invoiceOption).toContainText("60");
    await invoiceOption.tap();
    await screen.getByLabel("العملة").tap();
    await screen.getByRole("option", "دولار أمريكي").tap();
    // USD is the base currency: the form drops the rate field for a USD receipt.
    if (await screen.getByRole("textbox", "سعر الصرف").isVisible()) {
      await screen.getByRole("textbox", "سعر الصرف").fill("14000");
    }
    await screen.getByRole("textbox", "المبلغ الفعلي").fill("25");
    await screen.getByRole("button", "حفظ السند").tap();

    await expect
      .poll(
        async () => {
          const inv = await api<{ data: Array<{ paid: number; status: string }> }>(
            s,
            "GET",
            `/invoices?partyId=${partyId}`,
          );
          return inv.data.filter((i) => i.status === "active").map((i) => Number(i.paid));
        },
        { timeout: 10_000 },
      )
      .toEqual([65]);
    // The statement the operator prints must say the customer owes exactly $35.
    const stmt = await api<{ data?: { finalBalance: number }; finalBalance?: number }>(
      s,
      "GET",
      `/customers/${partyId}/statement?currency=USD`,
    );
    expect(
      Number(stmt.data?.finalBalance ?? stmt.finalBalance),
      JSON.stringify(stmt).slice(0, 400),
    ).toBe(35);

    // 4. The statement screen the operator prints shows the same: $35 owed, totals 100 / 65.
    await app.open(`/customers/${partyId}`);
    await screen.getByRole("button", "كشف حساب").tap();
    const main = screen.getByRole("main");
    await expect(main).toContainText("35 مدين", { timeout: 10_000 });
    await expect(main).toContainText("المسحوبات 100 · المقبوضات 65");
    // The invoice comes before the $40 receipt booked with it (same transaction, same timestamp):
    // row 1 is the sale, so the running balance never shows a false credit.
    const dataRows = main.getByRole("table").getByRole("row");
    await expect(dataRows.nth(1)).toContainText("فاتورة بيع");
    await expect(dataRows.nth(2)).toContainText("سند قبض");
  });
});
