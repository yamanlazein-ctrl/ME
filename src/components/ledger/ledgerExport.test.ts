import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  LEDGER_EXPORT_HEADERS,
  exportAmount,
  ledgerExportCsv,
  ledgerExportLines,
} from "./ledgerExport";
import type { LedgerPrintRow } from "@/components/print/LedgerPrintDocument";

const HERE = dirname(fileURLToPath(import.meta.url));

const row = (over: Partial<LedgerPrintRow> = {}): LedgerPrintRow => ({
  id: "1",
  createdAt: "2026-10-15T09:00:00.000Z",
  type: "receipt_in",
  description: "سند قبض",
  referenceNumber: "R-1",
  partyName: "يي",
  debit: 0,
  credit: 20000,
  currency: "USD",
  cashImpact: "in",
  status: "active",
  ...over,
});

describe("ledger Excel export", () => {
  it("zero matching rows still produce the header line, with no error", () => {
    const lines = ledgerExportLines([]);
    expect(lines).toEqual([[...LEDGER_EXPORT_HEADERS]]);
    const csv = ledgerExportCsv([]);
    expect(csv.startsWith("\ufeff")).toBe(true);
    expect(csv).toContain(`"${LEDGER_EXPORT_HEADERS[0]}"`);
    expect(csv.trim().split("\r\n")).toHaveLength(1);
  });

  it("writes a UTF-8 BOM, quotes every field, and doubles embedded quotes", () => {
    const csv = ledgerExportCsv([row({ description: 'وصف "مهم"' })]);
    expect(csv.charCodeAt(0)).toBe(0xfeff);
    expect(csv).toContain('"وصف ""مهم"""');
  });

  it("one line per row, amounts as plain two-decimal numbers, status in Arabic", () => {
    const lines = ledgerExportLines([
      row(),
      row({ id: "2", status: "cancelled", debit: 5, credit: 0 }),
    ]);
    expect(lines).toHaveLength(3);
    expect(lines[1]).toContain("20000.00");
    expect(lines[1][LEDGER_EXPORT_HEADERS.indexOf("الحالة")]).toBe("نشطة");
    expect(lines[2][LEDGER_EXPORT_HEADERS.indexOf("الحالة")]).toBe("ملغاة");
    expect(lines[2][LEDGER_EXPORT_HEADERS.indexOf("مدين")]).toBe("5.00");
  });

  it("blank amounts stay blank, not 0.00 (a debit-only row has no credit figure)", () => {
    expect(exportAmount(0)).toBe("");
    expect(exportAmount(12.5)).toBe("12.50");
  });

  it("the page wires print and Excel to real handlers, not bare buttons", () => {
    const page = readFileSync(join(HERE, "..", "..", "routes", "ledger.tsx"), "utf8");
    expect(page).toMatch(/onClick=\{\(\) => void handlePrint\(\)\}/);
    expect(page).toMatch(/onClick=\{\(\) => void handleExcel\(\)\}/);
    expect(page).not.toMatch(/<Button variant="outline">طباعة<\/Button>/);
    expect(page).not.toMatch(/<Button variant="outline">تصدير Excel<\/Button>/);
  });
});
