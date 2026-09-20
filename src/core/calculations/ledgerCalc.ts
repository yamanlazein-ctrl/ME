import type { LedgerType, CashImpact, Currency } from "@/domain/types";
import type { PartyKind } from "@/domain/entities/Party";
import type { InvoiceData, InvoiceLineData } from "@/domain/entities/Invoice";
import { invoiceTotal } from "./invoiceCalc";
import { round2dp } from "@erp/shared";

export type LedgerStatus = "active" | "cancelled";

export type LedgerEntry = {
  id: string;
  tenantId: string;
  date: string;
  type: string;
  referenceType: string;
  referenceId?: string | null;
  referenceNumber?: string | null;
  partyId?: string | null;
  partyKind?: PartyKind | null;
  debit: number;
  credit: number;
  currency: Currency;
  cashImpact: CashImpact;
  status: LedgerStatus;
  createdBy: string;
  createdAt: string;
  cancelledBy?: string | null;
  cancelledAt?: string | null;
  description: string;
  notesInternal?: string | null;
  invoiceId?: string | null;
  runningBalance?: number;
};

export const LEDGER_TYPE_LABEL: Record<string, string> = {
  opening: "رصيد افتتاحي",
  purchase_invoice: "فاتورة دخول",
  sales_invoice: "فاتورة بيع",
  payment_out: "سند صرف",
  receipt_in: "سند قبض",
  settlement_discount_expense: "خصم على قبض",
  settlement_discount_income: "خصم على صرف",
  purchase_return: "مرتجع دخول",
  sales_return: "مرتجع بيع",
  expense: "مصروف",
  printing_charge: "أجور طباعة",
  adjustment: "تسوية يدوية",
  settlement: "تسوية حساب",
};

export type FabricHistoryRow = {
  key: string;
  fabricId: string;
  fabricName: string;
  colorId: string;
  colorName: string;
  colorCode: string;
  dyeBatch: string;
  invoicesCount: number;
  totalKg: number;
  totalAmount: number;
  avgPrice: number;
  lastDate: string;
  currency: Currency;
};

export type OutstandingRow = {
  invoiceId: string;
  number: string;
  date: string;
  total: number;
  paid: number;
  remaining: number;
  ageDays: number;
  bucket: "0-30" | "31-60" | "61-90" | "90+";
  currency: Currency;
};

/** Minimal return shape for remaining = total − paid − returns (matches voucher/settle). */
export type ReturnCreditInput = {
  originalInvoiceId?: string | null;
  status?: string;
  currency?: string;
  amount?: number;
  lines?: { quantityKg: number; pricePerKg: number }[];
};

export type PartyStats = {
  invoicesCount: number;
  totalAmount: number;
  totalPaid: number;
  remaining: number;
  avgInvoice: number;
  lastDate?: string;
  totalKg: number;
  topFabric?: string;
  topColor?: string;
  topDye?: string;
  creditLimit: number;
  creditUsed: number;
  creditRemaining: number;
};

/** Per-currency breakdown of party stats — never blends currencies. */
export type PartyStatsByCurrency = {
  invoicesCount: number;
  totalAmount: number;
  totalPaid: number;
  remaining: number;
  avgInvoice: number;
  lastDate?: string;
  totalKg: number;
};

type FsParty = { id: string; creditLimit?: number };

const isActive = (e: { status?: string }) => !e.status || e.status === "active";

function returnCreditAmount(r: ReturnCreditInput): number {
  if (typeof r.amount === "number" && Number.isFinite(r.amount)) return round2dp(r.amount);
  return round2dp(
    (r.lines ?? []).reduce((s, l) => s + Number(l.quantityKg) * Number(l.pricePerKg), 0),
  );
}

/** Active returns keyed by original invoice id (invoice-currency amounts). */
export function returnsAmountByInvoice(returns: ReturnCreditInput[] = []): Map<string, number> {
  const map = new Map<string, number>();
  for (const r of returns) {
    if (!isActive(r) || !r.originalInvoiceId) continue;
    const amt = returnCreditAmount(r);
    if (amt <= 0) continue;
    map.set(r.originalInvoiceId, round2dp((map.get(r.originalInvoiceId) ?? 0) + amt));
  }
  return map;
}

export function filterLedger(
  entries: LedgerEntry[],
  f: {
    from?: string;
    to?: string;
    types?: string[];
    currency?: Currency | "all";
    status?: LedgerStatus | "all";
  },
): LedgerEntry[] {
  return entries.filter((e) => {
    if (e.type === "opening") return true;
    if (f.from && e.date < f.from) return false;
    if (f.to && e.date > f.to) return false;
    if (f.types && f.types.length && !f.types.includes(e.type)) return false;
    if (f.currency && f.currency !== "all" && e.currency !== f.currency) return false;
    if (f.status && f.status !== "all" && e.status !== f.status) return false;
    return true;
  });
}

