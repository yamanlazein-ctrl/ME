import { sql, type SQL } from "drizzle-orm";
import type { DB } from "../orm/drizzle.js";
import type { TenantContext } from "../../domain/types/index.js";

/**
 * Invoice-tracking feed: sales/purchase invoices, returns, print jobs and
 * settlement batches in ONE server-paged list.
 *
 * The screen used to load every return, every print job and EVERY voucher of
 * the company into the browser (settlements were grouped client-side), then
 * appended all of them under each page of invoices. At 100k invoices that is
 * ~55k vouchers per visit, and each page repeated the whole history. Here each
 * document type is one SQL branch with the filters applied inside it (so each
 * branch uses its own indexes), merged, sorted by document date and paged; the
 * total is an exact count of the same branches.
 */
export type TrackKind = "entry" | "sale" | "return" | "print_send" | "print_receive" | "settlement";

export type DocumentTrackFilter = {
  type?: TrackKind | "all";
  status?: "all" | "active" | "cancelled" | "draft";
  partyId?: string;
  fromDate?: string;
  toDate?: string;
  search?: string;
  page?: number;
  limit?: number;
};

export type DocumentTrackRow = {
  kind: TrackKind;
  /** invoice/return/print-job id; for a settlement, its earliest voucher id. */
  id: string;
  number: string | null;
  date: string;
  createdAt: string;
  partyId: string | null;
  partyKind: "customer" | "supplier" | null;
  partyName: string | null;
  total: number | null;
  currency: string | null;
  status: string;
  quantityKg: number | null;
};

export type DocumentTrackPage = {
  data: DocumentTrackRow[];
  total: number;
  page: number;
  limit: number;
  hasNext: boolean;
};

// Same shape as src/lib/settlementBatches.ts (SET-YYYY-NNNN in the voucher notes).
const BATCH = "(?i)\\mSET-[0-9]{4}-[0-9]+\\M";

export class PostgresDocumentTrackRepository {
  constructor(private readonly db: DB) {}

  /**
   * One SQL branch per document type. `cap` (page end) bounds each branch for
   * the page query; `null` gives the uncapped branches for the exact count.
   */
  private branches(f: DocumentTrackFilter, ctx: TenantContext, cap: number | null): SQL[] {
    const t = ctx.tenantId;
    const type = f.type ?? "all";
    const status = f.status ?? "all";
    const want = (k: TrackKind) => type === "all" || type === k;
    const like = f.search?.trim()
      ? `%${f.search.trim().replace(/[\\%_]/g, (m) => `\\${m}`)}%`
      : null;
    const tail = (order: SQL) => (cap === null ? sql`` : sql` ORDER BY ${order} LIMIT ${cap}`);

    // Filters shared by every branch, expressed over the branch's own columns.
    // A print job has no party and no active/cancelled status: selecting a
    // party or a status excludes print jobs (the old screen ignored these
    // filters for print jobs and listed all of them anyway).
    const common = (cols: {
      date: SQL;
      party: SQL | null;
      number: SQL;
      name: SQL;
      status: SQL | null;
    }) => {
      const c: SQL[] = [];
      if (f.fromDate) c.push(sql`${cols.date} >= ${f.fromDate}`);
      if (f.toDate) c.push(sql`${cols.date} <= ${f.toDate}`);
      if (f.partyId) c.push(cols.party ? sql`${cols.party} = ${f.partyId}::uuid` : sql`false`);
      if (status !== "all") c.push(cols.status ? sql`${cols.status} = ${status}` : sql`false`);
      if (like)
        c.push(sql`(${cols.number} ILIKE ${like} OR coalesce(${cols.name}, '') ILIKE ${like})`);
      return c.length ? sql` AND ${sql.join(c, sql` AND `)}` : sql``;
    };

    const out: SQL[] = [];
    const invTypes = (["entry", "sale"] as const).filter((k) => want(k));
    if (invTypes.length) {
      out.push(sql`
        SELECT i.type AS kind, i.id, i.number, i.date, i.created_at, i.party_id,
               CASE WHEN i.type = 'entry' THEN 'supplier' ELSE 'customer' END AS party_kind,
               p.name AS party_name, i.total::numeric AS total, i.currency, i.status, NULL::numeric AS kg
          FROM invoices i LEFT JOIN parties p ON p.id = i.party_id
         WHERE i.tenant_id = ${t} AND i.type IN (${sql.join(
           invTypes.map((k) => sql`${k}`),
           sql`, `,
         )})
               ${common({ date: sql`i.date`, party: sql`i.party_id`, number: sql`i.number`, name: sql`p.name`, status: sql`i.status` })}
               ${tail(sql`i.date DESC, i.created_at DESC, i.id DESC`)}`);
    }
    if (want("return")) {
      out.push(sql`
        SELECT 'return' AS kind, r.id, r.number, r.date, r.created_at, r.party_id,
               CASE WHEN r.kind = 'entry' THEN 'supplier' ELSE 'customer' END AS party_kind,
               p.name AS party_name,
               (SELECT coalesce(sum(round(rl.quantity_kg * rl.price_per_kg, 2)), 0) FROM return_lines rl WHERE rl.return_id = r.id) AS total,
               r.currency, r.status, NULL::numeric AS kg
          FROM returns r LEFT JOIN parties p ON p.id = r.party_id
         WHERE r.tenant_id = ${t}
               ${common({ date: sql`r.date`, party: sql`r.party_id`, number: sql`r.number`, name: sql`p.name`, status: sql`r.status` })}
               ${tail(sql`r.date DESC, r.created_at DESC, r.id DESC`)}`);
    }
    const printKinds = (["print_send", "print_receive"] as const).filter((k) => want(k));
    if (printKinds.length) {
      const only =
        printKinds.length === 2
          ? sql``
          : printKinds[0] === "print_receive"
            ? sql`AND j.status = 'received'`
            : sql`AND j.status <> 'received'`;
      out.push(sql`
        SELECT CASE WHEN j.status = 'received' THEN 'print_receive' ELSE 'print_send' END AS kind,
               j.id, j.number, j.date, j.created_at, NULL::uuid AS party_id, NULL::text AS party_kind,
               j.press_name AS party_name, NULL::numeric AS total, j.currency,
               CASE WHEN j.status = 'received' THEN 'received' ELSE 'sent' END AS status, j.quantity_kg AS kg
          FROM print_jobs j
         WHERE j.tenant_id = ${t} ${only}
               ${common({ date: sql`j.date`, party: null, number: sql`coalesce(j.number, '')`, name: sql`j.press_name`, status: null })}
               ${tail(sql`j.date DESC, j.created_at DESC, j.id DESC`)}`);
    }
    if (want("settlement") && status !== "draft") {
      const batchStatus = sql`(CASE WHEN bool_or(v.status <> 'cancelled') THEN 'active' ELSE 'cancelled' END)`;
      out.push(sql`
        SELECT 'settlement' AS kind, (array_agg(v.id ORDER BY v.date, v.created_at, v.id))[1] AS id,
               v.batch AS number, min(v.date) AS date, min(v.created_at) AS created_at, v.party_id,
               v.party_kind, p.name AS party_name,
               sum(CASE WHEN v.status <> 'cancelled' THEN v.amount ELSE 0 END) AS total,
               min(v.currency) AS currency, ${batchStatus} AS status, NULL::numeric AS kg
          FROM (SELECT vv.*, upper(coalesce(substring(vv.notes_internal from ${BATCH}),
                                           substring(vv.notes_print from ${BATCH}))) AS batch
                  FROM vouchers vv
                 WHERE vv.tenant_id = ${t}
                   AND (vv.notes_internal ~* 'SET-[0-9]{4}-[0-9]+' OR vv.notes_print ~* 'SET-[0-9]{4}-[0-9]+')) v
          LEFT JOIN parties p ON p.id = v.party_id
         WHERE v.batch IS NOT NULL
         GROUP BY v.party_id, v.batch, v.party_kind, p.name
        HAVING true
               ${common({ date: sql`min(v.date)`, party: sql`v.party_id`, number: sql`v.batch`, name: sql`p.name`, status: batchStatus })}
               ${tail(sql`min(v.date) DESC, min(v.created_at) DESC`)}`);
    }
    return out;
  }

