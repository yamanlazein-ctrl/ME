import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { resolve } from "node:path";
import { readFile } from "node:fs/promises";
import { chromium, expect as browserExpect, type Browser, type Page } from "@playwright/test";
import { Invoice } from "@/domain/entities/Invoice";
import { invoiceSubtotal, invoiceTotal } from "@/core/calculations/invoiceCalc";
import { emptyLine as emptyEntryLine, lineSubtotal } from "./entry-types";
import { emptyLine as emptySaleLine, lineTotal } from "./sale-types";
import { EntryInvoicePrint } from "@/components/print/invoices/EntryInvoicePrint";
import { SaleInvoicePrint } from "@/components/print/invoices/SaleInvoicePrint";
import { PartyListPrintDocument } from "@/components/print/PartyListPrintDocument";
import { buildPartyExportModel } from "@/components/parties/partyExportModel";
import { Party } from "@/domain/entities/Party";

// Match the existing SSR print tests: only external stores are mocked, not
// the templates, formatting, Invoice aggregate, or financial calculations.
vi.mock("@/presentation/hooks/useSettings", () => ({
  useSettings: () => ({ company: {}, printing: { showLogo: false, paperSize: "A4" } }),
}));
vi.mock("@/presentation/hooks/useInventory", () => ({
  useInventory: () => undefined,
  fabricById: (id: string) => ({ name: `Fabric ${id}` }),
  rollById: (id: string) => ({ rollNo: id }),
  colorById: () => ({ name: "أبيض", code: "W1", hex: "#fff" }),
}));
vi.mock("@/presentation/hooks/useParties", () => ({
  customerById: () => ({ name: "Customer" }),
  supplierById: () => ({ name: "Supplier" }),
}));
vi.mock("@/presentation/hooks/useVouchers", () => ({
  useVouchersList: () => ({ data: { data: [] } }),
}));
vi.mock("@/components/print/invoices/visibility", () => ({
  useInvoiceVisibility: () => ({
    showSubtotal: true,
    showGrandTotal: true,
    showPaymentSummary: true,
    showPartyName: true,
  }),
}));

type Kind = "entry" | "sale";
const adjustments = { discount: 20, tax: 7.5, shipping: 3.25 };

function entryLines(quantity = 100) {
  return [
    {
      ...emptyEntryLine(),
      fabricName: "Fabric f1",
      grossKg: 120,
      quantity,
      pricePerKg: 12.5,
      discountAmount: 10,
      pieces: 2,
    },
    {
      ...emptyEntryLine(),
      fabricName: "Fabric f2",
      grossKg: 9,
      quantity: 7,
      pricePerKg: 8.25,
      discountAmount: 1.75,
      pieces: 1,
    },
  ];
}

function saleLines(quantityKg = 100) {
  return entryLines(quantityKg).map((line, index) => ({
    ...emptySaleLine(),
    id: `line-${index + 1}`,
    fabricId: `f${index + 1}`,
    colorId: `c${index + 1}`,
    rollId: `r${index + 1}`,
    fabricName: line.fabricName,
    quantityKg: line.quantity,
    pricePerKg: line.pricePerKg,
    discountAmount: line.discountAmount,
    pieces: line.pieces,
  }));
}

