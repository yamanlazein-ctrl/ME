import type { LedgerType, CashImpact, Currency } from "@/domain/types";
import type { PartyKind } from "@/domain/entities/Party";
import type { InvoiceData, InvoiceLineData } from "@/domain/entities/Invoice";
import { invoiceTotal } from "./invoiceCalc";

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
    avgPrice: r.totalKg > 0 ? Math.round(r.totalAmount / r.totalKg) : 0,
  }));
}

/** Build outstanding (unpaid) invoices for a party from real invoices + vouchers. */
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
): OutstandingRow[] {
  const rows: OutstandingRow[] = [];
  const paidByInvoice = new Map<string, number>();
  for (const v of vouchers) {
    if (v.status !== "active" || !v.invoiceId) continue;
    if (v.partyId !== partyId) continue;
    if (currency && v.currency !== currency) continue;
    paidByInvoice.set(v.invoiceId, (paidByInvoice.get(v.invoiceId) ?? 0) + v.amount);
  }
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  for (const inv of invoices) {
    if (inv.partyId !== partyId || !isActive(inv)) continue;
    if (currency && inv.currency !== currency) continue;
    const total = Math.round(invoiceTotal(inv));
    if (total <= 0) continue;
    const paid = Math.round(paidByInvoice.get(inv.id) ?? 0);
    const remaining = Math.max(0, total - paid);
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
): PartyStats {
  const expectedType = kind === "supplier" ? "entry" : "sale";
  let invs = invoices.filter(
    (i) => i.partyId === party.id && isActive(i) && i.type === expectedType,
  );
  if (currency) {
    invs = invs.filter((i) => i.currency === currency);
  }
  const totalAmount = invs.reduce((s, i) => s + Math.round(invoiceTotal(i)), 0);
  let partyVouchers = vouchers.filter(
    (v) =>
      v.partyId === party.id &&
      isActive(v) &&
      v.kind === (kind === "supplier" ? "payment" : "receipt"),
  );
  if (currency) {
    partyVouchers = partyVouchers.filter((v) => v.currency === currency);
  }
  const paid = partyVouchers.reduce((s, v) => s + v.amount, 0);
  const remaining = Math.max(0, totalAmount - paid);
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
    avgInvoice: invs.length ? Math.round(totalAmount / invs.length) : 0,
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
): Record<string, PartyStatsByCurrency> {
  const expectedType = kind === "supplier" ? "entry" : "sale";
  const invs = invoices.filter(
    (i) => i.partyId === party.id && isActive(i) && i.type === expectedType,
  );
  const partyVouchers = vouchers.filter(
    (v) =>
      v.partyId === party.id &&
      isActive(v) &&
      v.kind === (kind === "supplier" ? "payment" : "receipt"),
  );

  const out: Record<string, PartyStatsByCurrency> = {};
  for (const inv of invs) {
    const c = inv.currency;
    const cur = out[c] ?? {
      invoicesCount: 0, totalAmount: 0, totalPaid: 0, remaining: 0, avgInvoice: 0, totalKg: 0,
    };
    cur.invoicesCount += 1;
    cur.totalAmount += Math.round(invoiceTotal(inv));
    cur.totalKg += inv.lines.reduce((a, l) => a + l.quantityKg, 0);
    out[c] = cur;
  }
  for (const v of partyVouchers) {
    const c = v.currency ?? "SYP";
    const cur = out[c] ?? {
      invoicesCount: 0, totalAmount: 0, totalPaid: 0, remaining: 0, avgInvoice: 0, totalKg: 0,
    };
    cur.totalPaid += v.amount;
    out[c] = cur;
  }
  for (const c of Object.keys(out)) {
    const cur = out[c];
    cur.remaining = Math.max(0, cur.totalAmount - cur.totalPaid);
    cur.avgInvoice = cur.invoicesCount ? Math.round(cur.totalAmount / cur.invoicesCount) : 0;
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
