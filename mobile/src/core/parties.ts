// Customers and suppliers on the phone, as the desktop's party page shows them: search by name, code or phone, the balance
// per currency from the same statement totals (never summed across currencies), the side in the desktop's words, the
// party's documents, and its statement for a period.
import { and, asc, eq, or, sql } from "drizzle-orm";
import { ilikeContains } from "@backend/infrastructure/repositories/sqlite/helpers/likeContains";
import { parties } from "@backend/infrastructure/orm/sqlite/schemas/party.table";
import type { StatementEntryData } from "@backend/domain/entities/Statement";
import type { Phone } from "./phone";
import { loadFullStatement } from "./partyQueries";

export type PartyKind = "customer" | "supplier";

export interface PartyListRow {
  id: string;
  name: string;
  code: string | null;
  kind: PartyKind;
  phone: string | null;
  city: string | null;
  currency: string | null;
}

/** Active parties matching the name, code or any phone field (newest names first is not useful: alphabetical). */
export async function listParties(
  phone: Phone,
  query: { q: string; kind: PartyKind | ""; limit?: number },
): Promise<PartyListRow[]> {
  const tenantId = phone.identity.tenantId;
  const t = query.q.trim();
  const digits = t.replace(/[^\d]/g, "");
  const match = t
    ? or(
        ilikeContains(parties.name, t),
        ilikeContains(sql`COALESCE(${parties.code}, '')`, t),
        ilikeContains(sql`COALESCE(${parties.companyName}, '')`, t),
        digits.length >= 3
          ? or(
              ilikeContains(sql`REPLACE(COALESCE(${parties.phone}, ''), ' ', '')`, digits),
              ilikeContains(sql`REPLACE(COALESCE(${parties.mobile}, ''), ' ', '')`, digits),
              ilikeContains(sql`REPLACE(COALESCE(${parties.whatsapp}, ''), ' ', '')`, digits),
            )
          : undefined,
      )
    : undefined;
  const rows = await phone.repos.db
    .select({
      id: parties.id,
      name: parties.name,
      code: parties.code,
      kind: parties.kind,
      phone: parties.phone,
      mobile: parties.mobile,
      city: parties.city,
      currency: parties.currency,
    })
    .from(parties)
    .where(
      and(
        eq(parties.tenantId, tenantId),
        eq(parties.status, "active"),
        query.kind ? eq(parties.kind, query.kind) : undefined,
        match,
      ),
    )
    .orderBy(asc(parties.name))
    .limit(Math.min(200, query.limit ?? 100));
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    code: r.code ?? null,
    kind: r.kind === "supplier" ? "supplier" : "customer",
    phone: r.mobile || r.phone || null,
    city: r.city ?? null,
    currency: r.currency ?? null,
  }));
}

export type BalanceSide = "debit" | "credit" | "zero";

export interface CurrencyBalance {
  currency: string;
  balance: number;
  side: BalanceSide;
  totalDebit: number;
  totalCredit: number;
}

/** The desktop's words for a balance side (PartyDetails.tsx balanceSideLabel). */
export function balanceSideLabel(side: BalanceSide, kind: PartyKind): string {
  if (side === "zero") return "متوازن";
  if (kind === "customer") return side === "debit" ? "مدين (على العميل)" : "دائن (للعميل)";
  return side === "credit" ? "دائن (للمورد)" : "مدين (على المورد)";
}

function sideOf(balance: number, kind: PartyKind, side?: BalanceSide): BalanceSide {
  if (side) return side;
  if (Math.abs(balance) < 0.01) return "zero";
  return balance > 0 === (kind === "customer") ? "debit" : "credit";
}

/** Closing balance per currency from the statement totals (the desktop's figure), one entry per currency used. */
export async function partyBalances(
  phone: Phone,
  partyId: string,
  kind: PartyKind,
): Promise<CurrencyBalance[]> {
  const data = await phone.repos.statementRepo.getStatement(
    { partyId, kind, currency: "ALL", limit: 1 } as never,
    phone.context(),
  );
  return Object.entries(data.totalsByCurrency ?? {})
    .map(([currency, t]) => ({
      currency,
      balance: t.finalBalance,
      side: sideOf(t.finalBalance, kind, t.balanceSide),
      totalDebit: t.totalDebit,
      totalCredit: t.totalCredit,
    }))
    .sort((a, b) => a.currency.localeCompare(b.currency));
}

export interface PartyProfile {
  id: string;
  version: number;
  name: string;
  kind: PartyKind;
  code: string | null;
  companyName: string | null;
  phones: string[];
  email: string | null;
  city: string | null;
  address: string | null;
  currency: string | null;
  creditLimit: number | null;
  notes: string | null;
  balances: CurrencyBalance[];
}

