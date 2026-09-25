import { and, eq, isNotNull, sql } from "drizzle-orm";
import { round2dp } from "@erp/shared";
import type { DB, Tx } from "../orm/drizzle.js";
import { invoices } from "../orm/schemas/invoice.table.js";
import { ledgerEntries } from "../orm/schemas/ledger-entry.table.js";
import { returns } from "../orm/schemas/return.table.js";
import { returnLines } from "../orm/schemas/return-line.table.js";
import { BusinessRuleError } from "../../domain/errors/index.js";

/**
 * Customer credit (advance payments / overpayments), derived — never stored.
 *
 * The customer's ledger is always net: every receipt credits the party leg in
 * full, every sale invoice debits it in full. What the ledger cannot tell on its
 * own is how much of that credit is NOT yet attached to any invoice. With
 *
 *   B = ledger balance of the party in currency c   (debit − credit)
 *   R = Σ open remainder of its active invoices in c (total − paid − returns, ≥ 0)
 *
 * the party's unattached position is R − B:
 *   > 0 → unapplied credit the customer can spend on the next invoice
 *   < 0 → debt that is not tied to an open invoice (opening balance, adjustment)
 *
 * Deriving it this way means there is no second balance that can drift from the
 * ledger: an overpaid receipt raises it, applying credit to an invoice lowers
 * it (paid ↑ → R ↓), cancelling either restores it — all automatically.
 */
export type CustomerCreditPosition = {
  currency: string;
  /** Customer ledger balance (debit − credit). Negative = customer is in credit. */
  ledgerBalance: number;
  /** Σ open invoice remainders. */
  openInvoicesRemaining: number;
  /** R − B. Negative = debt not attached to an open invoice. */
  unattached: number;
  /** max(0, R − B): what may be applied to a new invoice. */
  availableCredit: number;
};

export async function customerCreditPosition(
  db: DB | Tx,
  tenantId: string,
  partyId: string,
  currency: string,
): Promise<CustomerCreditPosition> {
  const [bal] = await db
    .select({
      balance: sql<number>`COALESCE(SUM(${ledgerEntries.debit} - ${ledgerEntries.credit}), 0)`,
    })
    .from(ledgerEntries)
    .where(
      and(
        eq(ledgerEntries.tenantId, tenantId),
        eq(ledgerEntries.partyId, partyId),
        eq(ledgerEntries.currency, currency),
        eq(ledgerEntries.status, "active"),
        isNotNull(ledgerEntries.partyId),
      ),
    );

  // Per-invoice remainder, floored at 0: an invoice returned after being paid
  // in full has a negative raw remainder, and that return already credited the
  // ledger — flooring keeps it counted once, as credit.
  const returnsPerInvoice = db
    .select({
      invoiceId: returns.originalInvoiceId,
      total: sql<number>`SUM(ROUND(${returnLines.quantityKg} * ${returnLines.pricePerKg}, 2))`.as("rtotal"),
    })
    .from(returnLines)
    .innerJoin(returns, eq(returnLines.returnId, returns.id))
    .where(and(eq(returns.tenantId, tenantId), eq(returns.status, "active")))
    .groupBy(returns.originalInvoiceId)
    .as("r");

  const [open] = await db
    .select({
      remaining: sql<number>`COALESCE(SUM(GREATEST(0, ${invoices.total} - ${invoices.paid} - COALESCE(${returnsPerInvoice.total}, 0))), 0)`,
    })
    .from(invoices)
    .leftJoin(returnsPerInvoice, eq(returnsPerInvoice.invoiceId, invoices.id))
    .where(
      and(
        eq(invoices.tenantId, tenantId),
        eq(invoices.partyId, partyId),
        eq(invoices.currency, currency),
        eq(invoices.status, "active"),
      ),
    );

  const ledgerBalance = round2dp(Number(bal?.balance ?? 0));
  const openInvoicesRemaining = round2dp(Number(open?.remaining ?? 0));
  const unattached = round2dp(openInvoicesRemaining - ledgerBalance);
  return {
    currency,
    ledgerBalance,
    openInvoicesRemaining,
    unattached,
    availableCredit: Math.max(0, unattached),
  };
}

/**
 * Split what a receipt settles on an invoice into the part applied to the
 * invoice and the excess that stays as customer credit. Pure.
 */
export function splitOverpayment(
  settledInInvoiceCurrency: number,
  remaining: number,
): { applied: number; excess: number } {
  const room = Math.max(0, round2dp(remaining));
  // 0.01 tolerance mirrors the exact-closure rounding of the settlement math.
  if (settledInInvoiceCurrency <= room + 0.01) {
    return { applied: round2dp(settledInInvoiceCurrency), excess: 0 };
  }
  return { applied: room, excess: round2dp(settledInInvoiceCurrency - room) };
}

/**
 * Guard for reversals (voucher / invoice cancel) that remove credit: refuse when
 * the removed credit was already spent on another invoice (credit_applied), or
 * the books would show invoices "paid" by money that no longer exists.
 * `before`/`after` are the party's `unattached` position around the reversal.
 */
export async function assertCreditNotOverdrawn(
  db: DB | Tx,
  tenantId: string,
  partyId: string,
  currency: string,
  before: number,
  after: number,
): Promise<void> {
  if (after >= -0.01 || after >= before - 0.01) return;
  const [used] = await db
    .select({
      applied: sql<number>`COALESCE(SUM(${invoices.creditApplied}), 0)`,
    })
    .from(invoices)
    .where(
      and(
        eq(invoices.tenantId, tenantId),
        eq(invoices.partyId, partyId),
        eq(invoices.currency, currency),
        eq(invoices.status, "active"),
      ),
    );
  if (Number(used?.applied ?? 0) <= 0.01) return;
  throw new BusinessRuleError(
    `لا يمكن الإلغاء: جزء من هذا المبلغ (${round2dp(Math.min(0, before) - after)} ${currency}) ` +
      "استُخدم كرصيد دائن لتسديد فواتير لاحقة. ألغِ تلك الفواتير أو سجّل دفعة بديلة أولاً.",
  );
}
