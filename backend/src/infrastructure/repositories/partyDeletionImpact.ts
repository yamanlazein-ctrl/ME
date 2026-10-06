import { and, desc, eq, ilike, inArray, lt, notInArray, or, sql, type SQL } from "drizzle-orm";
import type { Tx } from "../orm/drizzle.js";
import { parties } from "../orm/schemas/party.table.js";
import { invoices } from "../orm/schemas/invoice.table.js";
import { vouchers } from "../orm/schemas/voucher.table.js";
import { ledgerEntries } from "../orm/schemas/ledger-entry.table.js";
import { returns } from "../orm/schemas/return.table.js";
import { orders } from "../orm/schemas/order.table.js";

export type PartyLinkedKind = "invoice" | "voucher" | "return" | "order";

export type PartyLinkedDoc = {
  kind: PartyLinkedKind | "ledger";
  id: string;
  label: string;
  date?: string | null;
  /** Raw search/sort fields, so the dialog can show and filter on them. */
  number?: string | null;
  amount?: number | null;
  currency?: string | null;
};

export type PartyDeletionCounts = {
  invoices: number;
  vouchers: number;
  returns: number;
  orders: number;
  ledger: number;
};

export type PartyDeletionImpact = {
  partyId: string;
  partyName: string;
  kind: "customer" | "supplier";
  kindLabel: string;
  version: number;
  /**
   * EXACT counts of everything still linked and active. The preview arrays
   * below are capped; these numbers never are. The cascade decision, the
   * dialog's copy and the blocking rules are all derived from these counts,
   * so a party with 1000 invoices can never be described as having 100.
   */
  counts: PartyDeletionCounts;
  /** First few linked documents per kind — display only, never a work list. */
  invoices: PartyLinkedDoc[];
  vouchers: PartyLinkedDoc[];
  returns: PartyLinkedDoc[];
  orders: PartyLinkedDoc[];
  ledgerActiveCount: number;
  lastActivityDate: string | null;
  canDeleteDirectly: boolean;
  requiresCascade: boolean;
  summaryLines: string[];
  warning: string;
  /** The last 10 documents of the party (any kind, cancelled included), newest first — shown before deleting. */
  recentActivity: PartyRecentActivity[];
  /** Exact effect of the delete on the party balance and the cash box. */
  accounting: PartyDeletionAccounting;
};

/** How many documents of each kind the summary sheet previews. */
const PREVIEW_ROWS = 5;

/** Page size bounds for the linked-document browser. */
export const LINKED_DOCS_MIN_LIMIT = 5;
export const LINKED_DOCS_MAX_LIMIT = 100;
export const LINKED_DOCS_DEFAULT_LIMIT = 25;

function withEllipsis(rows: string[], n: number): string {
  const head = rows.slice(0, n).join("، ");
  return rows.length > n ? `${head}…` : head;
}

/**
 * Exact active counts per kind. One pass, four aggregates — cheap enough to run
 * on every dialog open, and the only number the decision logic trusts.
 */
async function computeCounts(
  tx: Tx,
  tenantId: string,
  partyId: string,
  kind: "customer" | "supplier",
): Promise<PartyDeletionCounts> {
  const [inv] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(invoices)
    .where(
      and(eq(invoices.partyId, partyId), eq(invoices.tenantId, tenantId), eq(invoices.status, "active")),
    );
  const [vch] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(vouchers)
    .where(
      and(eq(vouchers.partyId, partyId), eq(vouchers.tenantId, tenantId), eq(vouchers.status, "active")),
    );
  const [ret] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(returns)
    .where(
      and(eq(returns.partyId, partyId), eq(returns.tenantId, tenantId), eq(returns.status, "active")),
    );
  // Only OPEN orders block a party. A fulfilled or cancelled order is history:
  // counting it made the sheet say "مرتبط" (and refused the delete) for a party
  // the database has nothing active against — a false refusal. Terminal
  // statuses are excluded here, exactly as `returns` is filtered to 'active'.
  const [ord] =
    kind === "customer"
      ? await tx
          .select({ n: sql<number>`count(*)::int` })
          .from(orders)
          .where(
            and(
              eq(orders.customerId, partyId),
              eq(orders.tenantId, tenantId),
              notInArray(orders.status, ["fulfilled", "cancelled"]),
            ),
          )
      : [{ n: 0 }];
  const [led] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(ledgerEntries)
    .where(
      and(
        eq(ledgerEntries.partyId, partyId),
        eq(ledgerEntries.tenantId, tenantId),
        eq(ledgerEntries.status, "active"),
      ),
    );
  return {
    invoices: Number(inv?.n ?? 0),
    vouchers: Number(vch?.n ?? 0),
    returns: Number(ret?.n ?? 0),
    orders: Number(ord?.n ?? 0),
    ledger: Number(led?.n ?? 0),
  };
}

