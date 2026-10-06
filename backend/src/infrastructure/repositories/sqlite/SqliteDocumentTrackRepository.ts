// PORTED-FROM: src/infrastructure/repositories/PostgresDocumentTrackRepository.ts sha256=030e46793f30be083976449142003bccf649502a62ba73808dfc73aace71998b
// SQLite twin (specs/001-desktop-sqlite-engine S4). Keep behavior identical to the PG source.
import { mulRound, scaledText } from "./helpers/likeContains.js";
import { sql, type SQL } from "drizzle-orm";
import type { DB } from "../../orm/sqlite/drizzleCompat.js";
import type { TenantContext } from "../../../domain/types/index.js";

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
/** PG ARE m…M (word start/end) with (?i), as a JS regex over the same ASCII word characters. */
const BATCH_JS = "(?<![A-Za-z0-9_])SET-[0-9]{4}-[0-9]+(?![A-Za-z0-9_])";
void BATCH;

export class SqliteDocumentTrackRepository {
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
      if (f.partyId) c.push(cols.party ? sql`${cols.party} = ${f.partyId.toLowerCase()}` : sql`0`);
      if (status !== "all") c.push(cols.status ? sql`${cols.status} = ${status}` : sql`0`);
      if (like)
        c.push(sql`(${cols.number} LIKE ${like} ESCAPE '\\' OR coalesce(${cols.name}, '') LIKE ${like} ESCAPE '\\')`);
      return c.length ? sql` AND ${sql.join(c, sql` AND `)}` : sql``;
    };

    const out: SQL[] = [];
    const invTypes = (["entry", "sale"] as const).filter((k) => want(k));
    if (invTypes.length) {
      out.push(sql`
        SELECT i.type AS kind, i.id, i.number, i.date, i.created_at, i.party_id,
               CASE WHEN i.type = 'entry' THEN 'supplier' ELSE 'customer' END AS party_kind,
               p.name AS party_name, i.total AS total, i.currency, i.status, NULL AS kg
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
               (SELECT coalesce(sum(${mulRound(sql`rl.quantity_kg`, 2, sql`rl.price_per_kg`, 4, 2)}), 0) FROM return_lines rl WHERE rl.return_id = r.id) AS total,
               r.currency, r.status, NULL AS kg
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
               j.id, j.number, j.date, j.created_at, NULL AS party_id, NULL AS party_kind,
               j.press_name AS party_name, NULL AS total, j.currency,
               CASE WHEN j.status = 'received' THEN 'received' ELSE 'sent' END AS status, j.quantity_kg AS kg
          FROM print_jobs j
         WHERE j.tenant_id = ${t} ${only}
               ${common({ date: sql`j.date`, party: null, number: sql`coalesce(j.number, '')`, name: sql`j.press_name`, status: null })}
               ${tail(sql`j.date DESC, j.created_at DESC, j.id DESC`)}`);
    }
    if (want("settlement") && status !== "draft") {
      // bool_or(x) → max(x) over 0/1 (status is NOT NULL)
      const batchStatus = sql`(CASE WHEN max(v.status <> 'cancelled') THEN 'active' ELSE 'cancelled' END)`;
      out.push(sql`
        -- (array_agg(id ORDER BY date, created_at, id))[1]: min over fixed-width date(10)|created_at(27)|id
        SELECT 'settlement' AS kind, substr(min(v.date || '|' || v.created_at || '|' || v.id), 40) AS id,
               v.batch AS number, min(v.date) AS date, min(v.created_at) AS created_at, v.party_id,
               v.party_kind, p.name AS party_name,
               sum(CASE WHEN v.status <> 'cancelled' THEN v.amount ELSE 0 END) AS total,
               min(v.currency) AS currency, ${batchStatus} AS status, NULL AS kg
          FROM (SELECT vv.*, upper(coalesce(motard_re_substr(vv.notes_internal, ${BATCH_JS}, 'i'),
                                           motard_re_substr(vv.notes_print, ${BATCH_JS}, 'i'))) AS batch
                  FROM vouchers vv
                 WHERE vv.tenant_id = ${t}
                   AND (motard_re_match(vv.notes_internal, 'SET-[0-9]{4}-[0-9]+', 'i') OR motard_re_match(vv.notes_print, 'SET-[0-9]{4}-[0-9]+', 'i'))) v
          LEFT JOIN parties p ON p.id = v.party_id
         WHERE v.batch IS NOT NULL
         GROUP BY v.party_id, v.batch, v.party_kind, p.name
        HAVING 1
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
        // SQLite: a compound member cannot carry its own ORDER BY/LIMIT unless it is a subquery
        bs.map((b) => sql`SELECT * FROM (${b})`),
        sql` UNION ALL `,
      );

    const pageRes = await this.db.execute(sql`
      SELECT kind, id, number, date AS date, created_at, party_id, party_kind, party_name,
             total AS total, currency, status, kg AS kg
        FROM (${union(capped)}) d
       ORDER BY d.date DESC, d.created_at DESC, d.id DESC
       LIMIT ${limit} OFFSET ${page * limit}`);
    const countRes = await this.db.execute(
      sql`SELECT count(*) AS n FROM (${union(this.branches(f, ctx, null))}) d`,
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
      total: r.total == null ? null : Number(scaledText(r.total, 2)), // PG total::float = Number(numeric text)
      currency: (r.currency as string | null) ?? null,
      status: String(r.status),
      quantityKg: r.kg == null ? null : Number(scaledText(r.kg, 2)),
    }));
    return { data, total, page, limit, hasNext: (page + 1) * limit < total };
  }
}