/** Build the ledger view for one party from real API ledger entries. */
export function buildLedger(
  party: { id: string },
  kind: PartyKind,
  entries: LedgerEntry[],
): LedgerEntry[] {
  const out = entries.filter((e) => e.partyId === party.id && isActive(e)).map((e) => ({ ...e }));
  let running = 0;
  for (const e of out) {
    running += kind === "customer" ? e.debit - e.credit : e.credit - e.debit;
    e.runningBalance = running;
  }
  return out;
}

/** Build the global ledger view from real API ledger entries. */
export function buildGlobalLedger(entries: LedgerEntry[]): LedgerEntry[] {
  return entries.map((e) => ({ ...e }));
}

/** Build fabric/color/dye history for a party from real invoices. */
export function buildFabricHistory(
  partyId: string,
  kind: PartyKind,
  invoices: InvoiceData[],
  colorNames: Record<string, string>,
  colorCodes: Record<string, string>,
  fabricNames: Record<string, string>,
): FabricHistoryRow[] {
  const map = new Map<string, FabricHistoryRow>();
  const expectedType = kind === "supplier" ? "entry" : "sale";
  const invoicesFor = invoices.filter(
    (i) => i.partyId === partyId && isActive(i) && i.type === expectedType,
  );
  for (const inv of invoicesFor) {
    for (const l of inv.lines) {
      const dyeBatch = (l as InvoiceLineData & { dyeBatch?: string }).dyeBatch ?? "";
      const key = `${l.fabricId}|${l.colorId}|${dyeBatch}`;
      const cur = map.get(key) ?? {
        key,
        fabricId: l.fabricId,
        fabricName: fabricNames[l.fabricId] ?? "—",
        colorId: l.colorId,
        colorName: colorNames[l.colorId] ?? "—",
        colorCode: colorCodes[l.colorId] ?? "—",
        dyeBatch,
        invoicesCount: 0,
        totalKg: 0,
        totalAmount: 0,
        avgPrice: 0,
        lastDate: inv.date,
        currency: inv.currency,
      };
      cur.invoicesCount += 1;
      cur.totalKg += l.quantityKg;
      cur.totalAmount += l.quantityKg * l.pricePerKg;
      cur.lastDate = inv.date > cur.lastDate ? inv.date : cur.lastDate;
      map.set(key, cur);
    }
  }
  return [...map.values()].map((r) => ({
    ...r,
    avgPrice: r.totalKg > 0 ? round2dp(r.totalAmount / r.totalKg) : 0,
  }));
}

/** Build outstanding (unpaid) invoices for a party from real invoices.
 *  When `currency` is omitted, every invoice currency is included — callers
 *  must group/display per currency (never blend SYP+USD into one total). */
export function buildOutstanding(
  partyId: string,
  invoices: InvoiceData[],
  vouchers: {
    partyId: string;
    invoiceId?: string | null;
    kind: string;
    status: string;
    amount: number;
    currency?: string;
  }[],
  currency?: string,
  returns: ReturnCreditInput[] = [],
): OutstandingRow[] {
  const rows: OutstandingRow[] = [];
  // Prefer invoices.paid (backend-maintained, FX-safe). Voucher sums are a
  // fallback for older clients that omit paid on the invoice DTO.
  const paidByInvoice = new Map<string, number>();
  for (const v of vouchers) {
    if (v.status !== "active" || !v.invoiceId) continue;
    if (v.partyId !== partyId) continue;
    if (currency && v.currency !== currency) continue;
    paidByInvoice.set(v.invoiceId, (paidByInvoice.get(v.invoiceId) ?? 0) + v.amount);
  }
  const returnsByInv = returnsAmountByInvoice(returns);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  for (const inv of invoices) {
    if (inv.partyId !== partyId || !isActive(inv)) continue;
    if (currency && inv.currency !== currency) continue;
    const total = round2dp(invoiceTotal(inv));
    if (total <= 0) continue;
    const paid = round2dp(
      inv.paid != null && Number.isFinite(inv.paid) ? inv.paid : (paidByInvoice.get(inv.id) ?? 0),
    );
    // Same formula as settleInvoicesUseCase / voucher create: total − paid − returns.
    const remaining = round2dp(total - paid - (returnsByInv.get(inv.id) ?? 0));
    if (remaining <= 0) continue;
    const d = new Date(inv.date + "T00:00:00");
    const ageDays = Math.max(0, Math.floor((today.getTime() - d.getTime()) / 86_400_000));
    const bucket: OutstandingRow["bucket"] =
      ageDays > 90 ? "90+" : ageDays > 60 ? "61-90" : ageDays > 30 ? "31-60" : "0-30";
    rows.push({
      invoiceId: inv.id,
      number: inv.number,
      date: inv.date,
      total,
      paid,
      remaining,
      ageDays,
      bucket,
      currency: inv.currency,
    });
  }
  return rows.sort((a, b) => (a.date < b.date ? 1 : -1));
}