/**
 * Read-only impact sheet for customer/supplier delete. Never mutates.
 *
 * `canDeleteDirectly` = soft-cancel only (no active invoices/vouchers/returns/orders).
 * `requiresCascade` = active financial docs exist; confirmed delete must
 * cancel them via the existing invoice/voucher cancel paths first.
 *
 * The arrays are PREVIEWS. Anything that needs the full set (the cascade, the
 * operator's review list) must use `listPartyLinkedDocs` / `listActiveLinkedIds`,
 * never these.
 */
export async function computePartyDeletionImpact(
  tx: Tx,
  tenantId: string,
  partyId: string,
): Promise<PartyDeletionImpact> {
  const [party] = await tx
    .select({
      id: parties.id,
      name: parties.name,
      kind: parties.kind,
      version: parties.version,
      status: parties.status,
    })
    .from(parties)
    .where(and(eq(parties.id, partyId), eq(parties.tenantId, tenantId)))
    .limit(1);

  if (!party || party.status === "cancelled") {
    throw Object.assign(new Error("الطرف غير موجود أو محذوف مسبقاً"), {
      code: "PARTY_NOT_FOUND" as const,
    });
  }

  const kind = party.kind === "supplier" ? "supplier" : "customer";
  const kindLabel = kind === "supplier" ? "المورد" : "العميل";

  const counts = await computeCounts(tx, tenantId, partyId, kind);

  const invRows = await tx
    .select({
      id: invoices.id,
      number: invoices.number,
      type: invoices.type,
      date: invoices.date,
      total: invoices.total,
      currency: invoices.currency,
    })
    .from(invoices)
    .where(
      and(
        eq(invoices.partyId, partyId),
        eq(invoices.tenantId, tenantId),
        eq(invoices.status, "active"),
      ),
    )
    .orderBy(desc(invoices.date), desc(invoices.id))
    .limit(PREVIEW_ROWS);

  const vchRows = await tx
    .select({
      id: vouchers.id,
      number: vouchers.number,
      kind: vouchers.kind,
      date: vouchers.date,
      amount: vouchers.amount,
      currency: vouchers.currency,
    })
    .from(vouchers)
    .where(
      and(
        eq(vouchers.partyId, partyId),
        eq(vouchers.tenantId, tenantId),
        eq(vouchers.status, "active"),
      ),
    )
    .orderBy(desc(vouchers.date), desc(vouchers.id))
    .limit(PREVIEW_ROWS);

  const retRows = await tx
    .select({ id: returns.id, number: returns.number, date: returns.date })
    .from(returns)
    .where(
      and(
        eq(returns.partyId, partyId),
        eq(returns.tenantId, tenantId),
        eq(returns.status, "active"),
      ),
    )
    .orderBy(desc(returns.date), desc(returns.id))
    .limit(PREVIEW_ROWS);

  const orderRows =
    kind === "customer"
      ? await tx
          .select({ id: orders.id, code: orders.code, date: orders.date })
          .from(orders)
          .where(
            and(
              eq(orders.customerId, partyId),
              eq(orders.tenantId, tenantId),
              notInArray(orders.status, ["fulfilled", "cancelled"]),
            ),
          )
          .orderBy(desc(orders.date), desc(orders.id))
          .limit(PREVIEW_ROWS)
      : [];

  const invoicesDocs: PartyLinkedDoc[] = invRows.map((r) => ({
    kind: "invoice",
    id: r.id,
    date: r.date,
    number: r.number,
    amount: Number(r.total),
    currency: r.currency,
    label: `فاتورة ${r.type === "entry" ? "شراء/دخول" : "بيع/خروج"} رقم ${r.number} (${r.total} ${r.currency})`,
  }));
  const vouchersDocs: PartyLinkedDoc[] = vchRows.map((r) => ({
    kind: "voucher",
    id: r.id,
    date: r.date,
    number: r.number,
    amount: Number(r.amount),
    currency: r.currency,
    label: `سند ${r.kind === "receipt" || r.kind === "in" ? "قبض" : "صرف"} رقم ${r.number} (${r.amount} ${r.currency})`,
  }));
  const returnsDocs: PartyLinkedDoc[] = retRows.map((r) => ({
    kind: "return",
    id: r.id,
    date: r.date,
    number: r.number,
    label: `مرتجع رقم ${r.number}`,
  }));
  const ordersDocs: PartyLinkedDoc[] = orderRows.map((r) => ({
    kind: "order",
    id: r.id,
    date: r.date,
    number: r.code,
    label: `طلبية رقم ${r.code}`,
  }));

  const dates = [
    ...invRows.map((r) => r.date),
    ...vchRows.map((r) => r.date),
    ...retRows.map((r) => r.date),
  ].filter(Boolean) as string[];
  const lastActivityDate = dates.sort().at(-1) ?? null;

  const summaryLines: string[] = [];
  if (counts.invoices > 0) {
    const entry = invoicesDocs.filter((d) => d.label.includes("شراء")).length;
    const sale = counts.invoices - entry;
    if (sale > 0)
      summaryLines.push(
        `فواتير خروج/بيع نشطة: ${sale} — ${withEllipsis(
          invoicesDocs.filter((d) => d.label.includes("بيع")).map((d) => d.number ?? ""),
          4,
        )}`,
      );
    if (entry > 0)
      summaryLines.push(
        `فواتير دخول/شراء نشطة: ${entry} — ${withEllipsis(
          invoicesDocs.filter((d) => d.label.includes("شراء")).map((d) => d.number ?? ""),
          4,
        )}`,
      );
  }
  if (counts.vouchers > 0) summaryLines.push(`سندات قبض/صرف نشطة: ${counts.vouchers}`);
  if (counts.returns > 0)
    summaryLines.push(
      `مرتجعات نشطة يجب إلغاؤها أولاً: ${counts.returns} — ${withEllipsis(
        returnsDocs.map((d) => d.label),
        4,
      )}`,
    );
  if (counts.orders > 0)
    summaryLines.push(
      `طلبيات مفتوحة يجب إغلاقها أو إلغاؤها أولاً: ${counts.orders} — ${withEllipsis(
        ordersDocs.map((d) => d.label),
        4,
      )}`,
    );
  if (counts.ledger > 0) summaryLines.push(`حركات دفتر نشطة: ${counts.ledger}`);
  if (lastActivityDate) summaryLines.push(`آخر نشاط: ${lastActivityDate}`);

  // Every decision below is driven by the exact counts, never by the length of
  // a capped preview array.
  const hasCancellableFinancial = counts.invoices > 0 || counts.vouchers > 0;
  const hasBlockingDocs = counts.returns > 0 || counts.orders > 0;
  // Cascade path only when invoices/vouchers will be cancelled. Returns/orders
  // never cascade — they block until cancelled manually.
  const requiresCascade = hasCancellableFinancial;
  const canDeleteDirectly = !hasCancellableFinancial && !hasBlockingDocs;

  let warning: string;
  if (counts.returns > 0) {
    warning = `لا يمكن حذف ${kindLabel} الآن لوجود مرتجعات نشطة (${counts.returns}). ألغِ المرتجعات أولاً ثم أعد المحاولة.`;
  } else if (counts.orders > 0) {
    warning = `لا يمكن حذف ${kindLabel} الآن لوجود طلبيات مفتوحة (${counts.orders}). أغلق أو ألغِ الطلبيات أولاً ثم أعد المحاولة.`;
  } else if (requiresCascade) {
    warning = `إذا تابعت الحذف، سيتم إلغاء كل الفواتير (${counts.invoices}) والسندات (${counts.vouchers}) المرتبطة — عكس أثرها على الصندوق والحسابات والمخزون — ثم حذف ${kindLabel}. لا يمكن التراجع.`;
  } else {
    warning = `سيتم حذف ${kindLabel} «${party.name}». لا يمكن التراجع عن هذا الإجراء.`;
  }

  const recentActivity = await computeRecentActivity(tx, tenantId, partyId, kind);
  const accounting = await computeDeletionAccounting(tx, tenantId, partyId, kind, requiresCascade);

  return {
    partyId,
    partyName: party.name,
    kind,
    kindLabel,
    version: party.version ?? 1,
    counts,
    invoices: invoicesDocs,
    vouchers: vouchersDocs,
    returns: returnsDocs,
    orders: ordersDocs,
    ledgerActiveCount: counts.ledger,
    lastActivityDate,
    canDeleteDirectly,
    requiresCascade,
    summaryLines,
    warning,
    recentActivity,
    accounting,
  };
}

