/**
 * Server-side report aggregates (100k-invoice scale).
 *
 * Every figure here reproduces EXACTLY the formula the report screens used to
 * compute in the browser over full row sets — only the place of computation
 * moved. Per-currency always (never blended), cancelled documents excluded,
 * the period filter is `date >= from` (from = null → all time):
 *
 *   sales / purchases   Σ invoices.total        (type sale / entry)
 *   paid / remaining    Σ invoices.paid,  Σ max(0, total − paid)   (per invoice)
 *   returns             Σ return_lines.quantity_kg × price_per_kg   (kind sale / entry)
 *   expenses            Σ expenses.amount
 *   ledger              Σ debit, Σ credit       (status <> cancelled)
 *   inventory value     Σ rolls.remaining_kg × price_per_kg, by roll currency
 *   top fabrics         Σ line quantity_kg, revenue Σ line qty × price (gross,
 *                       as the screen did) by invoice currency; rank by kg
 *   top customers       Σ invoices.total per party & currency
 *
 * invoices.total is the stored authority; it is written with the same shared
 * invoiceTotal() formula the screens used on the lines.
 */
import { sql, type SQL } from "drizzle-orm";
import { round2dp } from "@erp/shared";
import type { DB } from "../orm/drizzle.js";

export type ByCurrency = Record<string, number>;

type Row = Record<string, unknown>;

async function rows(db: DB, q: SQL): Promise<Row[]> {
  const r = await db.execute(q);
  return ((r as unknown as { rows?: Row[] }).rows ?? []) as Row[];
}

function toByCurrency(list: Row[], amountKey = "amount"): ByCurrency {
  const out: ByCurrency = {};
  for (const r of list) {
    const ccy = String(r.currency ?? "SYP");
    out[ccy] = round2dp((out[ccy] ?? 0) + Number(r[amountKey] ?? 0));
  }
  return out;
}

const fromCond = (col: SQL, from: string | null) =>
  from ? sql`AND ${col} >= ${from}::date` : sql``;

// ── Overview (reports index) ────────────────────────────────────────────────

export async function invoiceTotalsByCurrency(
  db: DB,
  tenantId: string,
  type: "sale" | "entry",
  from: string | null,
): Promise<{ total: ByCurrency; paid: ByCurrency; remaining: ByCurrency; count: number }> {
  const r = await rows(
    db,
    sql`SELECT currency,
               count(*)::int AS n,
               COALESCE(sum(total), 0) AS total,
               COALESCE(sum(paid), 0) AS paid,
               COALESCE(sum(GREATEST(0, total - paid)), 0) AS remaining
          FROM invoices
         WHERE tenant_id = ${tenantId}::uuid AND status <> 'cancelled' AND type = ${type}
           ${fromCond(sql`date`, from)}
         GROUP BY currency`,
  );
  return {
    total: toByCurrency(r, "total"),
    paid: toByCurrency(r, "paid"),
    remaining: toByCurrency(r, "remaining"),
    count: r.reduce((s, x) => s + Number(x.n ?? 0), 0),
  };
}

export async function returnTotalsByCurrency(
  db: DB,
  tenantId: string,
  kind: "sale" | "entry",
  from: string | null,
): Promise<{ total: ByCurrency; count: number }> {
  const r = await rows(
    db,
    sql`SELECT COALESCE(r.currency, 'SYP') AS currency,
               count(DISTINCT r.id)::int AS n,
               COALESCE(sum(rl.quantity_kg * rl.price_per_kg), 0) AS amount
          FROM returns r
          LEFT JOIN return_lines rl ON rl.return_id = r.id
         WHERE r.tenant_id = ${tenantId}::uuid AND r.status <> 'cancelled' AND r.kind = ${kind}
           ${fromCond(sql`r.date`, from)}
         GROUP BY COALESCE(r.currency, 'SYP')`,
  );
  return { total: toByCurrency(r), count: r.reduce((s, x) => s + Number(x.n ?? 0), 0) };
}