describe("Entry/Sale billable weight calculations", () => {
  it.each(["entry", "sale"] as const)(
    "%s: recalculates 100 → 40 with the price unchanged",
    (kind) => {
      if (kind === "entry") {
        const original = { ...entryLines()[0], discountAmount: 0 };
        const edited = { ...original, quantity: 40 };
        expect(lineSubtotal(original)).toBe(1250);
        expect(lineSubtotal(edited)).toBe(500);
        expect(edited.pricePerKg).toBe(original.pricePerKg);
        expect(edited.grossKg).toBe(120);
      } else {
        const original = { ...saleLines()[0], discountAmount: 0 };
        const edited = { ...original, quantityKg: 40 };
        expect(lineTotal(original)).toBe(1250);
        expect(lineTotal(edited)).toBe(500);
        expect(edited.pricePerKg).toBe(original.pricePerKg);
      }
    },
  );

  it.each(["entry", "sale"] as const)(
    "%s: updates only the edited row and retains line discounts, header discount, tax and shipping",
    (kind) => {
      const calculate = (quantity: number) => {
        const lines =
          kind === "entry"
            ? entryLines(quantity).map((line) => ({ ...line, quantityKg: line.quantity }))
            : saleLines(quantity);
        const rowTotals =
          kind === "entry"
            ? entryLines(quantity).map(lineSubtotal)
            : saleLines(quantity).map(lineTotal);
        return {
          rowTotals,
          subtotal: invoiceSubtotal({ lines }),
          grand: invoiceTotal({ lines, ...adjustments }),
        };
      };
      expect(calculate(100)).toEqual({
        rowTotals: [1240, 56],
        subtotal: 1296,
        grand: 1286.75,
      });
      expect(calculate(40)).toEqual({
        rowTotals: [490, 56],
        subtotal: 546,
        grand: 536.75,
      });
    },
  );

  it("Entry gross weight is informational, independent of the billable net quantity", () => {
    const original = entryLines(40)[0];
    expect(lineSubtotal(original)).toBe(490);
    expect(lineSubtotal({ ...original, grossKg: 200 })).toBe(490);
    expect(lineSubtotal({ ...original, grossKg: 0 })).toBe(490);
    expect(original.quantity).toBe(40);
  });

  it("keeps decimal weight edits on the shared two-decimal money policy", () => {
    const entry = { ...entryLines()[0], quantity: 40.01, pricePerKg: 12.55, discountAmount: 0.1 };
    const sale = { ...saleLines()[0], quantityKg: 40.01, pricePerKg: 12.55, discountAmount: 0.1 };
    expect(lineSubtotal(entry)).toBe(502.03);
    expect(lineTotal(sale)).toBe(502.03);
  });
});

/* Vitest runs in Node and this project has no jsdom/Testing Library. Build a
 * tiny in-memory fixture with the already-installed Vite and Playwright instead
 * of mocking React's hooks. This exercises the real input, DOM events and React
 * state, but NOT the full route forms, save requests, or cache invalidation.
 * No server, backend, customer profile, generated files, or network is needed.
 */
const browserFixture = `
import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { FormattedAmountInput } from "@/components/invoices/InvoiceFormLayout";
import { emptyLine as emptyEntryLine, lineSubtotal } from "@/components/invoices/entry-types";
import { emptyLine as emptySaleLine, lineTotal } from "@/components/invoices/sale-types";
import { invoiceSubtotal, invoiceTotal } from "@/core/calculations/invoiceCalc";

function WeightHarness({ kind, initialPrice }) {
  const [quantity, setQuantity] = useState(100);
  const [price, setPrice] = useState(initialPrice);
  const [gross, setGross] = useState(120);
  const lines = kind === "entry"
    ? [
        { ...emptyEntryLine(), quantity, grossKg: gross, pricePerKg: price, discountAmount: 10 },
        { ...emptyEntryLine(), quantity: 7, pricePerKg: 8.25, discountAmount: 1.75 },
      ]
    : [
        { ...emptySaleLine(), quantityKg: quantity, pricePerKg: price, discountAmount: 10 },
        { ...emptySaleLine(), quantityKg: 7, pricePerKg: 8.25, discountAmount: 1.75 },
      ];
  const mathLines = kind === "entry"
    ? lines.map(line => ({ ...line, quantityKg: line.quantity }))
    : lines;
  const rowTotals = lines.map(kind === "entry" ? lineSubtotal : lineTotal);
  return <>
    <FormattedAmountInput ariaLabel="Billable quantity" value={quantity} onChange={v => setQuantity(v === "" ? 0 : v)} />
    <FormattedAmountInput ariaLabel="Unit price" value={price} onChange={v => setPrice(v === "" ? 0 : v)} />
    {kind === "entry" && <FormattedAmountInput ariaLabel="Informational gross weight" value={gross} onChange={v => setGross(v === "" ? 0 : v)} />}
    <button onClick={() => setQuantity(40)}>Apply parent quantity</button>
    <output data-testid="quantity">{quantity}</output>
    <output data-testid="price">{price}</output>
    <output data-testid="first-line">{rowTotals[0]}</output>
    <output data-testid="second-line">{rowTotals[1]}</output>
    <output data-testid="subtotal">{invoiceSubtotal({ lines: mathLines })}</output>
    <output data-testid="grand">{invoiceTotal({ lines: mathLines, discount: 20, tax: 7.5, shipping: 3.25 })}</output>
  </>;
}
const root = document.getElementById("root");
createRoot(root).render(<WeightHarness kind={root.dataset.kind} initialPrice={root.dataset.price === "" ? "" : Number(root.dataset.price)} />);
`;