/* ── Deletion safety: recent activity + accounting effect ─────────────────── */

/** How many recent documents (all kinds, any status) the delete dialog shows. */
const RECENT_ACTIVITY_ROWS = 10;

export type PartyRecentActivity = PartyLinkedDoc & {
  /** `active`, `cancelled`, or an order status (`open`, `fulfilled`, …). */
  status: string;
};

/** An amount in one currency (2 dp). */
export type PartyMoney = { currency: string; amount: number };

export type PartyDeletionAccounting = {
  /** The party's balance now, per currency, standard sign (customer AR = debit − credit; supplier AP = credit − debit). */
  balanceNow: PartyMoney[];
  /** The balance left after the delete: a cascade reverses the party legs of every active invoice and voucher. */
  balanceAfter: PartyMoney[];
  /** How the cash box moves per currency if the delete goes ahead (negative = cash leaves the box). Empty = unchanged. */
  cashboxChange: PartyMoney[];
  affectsCashbox: boolean;
  affectsBalance: boolean;
};

const money = (e: SQL) => sql<string>`COALESCE(SUM(${e}), 0)`;
const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * The last RECENT_ACTIVITY_ROWS documents of the party across invoices, vouchers, returns and orders —
 * cancelled ones included (history), newest first (date, then creation time).
 */