export async function expenseTotalsByCurrency(
  db: DB,
  tenantId: string,
  from: string | null,
): Promise<{ total: ByCurrency; count: number }> {
  const r = await rows(
    db,
    sql`SELECT currency, count(*)::int AS n, COALESCE(sum(amount), 0) AS amount
          FROM expenses
         WHERE tenant_id = ${tenantId}::uuid AND status <> 'cancelled'
           ${fromCond(sql`date`, from)}
         GROUP BY currency`,
  );
  return { total: toByCurrency(r), count: r.reduce((s, x) => s + Number(x.n ?? 0), 0) };
}

export async function inventoryValue(
  db: DB,
  tenantId: string,
): Promise<{ value: ByCurrency; totalKg: number; rollCount: number }> {
  const r = await rows(
    db,
    sql`SELECT currency, count(*)::int AS n,
               COALESCE(sum(remaining_kg * price_per_kg), 0) AS amount,
               COALESCE(sum(remaining_kg), 0) AS kg
          FROM rolls
         WHERE tenant_id = ${tenantId}::uuid
         GROUP BY currency`,
  );
  return {
    value: toByCurrency(r),
    totalKg: round2dp(r.reduce((s, x) => s + Number(x.kg ?? 0), 0)),
    rollCount: r.reduce((s, x) => s + Number(x.n ?? 0), 0),
  };
}

export async function inventoryByFabric(
  db: DB,
  tenantId: string,
): Promise<Array<{ fabricId: string; name: string; kg: number; rolls: number; value: ByCurrency }>> {
  const r = await rows(
    db,
    sql`SELECT f.id AS "fabricId", f.name, r.currency,
               COALESCE(sum(r.remaining_kg), 0) AS kg,
               count(r.id)::int AS n,
               COALESCE(sum(r.remaining_kg * r.price_per_kg), 0) AS amount
          FROM fabrics f
          LEFT JOIN colors c ON c.fabric_id = f.id AND c.tenant_id = f.tenant_id
          LEFT JOIN rolls r ON r.color_id = c.id AND r.tenant_id = f.tenant_id
         WHERE f.tenant_id = ${tenantId}::uuid
         GROUP BY f.id, f.name, r.currency
         ORDER BY f.name`,
  );
  const byFabric = new Map<
    string,
    { fabricId: string; name: string; kg: number; rolls: number; value: ByCurrency }
  >();
  for (const x of r) {
    const id = String(x.fabricId);
    const cur = byFabric.get(id) ?? { fabricId: id, name: String(x.name ?? ""), kg: 0, rolls: 0, value: {} };
    cur.kg = round2dp(cur.kg + Number(x.kg ?? 0));
    cur.rolls += Number(x.n ?? 0);
    if (x.currency != null) {
      const ccy = String(x.currency);
      cur.value[ccy] = round2dp((cur.value[ccy] ?? 0) + Number(x.amount ?? 0));
    }
    byFabric.set(id, cur);
  }
  return [...byFabric.values()];
}

export async function topFabrics(
  db: DB,
  tenantId: string,
  from: string | null,
  limit: number,
): Promise<Array<{ fabricId: string; name: string; qty: number; revenueByCurrency: ByCurrency }>> {
  const r = await rows(
    db,
    sql`WITH per AS (
          SELECT l.fabric_id, i.currency,
                 sum(l.quantity_kg) AS qty,
                 sum(l.quantity_kg * l.price_per_kg) AS revenue
            FROM invoice_lines l
            JOIN invoices i ON i.id = l.invoice_id
           WHERE i.tenant_id = ${tenantId}::uuid AND i.type = 'sale' AND i.status <> 'cancelled'
             ${fromCond(sql`i.date`, from)}
           GROUP BY l.fabric_id, i.currency
        ), ranked AS (
          SELECT fabric_id, sum(qty) AS total_qty FROM per GROUP BY fabric_id
           ORDER BY sum(qty) DESC, fabric_id LIMIT ${limit}
        )
        SELECT per.fabric_id AS "fabricId", f.name, per.currency, per.qty, per.revenue,
               ranked.total_qty
          FROM per
          JOIN ranked ON ranked.fabric_id = per.fabric_id
          LEFT JOIN fabrics f ON f.id = per.fabric_id
         ORDER BY ranked.total_qty DESC, per.fabric_id`,
  );
  const out = new Map<string, { fabricId: string; name: string; qty: number; revenueByCurrency: ByCurrency }>();
  for (const x of r) {
    const id = String(x.fabricId);
    const cur = out.get(id) ?? { fabricId: id, name: String(x.name ?? ""), qty: 0, revenueByCurrency: {} };
    cur.qty = round2dp(cur.qty + Number(x.qty ?? 0));
    const ccy = String(x.currency ?? "SYP");
    cur.revenueByCurrency[ccy] = round2dp((cur.revenueByCurrency[ccy] ?? 0) + Number(x.revenue ?? 0));
    out.set(id, cur);
  }
  return [...out.values()];
}