describe("actual FormattedAmountInput with Entry/Sale line state", { timeout: 15_000 }, () => {
  let browser: Browser;
  let page: Page;
  let fixtureCode: string;

  beforeAll(async () => {
    const { build } = await import("vite");
    const { default: react } = await import("@vitejs/plugin-react");
    const fixtureId = "\0invoice-weight-fixture.tsx";
    const result = await build({
      configFile: false,
      logLevel: "error",
      plugins: [
        {
          name: "invoice-weight-test-fixture",
          resolveId: (id) => (id === "virtual:invoice-weight-fixture" ? fixtureId : undefined),
          load: (id) => (id === fixtureId ? browserFixture : undefined),
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
          input: "virtual:invoice-weight-fixture",
          output: { format: "iife", name: "WeightFixture" },
        },
      },
    });
    if (!("output" in result)) throw new Error("Expected an in-memory fixture build");
    const chunk = result.output.find((output) => output.type === "chunk");
    if (!chunk || chunk.type !== "chunk") throw new Error("Missing browser fixture chunk");
    fixtureCode = chunk.code;
    browser = await chromium.launch({ headless: true });
  }, 60_000);

  afterEach(async () => {
    await page?.close();
  });
  afterAll(async () => {
    await browser?.close();
  });

  async function createPage() {
    page = await browser.newPage();
    page.setDefaultTimeout(3000);
    await page.route("**/*", (route) => route.abort());
  }

  async function mount(kind: Kind, initialPrice: number | "" = 12.5) {
    await createPage();
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.setContent(`<div id="root" data-kind="${kind}" data-price="${initialPrice}"></div>`);
    await page.addScriptTag({ content: fixtureCode });
    await expect
      .poll(async () => ({ errors, inputs: await page.getByLabel("Billable quantity").count() }), {
        timeout: 3000,
      })
      .toEqual({ errors: [], inputs: 1 });
    await browserExpect(page.getByLabel("Billable quantity")).toHaveValue("100");
    // The control's focus handler moves the caret to the end. Focus first so
    // Playwright's subsequent fill selects/replaces text like an operator does.
    await page.getByLabel("Billable quantity").focus();
  }

  for (const kind of ["entry", "sale"] as const) {
    it(`${kind}: typing 100 → 40 updates line and invoice totals without changing the price`, async () => {
      await mount(kind);
      await browserExpect(page.getByTestId("first-line")).toHaveText("1240");
      await browserExpect(page.getByTestId("subtotal")).toHaveText("1296");
      await browserExpect(page.getByTestId("grand")).toHaveText("1286.75");
      const quantity = page.getByLabel("Billable quantity");
      await quantity.fill("40");
      await browserExpect(quantity).toBeFocused();
      await browserExpect(quantity).toHaveValue("40");
      await browserExpect(page.getByTestId("quantity")).toHaveText("40");
      await browserExpect(page.getByLabel("Unit price")).toHaveValue("12.5");
      await browserExpect(page.getByTestId("first-line")).toHaveText("490");
      await browserExpect(page.getByTestId("second-line")).toHaveText("56");
      await browserExpect(page.getByTestId("subtotal")).toHaveText("546");
      await browserExpect(page.getByTestId("grand")).toHaveText("536.75");
      if (kind === "entry") {
        await browserExpect(page.getByLabel("Informational gross weight")).toHaveValue("120");
      }
    });

    it(`${kind}: an authoritative parent value replaces typed raw text without blur or remount`, async () => {
      await mount(kind);
      const quantity = page.getByLabel("Billable quantity");
      await quantity.fill("100.0");
      await browserExpect(quantity).toHaveValue("100.0");
      const originalInput = await quantity.elementHandle();
      // A normal pointer click blurs the input and clears raw, hiding the bug.
      await page.getByRole("button", { name: "Apply parent quantity" }).dispatchEvent("click");
      await browserExpect(page.getByTestId("quantity")).toHaveText("40");
      await browserExpect(page.getByTestId("first-line")).toHaveText("490");
      await browserExpect(page.getByTestId("grand")).toHaveText("536.75");
      await browserExpect(quantity).toBeFocused();
      expect(await quantity.evaluate((node, original) => node === original, originalInput)).toBe(
        true,
      );
      await browserExpect(quantity).toHaveValue("40");
    });

    it.each([0, ""] as const)(
      `${kind}: a unit price initially %j preserves the decimal point while typing .5`,
      async (initialPrice) => {
        await mount(kind, initialPrice);
        const price = page.getByLabel("Unit price");
        await browserExpect(price).toHaveValue("");
        await price.focus();
        await price.press(".");
        await browserExpect(price).toBeFocused();
        await browserExpect(price).toHaveValue(".");
        await browserExpect(page.getByTestId("price")).toHaveText(String(initialPrice));
        await price.press("5");
        await browserExpect(price).toHaveValue(".5");
        await browserExpect(page.getByTestId("price")).toHaveText("0.5");
        await browserExpect(page.getByTestId("first-line")).toHaveText("40");
        await browserExpect(page.getByTestId("grand")).toHaveText("86.75");
        await price.blur();
        await browserExpect(price).toHaveValue("0.5");
      },
    );

    it(`${kind}: a normal parent echo preserves partial decimals and trailing zeroes`, async () => {
      await mount(kind);
      const quantity = page.getByLabel("Billable quantity");
      await quantity.fill("40.");
      await browserExpect(quantity).toHaveValue("40.");
      await browserExpect(page.getByTestId("quantity")).toHaveText("40");
      await quantity.press("0");
      await browserExpect(quantity).toHaveValue("40.0");
      await quantity.press("5");
      await browserExpect(quantity).toHaveValue("40.05");
      await browserExpect(page.getByTestId("quantity")).toHaveText("40.05");
      await browserExpect(page.getByTestId("first-line")).toHaveText("490.63");
      await browserExpect(page.getByTestId("grand")).toHaveText("537.38");
      await quantity.blur();
      await browserExpect(quantity).toHaveValue("40.05");
    });
  }

  it("Entry: editing gross weight does not change billable quantity or money", async () => {
    await mount("entry");
    await page.getByLabel("Billable quantity").fill("40");
    const gross = page.getByLabel("Informational gross weight");
    await gross.focus();
    await gross.fill("200");
    await browserExpect(gross).toHaveValue("200");
    await browserExpect(page.getByLabel("Billable quantity")).toHaveValue("40");
    await browserExpect(page.getByLabel("Unit price")).toHaveValue("12.5");
    await browserExpect(page.getByTestId("first-line")).toHaveText("490");
    await browserExpect(page.getByTestId("grand")).toHaveText("536.75");
  });

  it.each(["customer", "supplier"] as const)(
    "%s list: real print CSS preserves column proportions and wraps long Arabic names",
    async (kind) => {
      const longName =
        "شركة النسيج المتحدة لتجارة الأقمشة القطنية والصوفية والمفروشات المنزلية بالجملة والاستيراد والتصدير في جميع المحافظات السورية";
      const currencyStats = (remaining: number) => ({
        invoicesCount: 1,
        totalAmount: Math.max(0, remaining),
        totalPaid: Math.max(0, -remaining),
        remaining,
      });
      const model = buildPartyExportModel(
        [
          Party.reconstitute({
            id: `print-${kind}`,
            tenantId: "test-tenant",
            kind,
            code: kind === "customer" ? "CUS-2026-0001" : "SUP-2026-0001",
            name: longName,
            status: "active",
            attachments: [],
            activity: [],
            createdAt: "2026-10-15T00:00:00.000Z",
            stats: {
              ...currencyStats(1_250_000.5),
              byCurrency: {
                SYP: currencyStats(1_250_000.5),
                USD: currencyStats(1250.75),
                EUR: currencyStats(-45.5),
              },
            },
          }),
        ],
        kind,
      );
      const markup = renderToStaticMarkup(
        <PartyListPrintDocument
          model={model}
          title={kind === "customer" ? "قائمة العملاء" : "قائمة الموردين"}
          dateLabel="2026-10-15"
        />,
      );
      const css = await readFile(resolve(process.cwd(), "src/components/print/print.css"), "utf8");
      await createPage();
      // A4 landscape in CSS pixels; no test CSS overrides the table or its cells.
      await page.setViewportSize({ width: 1123, height: 794 });
      await page.setContent(
        `<!doctype html><html lang="ar" dir="rtl"><head><meta charset="utf-8"><style>${css}</style></head><body><div data-print-root>${markup}</div></body></html>`,
      );
      await page.emulateMedia({ media: "print" });
      await page.evaluate(() => document.fonts.ready.then(() => undefined));
      await browserExpect(page.locator(".print-table")).toBeVisible();
      await browserExpect(page.locator(".print-doc")).toHaveAttribute(
        "data-orientation",
        "landscape",
      );
      await browserExpect(page.locator(".print-table thead th")).toHaveText([
        "#",
        "الرمز",
        "الاسم",
        "العملة",
        "لنا (مدين)",
        "علينا (دائن)",
      ]);
      await browserExpect(page.getByText(longName, { exact: true })).toHaveCount(1);
      const rows = page.locator(".print-table tbody tr");
      await browserExpect(rows).toHaveCount(3);
      await browserExpect(rows.locator("td:nth-child(4)")).toHaveText(["ل.س", "€", "$"]);
      const receivableColumn = rows.locator("td:nth-child(5)");
      const payableColumn = rows.locator("td:nth-child(6)");
      await browserExpect(receivableColumn).toHaveText(
        kind === "customer" ? ["1,250,000.5", "0", "1,250.75"] : ["0", "45.5", "0"],
      );
      await browserExpect(payableColumn).toHaveText(
        kind === "customer" ? ["0", "45.5", "0"] : ["1,250,000.5", "0", "1,250.75"],
      );
      const geometry = await page.locator(".print-table").evaluate((table) => {
        const headers = Array.from(table.querySelectorAll("thead th"));
        const tableWidth = table.getBoundingClientRect().width;
        const name = table.querySelector<HTMLTableCellElement>(
          "tbody tr:first-child td:nth-child(3)",
        )!;
        const nameBox = name.getBoundingClientRect();
        const range = document.createRange();
        range.selectNodeContents(name);
        const textRects = Array.from(range.getClientRects());
        const money = Array.from(table.querySelectorAll<HTMLElement>("tbody td.pd-amount"));
        return {
          printMedia: matchMedia("print").matches,
          rootPosition: getComputedStyle(document.querySelector("[data-print-root]")!).position,
          tableLayout: getComputedStyle(table).tableLayout,
          tableWidth,
          headerRatios: headers.map(
            (header) => (header.getBoundingClientRect().width / tableWidth) * 100,
          ),
          nameWhiteSpace: getComputedStyle(name).whiteSpace,
          nameLines: new Set(textRects.map((rect) => Math.round(rect.top * 10))).size,
          nameTextFits: textRects.every(
            (rect) => rect.left >= nameBox.left - 1 && rect.right <= nameBox.right + 1,
          ),
          amountTextFits: money.every((cell) => {
            const box = cell.getBoundingClientRect();
            const amount = cell.querySelector(".pd-money-unit")!.getBoundingClientRect();
            return (
              cell.textContent!.trim() !== "" &&
              getComputedStyle(cell).whiteSpace === "nowrap" &&
              cell.scrollWidth <= cell.clientWidth + 1 &&
              amount.left >= box.left - 1 &&
              amount.right <= box.right + 1
            );
          }),
        };
      });
      console.info(`${kind} print geometry: ${JSON.stringify(geometry)}`);
      expect(geometry.printMedia).toBe(true);
      expect(geometry.rootPosition).toBe("static");
      expect(geometry.tableLayout).toBe("fixed");
      expect(geometry.tableWidth).toBeGreaterThan(900);
      expect(geometry.headerRatios).toHaveLength(6);
      const expectedRatios = [5, 15, 25, 10, 22.5, 22.5];
      geometry.headerRatios.forEach((ratio, index) => {
        // Allow subpixel rounding and collapsed borders, not a widened name column.
        expect(Math.abs(ratio - expectedRatios[index])).toBeLessThan(0.25);
      });
      expect(geometry.nameWhiteSpace).toBe("normal");
      expect(geometry.nameLines).toBeGreaterThan(1);
      expect(geometry.nameTextFits).toBe(true);
      expect(geometry.amountTextFits).toBe(true);
    },
  );
});