async function computeRecentActivity(
  tx: Tx,
  tenantId: string,
  partyId: string,
  kind: "customer" | "supplier",
): Promise<PartyRecentActivity[]> {
  const n = RECENT_ACTIVITY_ROWS;
  const inv = await tx
    .select({ id: invoices.id, number: invoices.number, type: invoices.type, date: invoices.date, total: invoices.total, currency: invoices.currency, status: invoices.status, createdAt: invoices.createdAt })
    .from(invoices)
    .where(and(eq(invoices.partyId, partyId), eq(invoices.tenantId, tenantId)))
    .orderBy(desc(invoices.date), desc(invoices.createdAt))
    .limit(n);
  const vch = await tx
    .select({ id: vouchers.id, number: vouchers.number, kind: vouchers.kind, date: vouchers.date, amount: vouchers.amount, currency: vouchers.currency, status: vouchers.status, createdAt: vouchers.createdAt })
    .from(vouchers)
    .where(and(eq(vouchers.partyId, partyId), eq(vouchers.tenantId, tenantId)))
    .orderBy(desc(vouchers.date), desc(vouchers.createdAt))
    .limit(n);
  const ret = await tx
    .select({ id: returns.id, number: returns.number, date: returns.date, status: returns.status, createdAt: returns.createdAt })
    .from(returns)
    .where(and(eq(returns.partyId, partyId), eq(returns.tenantId, tenantId)))
    .orderBy(desc(returns.date), desc(returns.createdAt))
    .limit(n);
  const ord =
    kind === "customer"
      ? await tx
          .select({ id: orders.id, code: orders.code, date: orders.date, status: orders.status, createdAt: orders.createdAt })
          .from(orders)
          .where(and(eq(orders.customerId, partyId), eq(orders.tenantId, tenantId)))
          .orderBy(desc(orders.date), desc(orders.createdAt))
          .limit(n)
      : [];
  const cancelled = (s: string) => (s === "cancelled" ? " — ملغاة" : "");
  const all: Array<PartyRecentActivity & { at: number }> = [
    ...inv.map((r) => ({
      kind: "invoice" as const, id: r.id, date: r.date, number: r.number, amount: Number(r.total), currency: r.currency, status: r.status,
      label: `فاتورة ${r.type === "entry" ? "شراء/دخول" : "بيع/خروج"} رقم ${r.number} (${r.total} ${r.currency})${cancelled(r.status)}`,
      at: new Date(r.createdAt).getTime(),
    })),
    ...vch.map((r) => ({
      kind: "voucher" as const, id: r.id, date: r.date, number: r.number, amount: Number(r.amount), currency: r.currency, status: r.status,
      label: `سند ${r.kind === "receipt" || r.kind === "in" ? "قبض" : "صرف"} رقم ${r.number} (${r.amount} ${r.currency})${cancelled(r.status)}`,
      at: new Date(r.createdAt).getTime(),
    })),
    ...ret.map((r) => ({
      kind: "return" as const, id: r.id, date: r.date, number: r.number, status: r.status,
      label: `مرتجع رقم ${r.number}${cancelled(r.status)}`,
      at: new Date(r.createdAt).getTime(),
    })),
    ...ord.map((r) => ({
      kind: "order" as const, id: r.id, date: r.date, number: r.code, status: r.status,
      label: `طلبية رقم ${r.code}${cancelled(r.status)}`,
      at: new Date(r.createdAt).getTime(),
    })),
  ];
  all.sort((a, b) => (String(b.date ?? "") === String(a.date ?? "") ? b.at - a.at : String(b.date ?? "") < String(a.date ?? "") ? -1 : 1));
  return all.slice(0, n).map(({ at: _at, ...doc }) => doc);
}