/**
 * Top customers by sale-invoice total. `order` reproduces each screen's own
 * ranking: "usdFirst" (overview: USD×1e9 + SYP + EUR) or "syp" (detail page).
 */
export async function topCustomers(
  db: DB,
  tenantId: string,
  from: string | null,
  limit: number,
  order: "usdFirst" | "syp",
): Promise<Array<{ partyId: string; name: string; revenueByCurrency: ByCurrency }>> {
  const score =
    order === "usdFirst"
      ? sql`sum(CASE WHEN currency = 'USD' THEN total ELSE 0 END) * 1e9
            + sum(CASE WHEN currency = 'SYP' THEN total ELSE 0 END)
            + sum(CASE WHEN currency = 'EUR' THEN total ELSE 0 END)`
      : sql`sum(CASE WHEN currency = 'SYP' THEN total ELSE 0 END)`;
  const r = await rows(
    db,
    sql`WITH per AS (
          SELECT party_id, currency, sum(total) AS total
            FROM invoices
           WHERE tenant_id = ${tenantId}::uuid AND type = 'sale' AND status <> 'cancelled'
             ${fromCond(sql`date`, from)}
           GROUP BY party_id, currency
        ), ranked AS (
          SELECT party_id, ${score} AS score FROM per GROUP BY party_id
           ORDER BY 2 DESC, party_id LIMIT ${limit}
        )
        SELECT per.party_id AS "partyId", p.name, per.currency, per.total, ranked.score
          FROM per
          JOIN ranked ON ranked.party_id = per.party_id
          LEFT JOIN parties p ON p.id = per.party_id
         ORDER BY ranked.score DESC, per.party_id`,
  );
  const out = new Map<string, { partyId: string; name: string; revenueByCurrency: ByCurrency }>();
  for (const x of r) {
    const id = String(x.partyId);
    const cur = out.get(id) ?? { partyId: id, name: String(x.name ?? ""), revenueByCurrency: {} };
    const ccy = String(x.currency ?? "SYP");
    cur.revenueByCurrency[ccy] = round2dp((cur.revenueByCurrency[ccy] ?? 0) + Number(x.total ?? 0));
    out.set(id, cur);
  }
  return [...out.values()];
}

export async function ledgerTotalsByCurrency(
  db: DB,
  tenantId: string,
  from: string | null,
): Promise<{ debit: ByCurrency; credit: ByCurrency; count: number }> {
  const r = await rows(
    db,
    sql`SELECT currency, count(*)::int AS n,
               COALESCE(sum(debit), 0) AS debit, COALESCE(sum(credit), 0) AS credit
          FROM ledger_entries
         WHERE tenant_id = ${tenantId}::uuid AND status <> 'cancelled'
           ${fromCond(sql`date`, from)}
         GROUP BY currency`,
  );
  return {
    debit: toByCurrency(r, "debit"),
    credit: toByCurrency(r, "credit"),
    count: r.reduce((s, x) => s + Number(x.n ?? 0), 0),
  };
}

// ── Paged detail rows ───────────────────────────────────────────────────────

export type Page = { page: number; limit: number };