function printableInvoice(kind: Kind, quantity: number) {
  return Invoice.create({
    id: `weight-${kind}`,
    tenantId: "test-tenant",
    number: `WEIGHT-${kind}`,
    type: kind,
    date: "2026-10-15",
    partyId: "test-party",
    partyType: kind === "entry" ? "supplier" : "customer",
    currency: "USD",
    lines: saleLines(quantity),
    ...adjustments,
    paid: 100,
    createdAt: "2026-10-15T00:00:00.000Z",
    createdBy: "test-user",
  });
}

const textOf = (html: string) =>
  html
    .replace(/<[^>]*>/g, " ")
    .replace(/[\u2066-\u2069]/g, "")
    .replace(/\s+/g, " ")
    .trim();

function printedRows(html: string) {
  const body = /<tbody>([\s\S]*?)<\/tbody>/.exec(html)?.[1] ?? "";
  return [...body.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)].map((row) =>
    [...row[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((cell) => textOf(cell[1])),
  );
}

function printedTotals(html: string) {
  return [...html.matchAll(/<div class="print-total-row[^"]*">([\s\S]*?)<\/div>/g)].map((row) =>
    textOf(row[1]),
  );
}

describe.each(["entry", "sale"] as const)("%s print weight consistency", (kind) => {
  const Template = kind === "entry" ? EntryInvoicePrint : SaleInvoicePrint;

  it("prints recalculated rows and totals after 100 → 40, retaining the other line and price", () => {
    const original = printableInvoice(kind, 100);
    const edited = printableInvoice(kind, 40);
    const before = renderToStaticMarkup(<Template invoice={original} />);
    const after = renderToStaticMarkup(<Template invoice={edited} />);
    const beforeRows = printedRows(before);
    const afterRows = printedRows(after);
    expect(beforeRows).toHaveLength(2);
    expect(afterRows).toHaveLength(2);
    expect(beforeRows[0].slice(-4)).toEqual(["2", "100", "12.5", "1,240"]);
    expect(afterRows[0].slice(-4)).toEqual(["2", "40", "12.5", "490"]);
    expect(afterRows[1].slice(-4)).toEqual(["1", "7", "8.25", "56"]);
    expect(afterRows[1]).toEqual(beforeRows[1]);
    expect(printedTotals(before)).toEqual(
      expect.arrayContaining(["المجموع $ 1,296", "الإجمالي النهائي $ 1,286.75"]),
    );
    expect(printedTotals(after)).toEqual(
      expect.arrayContaining([
        "المجموع $ 546",
        "الخصم − $ 20",
        "الضريبة + $ 7.5",
        "الشحن + $ 3.25",
        "الإجمالي النهائي $ 536.75",
      ]),
    );
    expect(printedTotals(after)).not.toContain("الإجمالي النهائي $ 1,286.75");
    const payment = textOf(
      /<div class="print-payment[^"]*">([\s\S]*?)<\/div>\s*<\/div>\s*<\/div>/.exec(after)?.[1] ??
        "",
    );
    expect(payment).toContain("الإجمالي $ 536.75");
    expect(payment).toContain(kind === "entry" ? "المدفوع $ 100" : "المقبوض $ 100");
    expect(payment).toContain(kind === "entry" ? "المتبقي $ 436.75" : "الباقي $ 436.75");
    expect(edited.lineSubtotal()).toBe(546);
    expect(edited.total()).toBe(536.75);
  });

  it("prints the selected page's edited row while totals still cover the whole invoice", () => {
    const invoice = printableInvoice(kind, 40);
    const html = renderToStaticMarkup(
      <Template invoice={invoice} linesOverride={invoice.lines.slice(0, 1)} />,
    );
    const rows = printedRows(html);
    expect(rows).toHaveLength(1);
    expect(rows[0].slice(-4)).toEqual(["2", "40", "12.5", "490"]);
    expect(printedTotals(html)).toEqual(
      expect.arrayContaining(["المجموع $ 546", "الإجمالي النهائي $ 536.75"]),
    );
  });
});