export async function loadPartyProfile(phone: Phone, id: string): Promise<PartyProfile | null> {
  const p = await phone.repos.partyRepo.findById(id, phone.context());
  if (!p) return null;
  const kind: PartyKind = p.kind === "supplier" ? "supplier" : "customer";
  const x = p as unknown as Record<string, unknown>;
  const phones = [p.mobile, p.phone, x.whatsapp as string | null, x.altPhone as string | null]
    .filter((v): v is string => typeof v === "string" && v.trim() !== "")
    .filter((v, i, a) => a.indexOf(v) === i);
  return {
    id: p.id,
    version: Number(p.version ?? 0),
    name: p.name,
    kind,
    code: p.code ?? null,
    companyName: (x.companyName as string | null) ?? null,
    phones,
    email: (x.email as string | null) ?? null,
    city: (x.city as string | null) ?? null,
    address: (x.address as string | null) ?? null,
    currency: p.currency ?? null,
    creditLimit: x.creditLimit == null ? null : Number(x.creditLimit),
    notes: (x.notes as string | null) ?? null,
    balances: await partyBalances(phone, id, kind),
  };
}

export type PartyDocKind = "invoices" | "vouchers" | "returns";

export interface PartyDocRow {
  id: string;
  kind: "invoice" | "voucher" | "return";
  title: string;
  number: string;
  date: string;
  amount: number;
  currency: string;
  /** e.g. "متبقي 120.00" for an unpaid invoice. */
  note: string | null;
  cancelled: boolean;
}

const INVOICE_TITLE: Record<string, string> = { sale: "فاتورة بيع", entry: "فاتورة دخول" };
const VOUCHER_TITLE: Record<string, string> = { receipt: "سند قبض", payment: "سند صرف" };
const RETURN_TITLE: Record<string, string> = { sale: "مرتجع بيع", entry: "مرتجع دخول" };

/** The party's documents of one kind, newest first. */
export async function partyDocuments(
  phone: Phone,
  partyId: string,
  kind: PartyDocKind,
  limit = 50,
): Promise<PartyDocRow[]> {
  const ctx = phone.context();
  if (kind === "invoices") {
    const page = await phone.repos.invoiceRepo.list({ partyId, limit }, ctx);
    return page.data.map((i) => {
      const due = Number(i.amountDue ?? 0);
      return {
        id: i.id,
        kind: "invoice",
        title: INVOICE_TITLE[i.type] ?? "فاتورة",
        number: i.number,
        date: String(i.date).slice(0, 10),
        amount: Number(i.total),
        currency: i.currency,
        note: i.status === "cancelled" ? null : due > 0 ? `متبقي ${due.toFixed(2)}` : "مسددة",
        cancelled: i.status === "cancelled",
      };
    });
  }
  if (kind === "vouchers") {
    const page = await phone.repos.voucherRepo.list({ partyId, limit }, ctx);
    return page.data.map((v) => ({
      id: v.id,
      kind: "voucher",
      title: VOUCHER_TITLE[v.kind] ?? "سند",
      number: v.number,
      date: String(v.date).slice(0, 10),
      amount: Number(v.amount),
      currency: v.currency,
      note: null,
      cancelled: v.status === "cancelled",
    }));
  }
  const page = await phone.repos.returnRepo.list({ partyId, limit }, ctx);
  return page.data.map((r) => ({
    id: r.id,
    kind: "return",
    title: RETURN_TITLE[r.kind] ?? "مرتجع",
    number: r.number,
    date: String(r.date).slice(0, 10),
    amount: Number((r as { total?: number }).total ?? 0),
    currency: r.currency,
    note: null,
    cancelled: r.status === "cancelled",
  }));
}

/** The desktop's names of statement lines (src/core/calculations/ledgerCalc.ts LEDGER_TYPE_LABEL). */
export const STATEMENT_TYPE_LABEL: Record<string, string> = {
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
  settlement: "دفعة على الحساب",
};

export interface StatementQuery {
  partyId: string;
  kind: PartyKind;
  /** "ALL" or one currency. */
  currency: string;
  from: string | null;
  to: string | null;
}

export interface StatementResult {
  partyName: string;
  /** Per currency: balance before the period, debit/credit in it, closing balance. */
  totals: Array<{
    currency: string;
    previous: number;
    debit: number;
    credit: number;
    closing: number;
    side: BalanceSide;
  }>;
  entries: StatementEntryData[];
}

export async function loadStatement(phone: Phone, q: StatementQuery): Promise<StatementResult> {
  const full = await loadFullStatement(phone, {
    partyId: q.partyId,
    kind: q.kind,
    currency: q.currency,
    ...(q.from ? { from: q.from } : {}),
    ...(q.to ? { to: q.to } : {}),
  });
  const h = full.header;
  const byCurrency = h.totalsByCurrency ?? {};
  const totals = Object.entries(byCurrency)
    .filter(([c]) => q.currency === "ALL" || c === q.currency)
    .map(([currency, t]) => ({
      currency,
      previous: t.previousBalance,
      debit: t.totalDebit,
      credit: t.totalCredit,
      closing: t.finalBalance,
      side: sideOf(t.finalBalance, q.kind, t.balanceSide),
    }))
    .sort((a, b) => a.currency.localeCompare(b.currency));
  return { partyName: h.partyName, totals, entries: full.entries };
}