  async list(f: DocumentTrackFilter, ctx: TenantContext): Promise<DocumentTrackPage> {
    const limit = Math.min(200, Math.max(1, f.limit ?? 20));
    const page = Math.max(0, f.page ?? 0);
    const capped = this.branches(f, ctx, (page + 1) * limit);
    if (!capped.length) return { data: [], total: 0, page, limit, hasNext: false };
    const union = (bs: SQL[]) =>
      sql.join(
        bs.map((b) => sql`(${b})`),
        sql` UNION ALL `,
      );

    const pageRes = await this.db.execute(sql`
      SELECT kind, id, number, date::text AS date, created_at, party_id, party_kind, party_name,
             total::float AS total, currency, status, kg::float AS kg
        FROM (${union(capped)}) d
       ORDER BY d.date DESC, d.created_at DESC, d.id DESC
       LIMIT ${limit} OFFSET ${page * limit}`);
    const countRes = await this.db.execute(
      sql`SELECT count(*)::int AS n FROM (${union(this.branches(f, ctx, null))}) d`,
    );
    const rowsOf = (r: unknown) =>
      (Array.isArray(r) ? r : ((r as { rows?: unknown[] }).rows ?? [])) as Array<
        Record<string, unknown>
      >;
    const total = Number(rowsOf(countRes)[0]?.n ?? 0);
    const data: DocumentTrackRow[] = rowsOf(pageRes).map((r) => ({
      kind: r.kind as TrackKind,
      id: String(r.id),
      number: (r.number as string | null) ?? null,
      date: String(r.date).slice(0, 10),
      createdAt: new Date(r.created_at as string).toISOString(),
      partyId: (r.party_id as string | null) ?? null,
      partyKind: (r.party_kind as "customer" | "supplier" | null) ?? null,
      partyName: (r.party_name as string | null) ?? null,
      total: r.total == null ? null : Number(r.total),
      currency: (r.currency as string | null) ?? null,
      status: String(r.status),
      quantityKg: r.kg == null ? null : Number(r.kg),
    }));
    return { data, total, page, limit, hasNext: (page + 1) * limit < total };
  }
}
