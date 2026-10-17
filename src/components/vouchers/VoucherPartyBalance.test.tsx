import { resolve } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { chromium, expect as browserExpect, type Browser, type Page } from "@playwright/test";
import type { CreateVoucherInput } from "@/core/dtos/VoucherDTO";
import type { Currency, VoucherKind } from "@/domain/types";

/* Same isolated Vite/Chromium pattern as invoiceWeightRecalculation.test.tsx.
 * Only the infrastructure container and router navigation are substituted:
 * VoucherForm, PartyCombobox, balance/mutation hooks and invalidation are real.
 * No server, disk fixture, customer profile, database or API network is used.
 */
const containerFixture = `
const balances = Object.fromEntries(["customer", "supplier"].flatMap(kind => [
  [kind + "-opening", { USD: 100000, SYP: 0, EUR: 30000 }],
  [kind + "-second", { USD: 45000, SYP: 0, EUR: 30000 }],
]));
// Each party carries the per-currency stats the real party list returns, so the form's currency
// choice reads the real store exactly as in production.
const statsOf = id => ({ byCurrency: Object.fromEntries(Object.entries(balances[id]).map(([c, v]) => [c, { remaining: v }])) });
const parties = ["customer", "supplier"].flatMap(kind => [
  { id: kind + "-opening", kind, name: kind + " opening only", status: "active", currency: "SYP", stats: statsOf(kind + "-opening") },
  { id: kind + "-second", kind, name: kind + " second party", status: "active", currency: "SYP", stats: statsOf(kind + "-second") },
]);
const held = new Set();
const pending = new Map();
const calls = [];
const saved = [];
const navigations = [];
const invoiceFilters = [];
let cash = 200000;
const empty = () => ({ data: [], total: 0, hasNext: false });
const key = (id, currency) => id + ":" + currency;
const money = (id, currency) => ({ amount: balances[id][currency], currency });
const balance = async (id, currency) => {
  const k = key(id, currency);
  calls.push(k);
  if (held.has(k)) return new Promise((resolve, reject) => pending.set(k, { resolve, reject }));
  return money(id, currency);
};
const create = async input => {
  saved.push(input);
  balances[input.partyId][input.currency] -= input.amount + (input.discount || 0);
  if (input.method === "cash") cash += input.kind === "receipt" ? input.amount : -input.amount;
  return { ok: true, value: { ...input, id: "created-voucher", status: "active" } };
};
export const control = {
  calls, saved, navigations, invoiceFilters,
  setBalance(id, currency, amount) { balances[id][currency] = amount; },
  hold(id, currency) { held.add(key(id, currency)); },
  release(id, currency, fail = false) {
    const k = key(id, currency);
    held.delete(k);
    const request = pending.get(k);
    if (!request) throw new Error("No pending balance request: " + k);
    pending.delete(k);
    if (fail) request.reject(new Error("Ledger unavailable"));
    else request.resolve(money(id, currency));
  },
};
export const container = {
  http: { get: async (path, { params }) => {
    if (path === "/api/parties/search") return { data: { data: parties.filter(p => p.kind === params.kind) } };
    if (path === "/api/parties/by-ids") return { data: { data: parties.filter(p => p.id === params.ids) } };
    throw new Error("Unexpected fixture HTTP call: " + path);
  } },
  parties: {
    balance: { execute: balance },
    list: { execute: async filter => ({ ...empty(), data: filter.status === "cancelled" ? [] : parties.filter(p => p.kind === filter.kind) }) },
  },
  invoices: { list: { execute: async filter => { invoiceFilters.push(filter); return { ok: true, value: empty() }; } } },
  returns: { list: { execute: async () => empty() } },
  cashbox: { state: { cashBalanceOn: async () => cash } },
  fx: { api: { getReferenceRate: async () => ({ available: false }) } },
  vouchers: {
    createReceipt: { execute: create }, createPayment: { execute: create },
    repository: { findById: async () => ({
      id: "amend", kind: document.getElementById("root").dataset.kind,
      partyId: document.getElementById("root").dataset.kind === "receipt" ? "customer-opening" : "supplier-opening",
      number: "V-OLD", status: "active", amount: 25000, discount: 5000,
      currency: "USD", method: "cash", date: "2026-10-15", version: 1,
    }) },
  },
};
`;