export async function pagedRows(
  db: DB,
  tenantId: string,
  slug: string,
  from: string | null,
  { page, limit }: Page,
): Promise<{ rows: Row[]; total: number } | null> {
  const off = page * limit;
  const t = sql`${tenantId}::uuid`;
  let base: SQL;
  let order: SQL;
  switch (slug) {
    case "net-sales":
    case "purchases": {
      const type = slug === "net-sales" ? "sale" : "entry";
      base = sql`FROM invoices i LEFT JOIN parties p ON p.id = i.party_id
                 WHERE i.tenant_id = ${t} AND i.status <> 'cancelled' AND i.type = ${type}
                 ${fromCond(sql`i.date`, from)}`;
      order = sql`ORDER BY i.date DESC, i.created_at DESC, i.id`;
      const [data, cnt] = await Promise.all([
        rows(db, sql`SELECT i.id, i.number, i.date, i.created_at AS "createdAt", i.currency,
                            i.party_id AS "partyId", p.name AS "partyName",
                            i.total, i.paid, GREATEST(0, i.total - i.paid) AS remaining
                     ${base} ${order} LIMIT ${limit} OFFSET ${off}`),
        rows(db, sql`SELECT count(*)::int AS n ${base}`),
      ]);
      return { rows: data, total: Number(cnt[0]?.n ?? 0) };
    }
    case "sales-returns": {
      base = sql`FROM returns r LEFT JOIN parties p ON p.id = r.party_id
                 WHERE r.tenant_id = ${t} AND r.status <> 'cancelled' AND r.kind = 'sale'
                 ${fromCond(sql`r.date`, from)}`;
      const [data, cnt] = await Promise.all([
        rows(db, sql`SELECT r.id, r.number, r.kind, r.date, r.created_at AS "createdAt",
                            COALESCE(r.currency, 'SYP') AS currency,
                            r.party_id AS "partyId", p.name AS "partyName",
                            COALESCE((SELECT sum(rl.quantity_kg * rl.price_per_kg)
                                        FROM return_lines rl WHERE rl.return_id = r.id), 0) AS amount
                     ${base} ORDER BY r.date DESC, r.created_at DESC, r.id
                     LIMIT ${limit} OFFSET ${off}`),
        rows(db, sql`SELECT count(*)::int AS n ${base}`),
      ]);
      return { rows: data, total: Number(cnt[0]?.n ?? 0) };
    }
    case "expenses": {
      base = sql`FROM expenses e WHERE e.tenant_id = ${t} AND e.status <> 'cancelled'
                 ${fromCond(sql`e.date`, from)}`;
      const [data, cnt] = await Promise.all([
        rows(db, sql`SELECT e.id, e.date, e.created_at AS "createdAt", e.category,
                            e.description, e.amount, e.currency
                     ${base} ORDER BY e.date DESC, e.created_at DESC, e.id
                     LIMIT ${limit} OFFSET ${off}`),
        rows(db, sql`SELECT count(*)::int AS n ${base}`),
      ]);
      return { rows: data, total: Number(cnt[0]?.n ?? 0) };
    }
    case "ledger": {
      base = sql`FROM ledger_entries le WHERE le.tenant_id = ${t} AND le.status <> 'cancelled'
                 ${fromCond(sql`le.date`, from)}`;
      const [data, cnt] = await Promise.all([
        rows(db, sql`SELECT le.id, le.date, le.type, le.description,
                            le.reference_number AS "referenceNumber",
                            le.debit, le.credit, le.currency
                     ${base} ORDER BY le.date DESC, le.created_at DESC, le.id
                     LIMIT ${limit} OFFSET ${off}`),
        rows(db, sql`SELECT count(*)::int AS n ${base}`),
      ]);
      return { rows: data, total: Number(cnt[0]?.n ?? 0) };
    }
    case "cashbox": {
      base = sql`FROM manual_movements m WHERE m.tenant_id = ${t}
                 ${fromCond(sql`m.date`, from)}`;
      const [data, cnt] = await Promise.all([
        rows(db, sql`SELECT m.id, m.date, m.created_at AS "createdAt", m.type, m.direction,
                            m.description, m.amount, m.currency
                     ${base} ORDER BY m.created_at ASC, m.id
                     LIMIT ${limit} OFFSET ${off}`),
        rows(db, sql`SELECT count(*)::int AS n ${base}`),
      ]);
      return { rows: data, total: Number(cnt[0]?.n ?? 0) };
    }
    default:
      return null;
  }
}
