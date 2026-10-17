/**
 * Pure model for "طباعة / تصدير الكل" on the customers and suppliers lists.
 *
 * One row per party. Balances are taken per currency from `stats.byCurrency[ccy].remaining`
 * and are never blended across currencies (USD and SYP are not summed).
 *
 * Sign convention (matches the on-screen balance and the statement):
 *   - customer: remaining > 0 means the customer owes us → "لنا / مدين" (receivable)
 *   - supplier: remaining > 0 means we owe the supplier → "علينا / دائن" (payable)
 *   Receivable and payable are kept as positive magnitudes in their own columns.
 */
import type { Party } from "@/domain/entities/Party";
import type { PartyKind } from "@/components/parties/PartyFormDialog";
import { round2dp } from "@erp/shared";

export type ExportBalanceCell = {
  currency: string;
  /** Owed to us (positive magnitude). */
  receivable: number;
  /** We owe (positive magnitude). */
  payable: number;
  /** receivable − payable (signed, by the same convention). */
  net: number;
};

export type ExportPartyRow = {
  index: number;
  code: string;
  name: string;
  phone: string;
  /** One cell per currency the party has balances in. Empty when the party has no activity. */
  balances: ExportBalanceCell[];
};

export type ExportCurrencySummary = {
  currency: string;
  receivable: number;
  payable: number;
  net: number;
};

export type PartyExportModel = {
  kind: PartyKind;
  rows: ExportPartyRow[];
  summaryByCurrency: ExportCurrencySummary[];
  partyCount: number;
};

/** Money rounding goes through the shared precision helper (exact decimal, half away from zero). */
const r2 = (n: number) => round2dp(n);

/** Ascending, deterministic currency order: SYP first, then the rest alphabetically. */
function sortCurrencies(codes: string[]): string[] {
  return [...codes].sort((a, b) => {
    if (a === "SYP") return -1;
    if (b === "SYP") return 1;
    return a.localeCompare(b);
  });
}

/**
 * Build the export model. `parties` should be the full list (never the paged view). Soft-deleted
 * parties are those with `status === "cancelled"`; they are excluded here as well as in the cache.
 */
export function buildPartyExportModel(
  parties: readonly Party[],
  kind: PartyKind,
): PartyExportModel {
  const live = parties.filter((p) => p.status !== "cancelled");
  const sign = kind === "customer" ? 1 : -1;

  const rows: ExportPartyRow[] = live.map((p, i) => {
    const byCurrency = p.stats?.byCurrency ?? {};
    const balances: ExportBalanceCell[] = sortCurrencies(Object.keys(byCurrency)).map((ccy) => {
      const remaining = byCurrency[ccy]?.remaining ?? 0;
      // Signed by party kind: for a customer a positive remaining is receivable, for a supplier
      // a positive remaining is payable.
      const signed = remaining * sign;
      const receivable = signed > 0 ? r2(signed) : 0;
      const payable = signed < 0 ? r2(-signed) : 0;
      return { currency: ccy, receivable, payable, net: r2(receivable - payable) };
    });
    return {
      index: i + 1,
      code: p.code ?? "",
      name: p.name,
      phone: p.phone ?? "",
      balances,
    };
  });

  const totals = new Map<string, ExportCurrencySummary>();
  for (const row of rows) {
    for (const b of row.balances) {
      const t = totals.get(b.currency) ?? {
        currency: b.currency,
        receivable: 0,
        payable: 0,
        net: 0,
      };
      t.receivable = r2(t.receivable + b.receivable);
      t.payable = r2(t.payable + b.payable);
      t.net = r2(t.net + b.net);
      totals.set(b.currency, t);
    }
  }
  const summaryByCurrency = sortCurrencies([...totals.keys()]).map((c) => totals.get(c)!);

  return { kind, rows, summaryByCurrency, partyCount: live.length };
}

/** Signed amount with the currency code, for CSV / print text. */
export function formatExportAmount(n: number): string {
  return n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/** Column headers, in the order used by both the CSV and the printed table. */
export const EXPORT_HEADERS = {
  index: "#",
  code: "الرمز",
  name: "الاسم",
  phone: "الهاتف",
  receivable: "لنا / مدين",
  payable: "علينا / دائن",
  net: "الرصيد الصافي",
  currency: "العملة",
} as const;

/**
 * Flatten to one CSV line per (party, currency) pair. A party with balances in two currencies gets
 * two lines, so amounts from different currencies never land in one cell. A party with no balance
 * gets a single line with a blank currency and zeros.
 */
export function partyExportCsvRows(model: PartyExportModel): string[][] {
  const out: string[][] = [
    [
      EXPORT_HEADERS.index,
      EXPORT_HEADERS.code,
      EXPORT_HEADERS.name,
      EXPORT_HEADERS.phone,
      EXPORT_HEADERS.currency,
      EXPORT_HEADERS.receivable,
      EXPORT_HEADERS.payable,
      EXPORT_HEADERS.net,
    ],
  ];
  for (const row of model.rows) {
    if (row.balances.length === 0) {
      out.push([
        String(row.index),
        row.code,
        row.name,
        row.phone,
        "",
        formatExportAmount(0),
        formatExportAmount(0),
        formatExportAmount(0),
      ]);
      continue;
    }
    for (const b of row.balances) {
      out.push([
        String(row.index),
        row.code,
        row.name,
        row.phone,
        b.currency,
        formatExportAmount(b.receivable),
        formatExportAmount(b.payable),
        formatExportAmount(b.net),
      ]);
    }
  }
  for (const s of model.summaryByCurrency) {
    out.push([
      "",
      "",
      "الإجمالي",
      "",
      s.currency,
      formatExportAmount(s.receivable),
      formatExportAmount(s.payable),
      formatExportAmount(s.net),
    ]);
  }
  return out;
}