/**
 * Exactly what the delete does to money. A plain delete (no active invoices/vouchers) only cancels the
 * party record: no ledger leg changes. A cascade cancels every active invoice and voucher of the party
 * through the existing cancel paths, which reverse their ledger legs — the party's legs (balance) and the
 * cash legs (cash box: `in` adds debit+credit to the box, `out` removes it, cancelling undoes that).
 */
async function computeDeletionAccounting(
  tx: Tx,
  tenantId: string,
  partyId: string,
  kind: "customer" | "supplier",
  requiresCascade: boolean,
): Promise<PartyDeletionAccounting> {
  const activeDocIds = or(
    inArray(
      ledgerEntries.referenceId,
      tx.select({ id: invoices.id }).from(invoices).where(and(eq(invoices.tenantId, tenantId), eq(invoices.partyId, partyId), eq(invoices.status, "active"))),
    ),
    inArray(
      ledgerEntries.referenceId,
      tx.select({ id: vouchers.id }).from(vouchers).where(and(eq(vouchers.tenantId, tenantId), eq(vouchers.partyId, partyId), eq(vouchers.status, "active"))),
    ),
  )!;
  const sign = kind === "supplier" ? -1 : 1;
  const partyLegs = await tx
    .select({
      currency: ledgerEntries.currency,
      debit: money(sql`${ledgerEntries.debit}`),
      credit: money(sql`${ledgerEntries.credit}`),
      reversedDebit: money(sql`CASE WHEN ${activeDocIds} THEN ${ledgerEntries.debit} ELSE 0 END`),
      reversedCredit: money(sql`CASE WHEN ${activeDocIds} THEN ${ledgerEntries.credit} ELSE 0 END`),
    })
    .from(ledgerEntries)
    .where(and(eq(ledgerEntries.partyId, partyId), eq(ledgerEntries.tenantId, tenantId), eq(ledgerEntries.status, "active")))
    .groupBy(ledgerEntries.currency);
  const cashLegs = requiresCascade
    ? await tx
        .select({
          currency: ledgerEntries.currency,
          net: money(sql`CASE WHEN ${ledgerEntries.cashImpact} = 'in' THEN COALESCE(${ledgerEntries.debit}, 0) + COALESCE(${ledgerEntries.credit}, 0) ELSE -(COALESCE(${ledgerEntries.debit}, 0) + COALESCE(${ledgerEntries.credit}, 0)) END`),
        })
        .from(ledgerEntries)
        .where(and(eq(ledgerEntries.tenantId, tenantId), eq(ledgerEntries.status, "active"), inArray(ledgerEntries.cashImpact, ["in", "out"]), activeDocIds))
        .groupBy(ledgerEntries.currency)
    : [];
  const balanceNow: PartyMoney[] = [];
  const balanceAfter: PartyMoney[] = [];
  for (const r of partyLegs) {
    const now = round2(sign * (Number(r.debit) - Number(r.credit)));
    const reversed = requiresCascade ? round2(sign * (Number(r.reversedDebit) - Number(r.reversedCredit))) : 0;
    balanceNow.push({ currency: r.currency, amount: now });
    balanceAfter.push({ currency: r.currency, amount: round2(now - reversed) });
  }
  const cashboxChange: PartyMoney[] = cashLegs
    .map((r) => ({ currency: r.currency, amount: round2(-Number(r.net)) }))
    .filter((m) => m.amount !== 0);
  return {
    balanceNow,
    balanceAfter,
    cashboxChange,
    affectsCashbox: cashboxChange.length > 0,
    affectsBalance: balanceNow.some((b, i) => b.amount !== balanceAfter[i]!.amount),
  };
}


