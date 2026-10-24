/**
 * The archive documents, built from the DATABASE.
 *
 * The layout is the SHARED one (`@erp/shared` → `archiveDocuments.ts`): the same builders the
 * print path uses, so a printed invoice and an archived invoice cannot drift. This module only
 * assembles the DATA those builders need — it holds no HTML of its own.
 *
 * The backend builds the documents (not the frontend) because the backend is what owns the archive
 * pipeline and the data. The frontend would have to be awake and answering for the monthly
 * archive to work, which is not a thing to depend on.
 */
import { eq, inArray } from "drizzle-orm";
import {
  buildInvoiceBody,
  lineTotal,
  wrapArchiveDocument,
  type ArchiveInvoiceHeader,
  type ArchiveInvoiceLine,
} from "@erp/shared";
import { invoices } from "../orm/sqlite/schemas/invoice.table.js";
import { invoiceLines } from "../orm/sqlite/schemas/invoice-line.table.js";
import { parties } from "../orm/sqlite/schemas/party.table.js";
import { fabrics } from "../orm/sqlite/schemas/fabric.table.js";
import { colors } from "../orm/sqlite/schemas/color.table.js";
import { rolls } from "../orm/sqlite/schemas/roll.table.js";
import type { DB } from "../orm/sqlite/drizzleCompat.js";

/** The paper the archive prints on. */
const ARCHIVE_PAPER = "A4" as const;

/** `id → name` for the given ids only (a period of invoices must not load every roll per invoice). */
async function namesById(
  db: DB,
  table: typeof fabrics | typeof colors,
  ids: string[],
): Promise<Map<string, string>> {
  if (!ids.length) return new Map();
  const rows = await db
    .select({ id: table.id, name: table.name })
    .from(table)
    .where(inArray(table.id, ids));
  return new Map(rows.map((r) => [r.id, r.name]));
}

/**
 * The archive HTML of one invoice: the header, the party and every roll line.
 *
 * `invoiceId` is the business id — the same one the Drive upsert key is derived from, so an
 * edited invoice updates its own Drive file.
 */
export async function invoiceArchiveHtml(
  db: DB,
  invoiceId: string,
  kind: "sale" | "entry",
): Promise<{ html: string; number: string; fileStem: string } | null> {
  const [inv] = await db.select().from(invoices).where(eq(invoices.id, invoiceId)).limit(1);
  if (!inv) return null;
  const [party] = await db
    .select({ name: parties.name })
    .from(parties)
    .where(eq(parties.id, inv.partyId))
    .limit(1);
  const lines = await db.select().from(invoiceLines).where(eq(invoiceLines.invoiceId, invoiceId));

  // The line's fabric / colour / roll are references, not names: they are resolved here so the
  // archived document reads the way the printed one does.
  const unique = (xs: string[]) => [...new Set(xs)];
  const fabricNames = await namesById(db, fabrics, unique(lines.map((l) => l.fabricId)));
  const colorNames = await namesById(db, colors, unique(lines.map((l) => l.colorId)));
  const rollIds = unique(lines.map((l) => l.rollId));
  const rollNumbers = new Map(
    rollIds.length
      ? (
          await db
            .select({ id: rolls.id, rollNo: rolls.rollNo })
            .from(rolls)
            .where(inArray(rolls.id, rollIds))
        ).map((r) => [r.id, r.rollNo])
      : [],
  );

  const header: ArchiveInvoiceHeader = {
    kind,
    number: inv.number,
    date: inv.date,
    partyName: party?.name ?? "",
    currency: inv.currency,
    subtotal: Number(inv.subtotal ?? 0),
    discount: Number(inv.discount ?? 0),
    tax: Number(inv.tax ?? 0),
    shipping: Number(inv.shipping ?? 0),
    total: Number(inv.total ?? 0),
    paid: Number(inv.paid ?? 0),
    cancelled: inv.status === "cancelled",
    notes: inv.notes ?? null,
  };
  const body = buildInvoiceBody(
    header,
    lines.map((l): ArchiveInvoiceLine => {
      const quantityKg = Number(l.quantityKg ?? 0);
      const pricePerKg = Number(l.pricePerKg ?? 0);
      const discountAmount = Number(l.discountAmount ?? 0);
      return {
        fabric: fabricNames.get(l.fabricId) ?? "",
        color: colorNames.get(l.colorId) ?? "",
        rollNo: rollNumbers.get(l.rollId) ?? "",
        pieces: l.pieces ?? null,
        quantityKg,
        pricePerKg,
        discountAmount,
        // The line total is not stored: the shared rule (the one the invoice was totalled with),
        // max(0, round2dp(qty × price − line discount)).
        lineTotal: lineTotal({
          id: l.id,
          fabricId: l.fabricId,
          colorId: l.colorId,
          rollId: l.rollId,
          quantityKg,
          pricePerKg,
          discountAmount,
        }),
        note: l.note ?? null,
      };
    }),
  );
  const html = wrapArchiveDocument({
    title: `فاتورة ${inv.number}`,
    bodyHtml: body,
    paper: ARCHIVE_PAPER,
  });
  return {
    html,
    number: inv.number,
    fileStem: `${inv.date}_${inv.number}_${kind}`.replace(/[\\/:*?"<>|]/g, "_"),
  };
}