/** Build summary stats for a party from real invoices + vouchers. */
export function buildPartyStats(
  party: FsParty,
  kind: PartyKind,
  invoices: InvoiceData[],
  vouchers: { partyId: string; kind: string; status: string; amount: number; currency?: string }[],
  currency?: string,
  returns: ReturnCreditInput[] = [],
): PartyStats {
  const expectedType = kind === "supplier" ? "entry" : "sale";
  let invs = invoices.filter(
    (i) => i.partyId === party.id && isActive(i) && i.type === expectedType,
  );
  if (currency) {
    invs = invs.filter((i) => i.currency === currency);
  }
  const returnsByInv = returnsAmountByInvoice(returns);
  const totalAmount = invs.reduce((s, i) => s + round2dp(invoiceTotal(i)), 0);
  // Read paid directly from invoice rows (backend-maintained, FX-converted).
  const paid = invs.reduce((s, i) => s + (i.paid ?? 0), 0);
  const returnsCredit = invs.reduce((s, i) => s + (returnsByInv.get(i.id) ?? 0), 0);
  // No Math.max clamp — a negative remaining is a real credit balance and
  // hiding it corrupts the summary card (H2 fix).
  const remaining = totalAmount - paid - returnsCredit;
  const totalKg = invs.reduce((s, i) => s + i.lines.reduce((a, l) => a + l.quantityKg, 0), 0);
  const dates = invs
    .map((i) => i.date)
    .filter(Boolean)
    .sort();
  const creditLimit = party.creditLimit ?? 0;
  const creditUsed = remaining;
  const creditRemaining = creditLimit > 0 ? Math.max(0, creditLimit - creditUsed) : 0;
  return {
    invoicesCount: invs.length,
    totalAmount,
    totalPaid: paid,
    remaining,
    avgInvoice: invs.length ? round2dp(totalAmount / invs.length) : 0,
    lastDate: dates.length ? dates[dates.length - 1] : undefined,
    totalKg: Math.round(totalKg),
    creditLimit,
    creditUsed,
    creditRemaining,
  };
}

/** Build per-currency breakdown of party stats — never blends currencies. */
export function buildPartyStatsByCurrency(
  party: FsParty,
  kind: PartyKind,
  invoices: InvoiceData[],
  vouchers: { partyId: string; kind: string; status: string; amount: number; currency?: string }[],
  returns: ReturnCreditInput[] = [],
): Record<string, PartyStatsByCurrency> {
  const expectedType = kind === "supplier" ? "entry" : "sale";
  const invs = invoices.filter(
    (i) => i.partyId === party.id && isActive(i) && i.type === expectedType,
  );
  const returnsByInv = returnsAmountByInvoice(returns);

  const out: Record<string, PartyStatsByCurrency> = {};
  for (const inv of invs) {
    const c = inv.currency;
    const cur = out[c] ?? {
      invoicesCount: 0,
      totalAmount: 0,
      totalPaid: 0,
      remaining: 0,
      avgInvoice: 0,
      totalKg: 0,
      lastDate: undefined as string | undefined,
    };
    cur.invoicesCount += 1;
    cur.totalAmount += round2dp(invoiceTotal(inv));
    cur.totalPaid += inv.paid ?? 0;
    cur.totalKg += inv.lines.reduce((a, l) => a + l.quantityKg, 0);
    if (inv.date && (!cur.lastDate || inv.date > cur.lastDate)) cur.lastDate = inv.date;
    out[c] = cur;
  }
  for (const c of Object.keys(out)) {
    const cur = out[c];
    const returnsCredit = invs
      .filter((i) => i.currency === c)
      .reduce((s, i) => s + (returnsByInv.get(i.id) ?? 0), 0);
    // H2 fix: keep negative (credit) balances visible instead of clamping.
    // Returns reduce what is still owed — same as settle/voucher remaining.
    cur.remaining = cur.totalAmount - cur.totalPaid - returnsCredit;
    cur.avgInvoice = cur.invoicesCount ? round2dp(cur.totalAmount / cur.invoicesCount) : 0;
    cur.totalKg = Math.round(cur.totalKg);
  }
  return out;
}

/** Resolve a party's display name by kind + id from a party list. */
export function partyOf(
  kind: PartyKind,
  id: string,
  parties: { id: string; name: string }[],
): string | undefined {
  return parties.find((p) => p.id === id)?.name;
}

export { type LedgerType, type CashImpact } from "@/domain/types";