/* ── Paged browsing of every linked document ──────────────────────────────── */

export type PartyLinkedDocsPage = {
  kind: PartyLinkedKind;
  items: PartyLinkedDoc[];
  /** EXACT number of matching active documents, never the page length. */
  total: number;
  limit: number;
  nextCursor: string | null;
};

/** `date` and `id` are both NOT NULL on every linked table, so a cursor is always a pair. */

/**
 * Only an ISO date may be compared against a `date` column. Handing Postgres
 * arbitrary search text for a date equality makes it attempt a cast and fail
 * the whole query ("invalid input syntax for type date"), so the date arm of
 * every search is gated on this.
 */
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
type LinkedCursor = { date: string; id: string } | null;

function decodeCursor(cursor: string | null | undefined): LinkedCursor {
  if (!cursor) return null;
  const at = cursor.lastIndexOf("~");
  if (at <= 0) return null;
  const date = cursor.slice(0, at);
  const id = cursor.slice(at + 1);
  if (!date || !id) return null;
  return { date, id };
}

function clampLimit(limit: number | undefined): number {
  if (!Number.isFinite(limit)) return LINKED_DOCS_DEFAULT_LIMIT;
  return Math.min(LINKED_DOCS_MAX_LIMIT, Math.max(LINKED_DOCS_MIN_LIMIT, Math.trunc(limit as number)));
}

/**
 * One page of the party's active documents, plus the exact total.
 *
 * Keyset pagination ordered `date DESC, id DESC`: the cursor carries the last
 * row's `(date, id)` and the predicate is the strict "after" of that ordering,
 * so pages never repeat or skip a row even while the cascade is cancelling
 * documents underneath. `q` is always a bound parameter, never interpolated.
 *
 * The dialog uses this so a party holding 1000 invoices can be reviewed
 * completely — 25 rows on screen, `total: 1000` next to the pager — instead of
 * materialising 1000 rows or silently showing only the first slice.
 */
