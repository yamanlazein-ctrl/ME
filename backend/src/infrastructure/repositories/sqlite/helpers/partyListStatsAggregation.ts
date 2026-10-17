// PORTED-FROM: src/infrastructure/repositories/partyListStatsAggregation.ts sha256=3be88b218a154cef0170b7bcd46babb28da804d33b0077e1bc8c1ab55f70cf35
// SQLite twin (specs/001-desktop-sqlite-engine S4). Keep behavior identical to the PG source.
import type { PartyListStats } from "../../../../domain/entities/Party.js";

/**
 * One (partyId, currency) group row from the invoice-stats query in
 * SqlitePartyRepository.computeListStats. Extracted as a plain interface
 * (and the reduction below as a pure function) so the aggregation logic can
 * be unit-tested without a live database — the query itself just needs a
 * GROUP BY (partyId, currency), grouping is not worth re-deriving in a test.
 */
export interface PartyInvoiceStatsRow {
  partyId: string;
  /** The party's own default/display currency (`parties.currency`). */
  partyCurrency: string | null;
  /** The invoice currency this row's totals are denominated in. */
  currency: string | null;
  cnt: number;
  total: number;
  paid: number;
  lastDate: string | null;
}

/**
 * F09 (Phase 1 foundation audit) regression: `invoicesCount` used to only
 * count the party's default-currency invoices, so a customer with several
 * SYP invoices and one USD invoice showed a count one short — and the same
 * scalar was read by the customer-list "Total Sales" column, silently
 * dropping non-default-currency sales from the displayed total.
 *
 * `invoicesCount` is a plain count, not a monetary amount, so it is correct
 * to sum it across every currency. `totalAmount` / `totalPaid` / `remaining`
 * stay scoped to the party's own default currency — summing money amounts
 * across currencies would silently merge them, which the statement/list UI
 * must never do (mixed-currency totals are shown per-currency via
 * `byCurrency` instead).
 */
export function aggregatePartyListStats(rows: PartyInvoiceStatsRow[]): Map<string, PartyListStats> {
  const map = new Map<string, PartyListStats>();
  const get = (id: string): PartyListStats => {
    const existing = map.get(id);
    if (existing) return existing;
    const s: PartyListStats = {
      invoicesCount: 0,
      totalAmount: 0,
      totalPaid: 0,
      remaining: 0,
      byCurrency: {},
    };
    map.set(id, s);
    return s;
  };

  for (const r of rows) {
    const s = get(r.partyId);
    const total = r.total;
    const paid = r.paid;
    const remaining = total - paid;
    const ccy = r.currency ?? "SYP";
    s.byCurrency = s.byCurrency ?? {};
    s.byCurrency[ccy] = {
      invoicesCount: r.cnt,
      totalAmount: total,
      totalPaid: paid,
      remaining,
    };
    s.invoicesCount += r.cnt;
    if (r.lastDate && (!s.lastDate || r.lastDate > s.lastDate)) {
      s.lastDate = r.lastDate;
    }
    if (ccy === (r.partyCurrency ?? "SYP")) {
      s.totalAmount = total;
      s.totalPaid = paid;
      s.remaining = remaining;
    }
  }

  return map;
}

export interface PartyLedgerBalanceRow {
  partyId: string;
  currency: string | null;
  debit: number;
  credit: number;
}

/**
 * Overlay ledger remaining (statement source of truth) onto invoice aggregates.
 * Invoice totals stay as sales figures; `remaining` becomes debit−credit
 * (customer) or credit−debit (supplier) per currency so opening balances
 * and on-account vouchers are not dropped from the list.
 */
export function applyLedgerRemainingToPartyStats(
  stats: Map<string, PartyListStats>,
  ledgerRows: PartyLedgerBalanceRow[],
  kind: "customer" | "supplier",
  partyCurrencies: ReadonlyMap<string, string>,
): Map<string, PartyListStats> {
  // Invoice remainders are not balances. Reset even currencies with no active
  // ledger rows (for example, an opening replaced with zero).
  for (const s of stats.values()) {
    s.remaining = 0;
    for (const bucket of Object.values(s.byCurrency ?? {})) bucket.remaining = 0;
  }
  const sign = kind === "customer" ? 1 : -1;
  for (const r of ledgerRows) {
    const partyId = r.partyId;
    if (!partyId) continue;
    const existing = stats.get(partyId) ?? {
      invoicesCount: 0,
      totalAmount: 0,
      totalPaid: 0,
      remaining: 0,
      byCurrency: {},
    };
    if (!stats.has(partyId)) stats.set(partyId, existing);
    const ccy = r.currency ?? "SYP";
    const remaining = (r.debit - r.credit) * sign;
    existing.byCurrency = existing.byCurrency ?? {};
    const prev = existing.byCurrency[ccy] ?? {
      invoicesCount: 0,
      totalAmount: 0,
      totalPaid: 0,
      remaining: 0,
    };
    existing.byCurrency[ccy] = { ...prev, remaining };
  }

  // A scalar has no currency tag of its own: it must stay in the party's
  // default currency. Foreign balances are exposed only through byCurrency.
  for (const [partyId, s] of stats) {
    s.remaining = s.byCurrency?.[partyCurrencies.get(partyId) ?? "SYP"]?.remaining ?? 0;
  }
  return stats;
}
