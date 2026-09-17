import type { PartyListStats } from "../../domain/entities/Party.js";

/**
 * One (partyId, currency) group row from the invoice-stats query in
 * PostgresPartyRepository.computeListStats. Extracted as a plain interface
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
export function aggregatePartyListStats(
  rows: PartyInvoiceStatsRow[],
): Map<string, PartyListStats> {
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

  const hasDefaultCurrencyRow = new Set<string>();

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
      hasDefaultCurrencyRow.add(r.partyId);
    }
  }

  // Parties with only non-default-currency invoices: surface that currency
  // in the money scalar fields so the list chip is not stuck at 0.
  for (const [partyId, s] of map) {
    if (!hasDefaultCurrencyRow.has(partyId) && s.byCurrency) {
      const first = Object.values(s.byCurrency)[0];
      if (first) {
        s.totalAmount = first.totalAmount;
        s.totalPaid = first.totalPaid;
        s.remaining = first.remaining;
      }
    }
  }

  return map;
}