export async function listPartyLinkedDocs(
  tx: Tx,
  tenantId: string,
  partyId: string,
  opts: {
    kind: PartyLinkedKind;
    partyKind: "customer" | "supplier";
    limit?: number;
    cursor?: string | null;
    q?: string;
  },
): Promise<PartyLinkedDocsPage> {
  const { kind, partyKind } = opts;
  const limit = clampLimit(opts.limit);
  const cur = decodeCursor(opts.cursor);
  const q = opts.q?.trim() || undefined;
  const like = `%${q ?? ""}%`;

  const empty: PartyLinkedDocsPage = { kind, items: [], total: 0, limit, nextCursor: null };
  // Orders only ever belong to a customer; a supplier has none by construction.
  if (kind === "order" && partyKind !== "customer") return empty;

  const invBase = and(
    eq(invoices.partyId, partyId),
    eq(invoices.tenantId, tenantId),
    eq(invoices.status, "active"),
  );
  const vchBase = and(
    eq(vouchers.partyId, partyId),
    eq(vouchers.tenantId, tenantId),
    eq(vouchers.status, "active"),
  );
  const retBase = and(
    eq(returns.partyId, partyId),
    eq(returns.tenantId, tenantId),
    eq(returns.status, "active"),
  );
  const ordBase = and(
    eq(orders.customerId, partyId),
    eq(orders.tenantId, tenantId),
    notInArray(orders.status, ["fulfilled", "cancelled"]),
  );

  type Row = { id: string; number: string; date: string; amount: number | null; currency: string | null; extra: string | null };
  let rows: Row[] = [];
  let total = 0;

  if (kind === "invoice") {
    // A date column compared against arbitrary text makes Postgres attempt a
    // cast and fail the whole query ("invalid input syntax for type date"), so
    // the date arm is only offered when the term really is an ISO date.
    const search = q
      ? or(
          ilike(invoices.number, like),
          ilike(invoices.reference, like),
          ISO_DATE.test(q) ? eq(invoices.date, q) : undefined,
          sql`${invoices.total}::text ILIKE ${like}`,
        )
      : undefined;
    const [c] = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(invoices)
      .where(and(invBase, search));
    total = Number(c?.n ?? 0);
    rows = await tx
      .select({
        id: invoices.id,
        number: invoices.number,
        date: invoices.date,
        amount: invoices.total,
        currency: invoices.currency,
        extra: invoices.type,
      })
      .from(invoices)
      .where(
        and(
          invBase,
          search,
          cur
            ? sql`(${invoices.date} < ${cur.date} OR (${invoices.date} = ${cur.date} AND ${invoices.id} < ${cur.id}))`
            : undefined,
        ),
      )
      .orderBy(desc(invoices.date), desc(invoices.id))
      .limit(limit);
  } else if (kind === "voucher") {
    const search = q
      ? or(
          ilike(vouchers.number, like),
          ISO_DATE.test(q) ? eq(vouchers.date, q) : undefined,
          sql`${vouchers.amount}::text ILIKE ${like}`,
        )
      : undefined;
    const [c] = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(vouchers)
      .where(and(vchBase, search));
    total = Number(c?.n ?? 0);
    rows = await tx
      .select({
        id: vouchers.id,
        number: vouchers.number,
        date: vouchers.date,
        amount: vouchers.amount,
        currency: vouchers.currency,
        extra: vouchers.kind,
      })
      .from(vouchers)
      .where(
        and(
          vchBase,
          search,
          cur
            ? sql`(${vouchers.date} < ${cur.date} OR (${vouchers.date} = ${cur.date} AND ${vouchers.id} < ${cur.id}))`
            : undefined,
        ),
      )
      .orderBy(desc(vouchers.date), desc(vouchers.id))
      .limit(limit);
  } else if (kind === "return") {
    const search = q
      ? or(ilike(returns.number, like), ISO_DATE.test(q) ? eq(returns.date, q) : undefined)
      : undefined;
    const [c] = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(returns)
      .where(and(retBase, search));
    total = Number(c?.n ?? 0);
    rows = await tx
      .select({
        id: returns.id,
        number: returns.number,
        date: returns.date,
        amount: sql<number>`NULL::numeric`,
        currency: sql<string | null>`NULL::varchar`,
        extra: sql<string | null>`NULL::varchar`,
      })
      .from(returns)
      .where(
        and(
          retBase,
          search,
          cur
            ? sql`(${returns.date} < ${cur.date} OR (${returns.date} = ${cur.date} AND ${returns.id} < ${cur.id}))`
            : undefined,
        ),
      )
      .orderBy(desc(returns.date), desc(returns.id))
      .limit(limit);
  } else {
    const search = q
      ? or(ilike(orders.code, like), ISO_DATE.test(q) ? eq(orders.date, q) : undefined)
      : undefined;
    const [c] = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(orders)
      .where(and(ordBase, search));
    total = Number(c?.n ?? 0);
    rows = await tx
      .select({
        id: orders.id,
        number: orders.code,
        date: orders.date,
        amount: sql<number>`NULL::numeric`,
        currency: sql<string | null>`NULL::varchar`,
        extra: sql<string | null>`NULL::varchar`,
      })
      .from(orders)
      .where(
        and(
          ordBase,
          search,
          cur
            ? sql`(${orders.date} < ${cur.date} OR (${orders.date} = ${cur.date} AND ${orders.id} < ${cur.id}))`
            : undefined,
        ),
      )
      .orderBy(desc(orders.date), desc(orders.id))
      .limit(limit);
  }

  const items: PartyLinkedDoc[] = rows.map((r) => ({
    kind,
    id: r.id,
    date: r.date,
    number: r.number,
    amount: r.amount === null ? null : Number(r.amount),
    currency: r.currency,
    label:
      kind === "invoice"
        ? `فاتورة ${r.extra === "entry" ? "شراء/دخول" : "بيع/خروج"} رقم ${r.number} (${r.amount} ${r.currency})`
        : kind === "voucher"
          ? `سند ${r.extra === "receipt" || r.extra === "in" ? "قبض" : "صرف"} رقم ${r.number} (${r.amount} ${r.currency})`
          : kind === "return"
            ? `مرتجع رقم ${r.number}`
            : `طلبية رقم ${r.number}`,
  }));

  const last = rows.at(-1);
  return {
    kind,
    items,
    total,
    limit,
    // A keyset cursor carries no offset, so the page cannot know it is the last
    // one: a page that exactly fills `limit` advertises a cursor and the client
    // stops when it has collected `total` items (one cheap request in the rare
    // exact-multiple case beats threading an offset through the cursor).
    nextCursor: rows.length === limit && last ? `${last.date}~${last.id}` : null,
  };
}