const browserFixture = `
import React from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { VoucherForm } from "@/components/vouchers/VoucherForm";
import { invalidateFinancialViews } from "@/presentation/hooks/invalidateFinancialViews";
import { control } from "virtual:voucher-container";
const element = document.getElementById("root");
// Infinity proves the component's staleTime: 0 overrides application defaults.
const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity, gcTime: Infinity } } });
const root = createRoot(element);
let generation = 0;
function render() {
  root.render(<QueryClientProvider client={client}>
    <VoucherForm key={generation} kind={element.dataset.kind} editId={element.dataset.edit || undefined} />
  </QueryClientProvider>);
}
window.voucherFixture = {
  ...control,
  invalidate: () => invalidateFinancialViews(client),
  remount: () => { generation++; render(); },
};
if (element.dataset.hold) control.hold(element.dataset.kind === "receipt" ? "customer-opening" : "supplier-opening", "USD");
render();
`;

type FixtureControl = {
  calls: string[];
  saved: CreateVoucherInput[];
  navigations: Array<{ to: string }>;
  invoiceFilters: Array<{ partyId?: string }>;
  setBalance: (id: string, currency: Currency, amount: number) => void;
  hold: (id: string, currency: Currency) => void;
  release: (id: string, currency: Currency, fail?: boolean) => void;
  invalidate: () => void;
  remount: () => void;
};

declare global {
  interface Window {
    voucherFixture: FixtureControl;
  }
}

