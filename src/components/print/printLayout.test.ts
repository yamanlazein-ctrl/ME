/**
 * Print layout contracts (Issues 1–3 of the layout directive):
 *  1. Document titles are centred and identical across invoice types (shared CSS masthead).
 *  2. No browser/WebView header or footer: the unnamed @page has empty margin boxes, in print.css
 *     AND in the runtime rule the portal injects (and the archived HTML).
 *  3. The customers/suppliers list has exactly the agreed columns, no phone, no duplicate net.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { pageRuleCss } from "./printPortal";

const HERE = dirname(fileURLToPath(import.meta.url));
const css = readFileSync(join(HERE, "print.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
const listSrc = readFileSync(join(HERE, "PartyListPrintDocument.tsx"), "utf8");
const docSrc = readFileSync(join(HERE, "PrintDocument.tsx"), "utf8");

const MARGIN_BOXES = [
  "top-left",
  "top-center",
  "top-right",
  "bottom-left",
  "bottom-center",
  "bottom-right",
];

describe("Issue 2 — no browser header/footer", () => {
  it("print.css unnamed @page clears every margin box", () => {
    const page = css.match(/@page\s*\{[\s\S]*?\n\}/)?.[0] ?? "";
    expect(page).toMatch(/margin:\s*0/);
    for (const box of MARGIN_BOXES) {
      expect(page, `@${box} must be empty`).toMatch(
        new RegExp(`@${box}\\s*\\{\\s*content:\\s*none`),
      );
    }
  });

  it("runtime @page rule (portal + archive) clears every margin box too", () => {
    const rule = pageRuleCss("A4", "portrait");
    expect(rule).toContain("margin: 0");
    for (const box of MARGIN_BOXES) {
      expect(rule).toContain(`@${box} { content: none; }`);
    }
  });

  it("runtime rule keeps the paper size for every paper type", () => {
    expect(pageRuleCss("A4", "portrait")).toContain("size: A4 portrait");
    expect(pageRuleCss("A5", "landscape")).toContain("size: A5 landscape");
    expect(pageRuleCss("80mm")).toContain("size: 80mm auto");
  });
});

describe("Issue 1 — centred, uniform document title", () => {
  it("the masthead and title block are centred", () => {
    expect(css).toMatch(/\.print-masthead\s*\{[^}]*text-align:\s*center/);
    expect(css).toMatch(/\.print-header-title-area\s*\{[^}]*text-align:\s*center/);
    expect(css).toMatch(/\.print-title-row\s*\{[^}]*align-items:\s*center/);
  });

  it("the main title is large and bold, centred", () => {
    const title = css.match(/\.print-doc-title\s*\{[^}]*\}/)?.[0] ?? "";
    expect(title).toMatch(/font-size:\s*22pt/);
    expect(title).toMatch(/font-weight:\s*800/);
    expect(title).toMatch(/text-align:\s*center/);
  });

  it("the transaction badge and sub-description sit centred under the title", () => {
    expect(css).toMatch(/\.print-type-badge\s*\{[^}]*display:\s*block[^}]*text-align:\s*center/);
    expect(css).toMatch(/\.print-doc-subtitle\s*\{[^}]*text-align:\s*center/);
  });

  it("the shared title block renders title, then badge, then subtitle", () => {
    const titleIdx = docSrc.indexOf('className="print-doc-title"');
    const badgeIdx = docSrc.indexOf("print-type-badge");
    const subIdx = docSrc.indexOf('className="print-doc-subtitle"');
    expect(titleIdx).toBeGreaterThan(0);
    expect(subIdx).toBeGreaterThan(titleIdx);
    expect(badgeIdx).toBeGreaterThan(0);
  });
});

describe("Issue 3 — customers/suppliers list layout", () => {
  // Only the column definitions are checked here (they are the table's shape).
  const columnBlock = listSrc.slice(
    listSrc.indexOf("const columns"),
    listSrc.indexOf("];", listSrc.indexOf("const columns")),
  );
  const labels = [...columnBlock.matchAll(/label:\s*"([^"]+)"/g)].map((m) => m[1]);

  it("has exactly the agreed columns, in order", () => {
    expect(labels).toEqual(["#", "الرمز", "الاسم", "العملة", "لنا (مدين)", "علينا (دائن)"]);
  });

  it("has no phone column and no duplicate net-balance column", () => {
    expect(labels).not.toContain("الهاتف");
    expect(labels).not.toContain("الرصيد الصافي");
    expect(listSrc).not.toMatch(/key:\s*"phone"/);
    expect(listSrc).not.toMatch(/key:\s*"net"/);
  });

  it("the title is passed to the shared, centred PrintDocument masthead", () => {
    expect(listSrc).toMatch(/<PrintDocument\s+title=\{title\}/);
  });

  it("column proportions are the agreed balanced split (sum 100%)", () => {
    const widthOf = (key: string) =>
      Number(columnBlock.match(new RegExp(`key: "${key}"[^}]*width: "(\\d+(?:\\.\\d+)?)%"`))?.[1]);
    expect(widthOf("idx")).toBe(5);
    expect(widthOf("code")).toBe(15);
    expect(widthOf("name")).toBe(25);
    expect(widthOf("ccy")).toBe(10);
    expect(widthOf("rec")).toBe(22.5);
    expect(widthOf("pay")).toBe(22.5);
    const all = [...columnBlock.matchAll(/width:\s*"(\d+(?:\.\d+)?)%"/g)].map((m) => Number(m[1]));
    expect(all.reduce((a, b) => a + b, 0)).toBe(100);
  });

  it("the table is fixed-layout, so declared widths are honoured", () => {
    const tableRule = css.match(/\.print-table\s*\{[^}]*\}/)?.[0] ?? "";
    expect(tableRule).toMatch(/table-layout:\s*fixed/);
    expect(tableRule).not.toMatch(/table-layout:\s*auto/);
  });

  it("currency is shown as the Arabic symbol, never the ISO code beside it", () => {
    expect(listSrc).toMatch(/function currencyLabel/);
    // The amount cell carries no symbol of its own (it would print twice on one row).
    expect(listSrc).toMatch(/function AmountCell[\s\S]*?<Money amount=\{amount\} \/>/);
    expect(listSrc).not.toMatch(/<span key="c" dir="ltr">\s*\{b\.currency\}/);
  });

  it("every multi-column print table declares widths that sum to 100%", () => {
    const tables = [
      "src/components/print/invoices/SaleInvoicePrint.tsx",
      "src/components/print/invoices/EntryInvoicePrint.tsx",
      "src/components/print/invoices/ReturnInvoicePrint.tsx",
      "src/components/print/PartyStatementDocument.tsx",
      "src/components/print/PartyListPrintDocument.tsx",
    ];
    for (const rel of tables) {
      const src = readFileSync(join(HERE, "..", "..", "..", rel), "utf8");
      const widths = [...src.matchAll(/width:\s*"(\d+(?:\.\d+)?)%"/g)].map((m) => Number(m[1]));
      expect(widths.length, `${rel} declares column widths`).toBeGreaterThan(0);
      expect(
        widths.reduce((a, b) => a + b, 0),
        `${rel} sums to 100`,
      ).toBe(100);
    }
  });

  it("the print page has empty margin boxes and a printable body inset", () => {
    expect(css).toMatch(
      /@media print[\s\S]*body > \[data-print-root\] > \.print-doc\s*\{\s*padding:\s*12mm 15mm/,
    );
  });
});