/**
 * EVERY active invoice/voucher id linked to a party — the cascade's work list.
 *
 * The cascade used to iterate the impact sheet, whose preview was capped at
 * 100 rows: a party with 150 invoices had 100 cancelled and 50 left ACTIVE,
 * pointing at a customer that was itself soft-cancelled. This walks the whole
 * set in bounded pages and hands back ids only, so a thousand documents cost
 * tens of kilobytes and nothing is left behind.
 */
export async function listActiveLinkedIds(
  tx: Tx,
  tenantId: string,
  partyId: string,
  partyKind: "customer" | "supplier",
  kind: "invoice" | "voucher",
): Promise<{ id: string; label: string }[]> {
  const out: { id: string; label: string }[] = [];
  let cursor: string | null = null;
  for (;;) {
    const page = await listPartyLinkedDocs(tx, tenantId, partyId, {
      kind,
      partyKind,
      limit: LINKED_DOCS_MAX_LIMIT,
      cursor,
    });
    for (const item of page.items) out.push({ id: item.id, label: item.label });
    // `total` is exact, so a full final page needs no extra round trip to
    // discover there is nothing after it.
    if (!page.nextCursor || page.items.length === 0 || out.length >= page.total) break;
    cursor = page.nextCursor;
  }
  return out;
}