describe("VoucherPartyBalance through the real VoucherForm", { timeout: 12_000 }, () => {
  let browser: Browser;
  let page: Page;
  let fixtureCode: string;
  let errors: string[];
  let requests: string[];
  const fixtureUrl = "https://voucher-fixture.invalid/";

  beforeAll(async () => {
    const { build } = await import("vite");
    const { default: react } = await import("@vitejs/plugin-react");
    const modules: Record<string, string> = {
      "virtual:voucher-form-fixture.tsx": browserFixture,
      "virtual:voucher-container": containerFixture,
      "virtual:voucher-navigation": `import { control } from "virtual:voucher-container";
        export const useNavigate = () => destination => control.navigations.push(destination);`,
    };
    const result = await build({
      configFile: false,
      envFile: false,
      logLevel: "error",
      plugins: [
        {
          name: "voucher-party-balance-fixture",
          enforce: "pre",
          resolveId(id) {
            if (
              id === "@/infrastructure/container" ||
              /\/src\/infrastructure\/container(?:\.ts)?$/.test(id.replaceAll("\\", "/"))
            )
              return "\0virtual:voucher-container";
            if (id === "@tanstack/react-router") return "\0virtual:voucher-navigation";
            if (id in modules) return "\0" + id;
          },
          load: (id) => (id.startsWith("\0") ? modules[id.slice(1)] : undefined),
        },
        react(),
      ],
      resolve: {
        alias: {
          "@": resolve(process.cwd(), "src"),
          "@erp/shared": resolve(process.cwd(), "packages/shared/src/index.ts"),
        },
      },
      define: { "process.env.NODE_ENV": JSON.stringify("test") },
      build: {
        write: false,
        minify: false,
        rolldownOptions: {
          input: "virtual:voucher-form-fixture.tsx",
          output: { format: "iife", name: "VoucherFixture" },
        },
      },
    });
    if (!("output" in result)) throw new Error("Expected an in-memory fixture build");
    const chunk = result.output.find((output) => output.type === "chunk");
    if (!chunk || chunk.type !== "chunk") throw new Error("Missing voucher fixture chunk");
    fixtureCode = chunk.code;
    browser = await chromium.launch({ headless: true });
  }, 60_000);

  afterEach(async () => {
    await page?.close();
    expect(errors ?? []).toEqual([]);
    expect(requests ?? []).toEqual([fixtureUrl]);
  });

  afterAll(async () => {
    await browser?.close();
  });

  async function mount(
    kind: VoucherKind = "receipt",
    options: { hold?: boolean; edit?: boolean } = {},
  ) {
    errors = [];
    requests = [];
    page = await browser.newPage();
    page.setDefaultTimeout(3000);
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("request", (request) => requests.push(request.url()));
    // A fulfilled, synthetic origin gives the real auth-context access to empty
    // localStorage (about:blank denies it). This never reaches DNS or a server.
    await page.route("**/*", (route) =>
      route.request().url() === fixtureUrl && route.request().isNavigationRequest()
        ? route.fulfill({
            contentType: "text/html",
            body: `<div id="root" data-kind="${kind}" data-hold="${options.hold ? "yes" : ""}" data-edit="${options.edit ? "amend" : ""}"></div>`,
          })
        : route.abort(),
    );
    await page.goto(fixtureUrl);
    await page.addScriptTag({ content: fixtureCode });
    await browserExpect(page.getByRole("button", { name: "حفظ السند", exact: true })).toBeVisible();
  }

  async function selectParty(kind: VoucherKind, second = false) {
    const entity = kind === "receipt" ? "customer" : "supplier";
    const trigger = page.getByRole("button", {
      name: kind === "receipt" ? "اختر العميل" : "اختر المورد",
      exact: true,
    });
    if (await trigger.count()) await trigger.click();
    else await page.getByRole("button", { name: `${entity} opening only`, exact: true }).click();
    await page
      .getByRole("button", {
        name: `${entity} ${second ? "second party" : "opening only"}`,
        exact: true,
      })
      .click();
  }

  async function fillAmount(label: string, value: number) {
    const input = page.getByRole("textbox", { name: label, exact: true });
    await input.focus();
    await input.fill(String(value));
    await input.blur();
  }

  async function current(currency: Currency, amount: string, direction?: string) {
    const locator = page.getByTestId(`party-current-${currency}`);
    await browserExpect(locator).toContainText(amount);
    if (direction) await browserExpect(locator).toContainText(direction);
    await browserExpect(page.getByTestId(`party-balance-${currency}`)).toHaveAttribute(
      "aria-busy",
      "false",
    );
  }

  /** Make `currency` the voucher currency. Idempotent: the form may already open in it. */
  async function useCurrency(currency: Currency) {
    const row = page.getByTestId(`party-balance-${currency}`);
    if (!(await row.getByText("عملة السند", { exact: true }).count())) {
      await page.getByRole("button", { name: `استخدم ${currency} للسند`, exact: true }).click();
    }
    await browserExpect(row).toContainText("عملة السند");
  }

  for (const kind of ["receipt", "payment"] as const) {
    it(`${kind}: selecting an opening-only party keeps USD 100,000 separate from default SYP, previews 80,000, and saves without an invoice`, async () => {
      await mount(kind);
      await browserExpect(page.getByTestId("party-balance-USD")).toHaveCount(0);
      expect(await page.evaluate(() => window.voucherFixture.calls)).toEqual([]);
      await selectParty(kind);
      await current("USD", "100,000", kind === "receipt" ? "لنا (مدين)" : "علينا (دائن)");
      await current("SYP", "0", "متوازن");
      await browserExpect(page.getByLabel("الفاتورة المرتبطة (اختياري)")).toContainText(
        "دفعة على الحساب",
      );
      // The voucher opens in the party's own balance currency (USD), not the SYP default.
      await browserExpect(page.getByLabel("العملة", { exact: true })).toContainText("دولار أمريكي");
      await useCurrency("SYP");
      await browserExpect(page.getByLabel("العملة", { exact: true })).toContainText("ليرة سورية");
      await fillAmount("المبلغ الفعلي", 20000);
      await fillAmount("سعر الصرف", 13500);
      // A SYP voucher and even an explicit FX rate must not reduce the USD opening.
      await current("USD", "100,000");
      await browserExpect(page.getByTestId("party-after-USD")).toHaveCount(0);
      await browserExpect(page.getByTestId("party-after-SYP")).toContainText("20,000");
      await useCurrency("USD");
      await browserExpect(page.getByLabel("العملة", { exact: true })).toContainText("دولار أمريكي");
      await browserExpect(page.getByTestId("party-after-USD")).toContainText("80,000");
      await browserExpect(page.getByTestId("party-after-SYP")).toHaveCount(0);
      const impact = page.getByTestId("voucher-cash-impact");
      await browserExpect(impact).toContainText(
        `${kind === "receipt" ? "+" : "−"} \u2066$\u2069 20,000`,
      );
      await browserExpect(impact).toContainText(kind === "receipt" ? "220,000" : "180,000");
      const partyId = `${kind === "receipt" ? "customer" : "supplier"}-opening`;
      const beforeCalls = await page.evaluate(() => window.voucherFixture.calls.length);
      await page.getByRole("button", { name: "حفظ السند", exact: true }).click();
      await expect.poll(() => page.evaluate(() => window.voucherFixture.saved.length)).toBe(1);
      const [payload] = await page.evaluate(() => window.voucherFixture.saved);
      expect(payload).toMatchObject({
        kind,
        partyId,
        currency: "USD",
        amount: 20000,
        method: "cash",
      });
      expect(payload.invoiceId).toBeUndefined();
      expect(payload.discount).toBeUndefined();
      // Real mutation onSuccess -> invalidateFinancialViews -> real usePartyBalance refetch.
      await current("USD", "80,000");
      await expect
        .poll(() => page.evaluate(() => window.voucherFixture.calls.length))
        .toBe(beforeCalls + 3);
      expect(await page.evaluate(() => window.voucherFixture.navigations)).toEqual([
        { to: kind === "receipt" ? "/receipts" : "/payments" },
      ]);
      expect(
        await page.evaluate(() =>
          window.voucherFixture.invoiceFilters.some((f) => Boolean(f.partyId)),
        ),
      ).toBe(true);
    });
  }

  it("switching USD/EUR/SYP moves only the selected currency's preview, never blends balances", async () => {
    await mount();
    await selectParty("receipt");
    await current("USD", "100,000");
    await current("EUR", "30,000");
    await fillAmount("المبلغ الفعلي", 20000);
    await useCurrency("USD");
    await browserExpect(page.getByTestId("party-after-USD")).toContainText("80,000");
    await useCurrency("EUR");
    await browserExpect(page.getByLabel("العملة", { exact: true })).toContainText("يورو");
    await browserExpect(page.getByTestId("party-after-EUR")).toContainText("10,000");
    await browserExpect(page.getByTestId("party-after-USD")).toHaveCount(0);
    await current("USD", "100,000");
    await useCurrency("SYP");
    await browserExpect(page.getByTestId("party-after-EUR")).toHaveCount(0);
    await current("EUR", "30,000");
    await browserExpect(page.getByTestId("party-after-SYP")).toContainText("20,000");
  });

  // The reported bug: selecting a party must show its balance right away, before any amount is typed.
  it.each(["receipt", "payment"] as const)(
    "%s: selecting a party shows its balance headline with amount and direction",
    async (kind) => {
      await mount(kind);
      await selectParty(kind);
      // The voucher opens in the currency the party holds (USD), so the badge shows the real balance.
      await browserExpect(page.getByTestId("party-balance-headline")).toBeVisible();
      await browserExpect(page.getByLabel("العملة", { exact: true })).toContainText("دولار");
      await browserExpect(page.getByTestId("party-balance-headline-amount")).toContainText(
        "100,000",
      );
      await browserExpect(page.getByTestId("party-balance-headline-amount")).toContainText(
        kind === "receipt" ? "لنا (مدين)" : "علينا (دائن)",
      );
      // The cashier can still choose another currency: SYP is 0, so the badge reads متوازن.
      await useCurrency("SYP");
      await browserExpect(page.getByTestId("party-balance-headline-amount")).toContainText(
        "متوازن",
      );
    },
  );

  it("switching parties shows loading rather than the old balance and ignores the old party's late response", async () => {
    await mount();
    await selectParty("receipt");
    await current("USD", "100,000");
    await useCurrency("USD");
    await fillAmount("المبلغ الفعلي", 20000);
    await page.evaluate(() => {
      window.voucherFixture.hold("customer-opening", "USD");
      window.voucherFixture.hold("customer-second", "USD");
      window.voucherFixture.invalidate();
    });
    await browserExpect(page.getByTestId("party-balance-USD")).toHaveAttribute("aria-busy", "true");
    await selectParty("receipt", true);
    const row = page.getByTestId("party-balance-USD");
    await browserExpect(row.getByRole("status")).toContainText("جاري تحميل الرصيد");
    await browserExpect(page.getByTestId("party-current-USD")).toHaveCount(0);
    await browserExpect(page.getByTestId("party-after-USD")).toHaveCount(0);
    await page.evaluate(() => window.voucherFixture.release("customer-opening", "USD"));
    await browserExpect(row.getByRole("status")).toContainText("جاري تحميل الرصيد");
    await page.evaluate(() => window.voucherFixture.release("customer-second", "USD"));
    await current("USD", "45,000");
    await browserExpect(page.getByTestId("party-after-USD")).toContainText("25,000");
    await browserExpect(row).not.toContainText("100,000");
  });

  it("loading and ledger errors never appear as zero; the real retry button recovers", async () => {
    await mount("receipt", { hold: true });
    await selectParty("receipt");
    await useCurrency("USD");
    await fillAmount("المبلغ الفعلي", 20000);
    const row = page.getByTestId("party-balance-USD");
    await browserExpect(row).toHaveAttribute("aria-busy", "true");
    await browserExpect(row.getByRole("status")).toContainText("جاري تحميل الرصيد");
    await browserExpect(page.getByTestId("party-current-USD")).toHaveCount(0);
    await browserExpect(page.getByTestId("party-after-USD")).toHaveCount(0);
    await page.evaluate(() => window.voucherFixture.release("customer-opening", "USD", true));
    await browserExpect(row.getByRole("alert")).toContainText("لا يُعتبر الرصيد صفراً");
    await browserExpect(page.getByTestId("party-current-USD")).toHaveCount(0);
    await browserExpect(page.getByTestId("party-after-USD")).toHaveCount(0);
    await row.getByRole("button", { name: "إعادة المحاولة", exact: true }).click();
    await current("USD", "100,000");
    await browserExpect(row.getByRole("alert")).toHaveCount(0);
    await browserExpect(page.getByTestId("party-after-USD")).toContainText("80,000");
  });

  it("financial invalidation refetches all currency ledgers and hides projections until fresh data arrives", async () => {
    await mount();
    await selectParty("receipt");
    await current("USD", "100,000");
    await useCurrency("USD");
    await fillAmount("المبلغ الفعلي", 20000);
    const callsBeforeInvalidation = await page.evaluate(() => window.voucherFixture.calls.length);
    await page.evaluate(() => {
      window.voucherFixture.hold("customer-opening", "USD");
      window.voucherFixture.setBalance("customer-opening", "USD", 90000);
      window.voucherFixture.setBalance("customer-opening", "EUR", 32000);
      window.voucherFixture.setBalance("customer-opening", "SYP", 1500);
      window.voucherFixture.invalidate();
    });
    const row = page.getByTestId("party-balance-USD");
    await browserExpect(row).toHaveAttribute("aria-busy", "true");
    await browserExpect(row.getByRole("status")).toContainText("جاري تحديث الرصيد");
    await browserExpect(page.getByTestId("party-current-USD")).toContainText("100,000");
    await browserExpect(page.getByTestId("party-after-USD")).toHaveCount(0);
    await current("EUR", "32,000");
    await current("SYP", "1,500");
    await page.evaluate(() => window.voucherFixture.release("customer-opening", "USD"));
    await current("USD", "90,000");
    await browserExpect(page.getByTestId("party-after-USD")).toContainText("70,000");
    // The selected-party headline and the per-currency rows both read these balances, so a key can be
    // requested more than once. The contract is which currencies are fetched after invalidation.
    const calls: string[] = await page.evaluate(() => window.voucherFixture.calls);
    const refetchedAfterInvalidation = new Set(calls.slice(callsBeforeInvalidation));
    expect(refetchedAfterInvalidation).toEqual(
      new Set(["customer-opening:SYP", "customer-opening:USD", "customer-opening:EUR"]),
    );
  });

  it("reselecting a cached party refetches immediately despite the client's infinite staleTime", async () => {
    await mount();
    await selectParty("receipt");
    await current("USD", "100,000");
    await page.evaluate(() => {
      window.voucherFixture.setBalance("customer-opening", "USD", 90000);
      window.voucherFixture.remount();
    });
    // Count only the requests made AFTER the remount: the voucher opens in USD (its balance currency)
    // so the first selection already reads USD; that earlier read is not what this test measures.
    const beforeReselect = await page.evaluate(
      () => window.voucherFixture.calls.filter((k) => k === "customer-opening:USD").length,
    );
    await selectParty("receipt");
    await current("USD", "90,000");
    const afterReselect = await page.evaluate(
      () => window.voucherFixture.calls.filter((k) => k === "customer-opening:USD").length,
    );
    expect(afterReselect - beforeReselect).toBeGreaterThanOrEqual(1);
  });

  for (const kind of ["receipt", "payment"] as const) {
    it(`${kind}: cash plus discount settles the party, but only cash moves the cashbox and is sent as amount`, async () => {
      await mount(kind);
      await selectParty(kind);
      await current("USD", "100,000");
      await useCurrency("USD");
      await fillAmount("المبلغ الفعلي", 20000);
      await fillAmount("المسامحة", 5000);
      await browserExpect(page.getByTestId("party-after-USD")).toContainText("75,000");
      await browserExpect(page.getByTestId("voucher-cash-impact")).toContainText("20,000");
      await browserExpect(page.getByTestId("voucher-cash-impact")).not.toContainText("25,000");
      await page.getByRole("button", { name: "حفظ السند", exact: true }).click();
      await expect.poll(() => page.evaluate(() => window.voucherFixture.saved.length)).toBe(1);
      const [payload] = await page.evaluate(() => window.voucherFixture.saved);
      expect(payload).toMatchObject({ amount: 20000, discount: 5000, currency: "USD", kind });
      expect(payload.invoiceId).toBeUndefined();
      await current("USD", "75,000");
    });

    it(`${kind}: amendment shows the authoritative balance but never subtracts the existing voucher again`, async () => {
      await mount(kind, { edit: true });
      await current("USD", "100,000");
      await browserExpect(
        page.getByRole("textbox", { name: "المبلغ الفعلي", exact: true }),
      ).toHaveValue("20,000");
      await browserExpect(page.getByRole("textbox", { name: "المسامحة", exact: true })).toHaveValue(
        "5,000",
      );
      await fillAmount("المبلغ الفعلي", 30000);
      for (const currency of ["USD", "SYP", "EUR"]) {
        await browserExpect(page.getByTestId(`party-after-${currency}`)).toHaveCount(0);
      }
      await browserExpect(page.getByTestId("voucher-cash-impact")).toHaveCount(0);
      await current("USD", "100,000");
    });
  }

  for (const method of ["تحويل بنكي", "شيك"]) {
    it(`${method}: settles the party without suggesting any cashbox movement`, async () => {
      await mount("payment");
      await selectParty("payment");
      await current("USD", "100,000");
      await useCurrency("USD");
      await fillAmount("المبلغ الفعلي", 20000);
      await page.getByLabel("طريقة الدفع", { exact: true }).click();
      await page.getByRole("option", { name: method, exact: true }).click();
      await browserExpect(page.getByTestId("party-after-USD")).toContainText("80,000");
      const impact = page.getByTestId("voucher-cash-impact");
      await browserExpect(impact).toContainText("دون تغيير رصيد الصندوق النقدي");
      await browserExpect(impact).not.toContainText("20,000");
      await browserExpect(impact).not.toContainText("رصيد الصندوق بعد السند");
    });
  }
});
