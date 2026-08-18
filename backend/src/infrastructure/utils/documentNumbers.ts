import { db } from "../orm/drizzle.js";
import { documentSequences } from "../orm/schemas/document-sequence.table.js";
import { sql } from "drizzle-orm";

const PREFIXES: Record<string, string> = {
  invoice: "INV",
  return: "RET",
  voucher: "VOC",
  expense: "EXP",
  order: "ORD",
  print: "PRT",
  // H-6: the roll produced when a print job is received uses the same PRT
  // prefix as the print job's own document number, but is a DISTINCT
  // sequence (distinct entityType key) — otherwise the job-number counter
  // and the output-roll-number counter would become the same counter,
  // silently changing existing numbering semantics beyond what the race
  // fix requires.
  print_roll: "PRT",
  customer: "CUS",
  supplier: "SUP",
  settlement: "SET",
};

const WIDTHS: Record<string, number> = {
  invoice: 4,
  return: 4,
  voucher: 4,
  expense: 4,
  order: 4,
  print: 4,
  print_roll: 4,
};

/**
 * Generate the next sequential document number for a given entity type and tenant.
 *
 * Fix (forensic audit 2026-08-15, live-reproduced 3x — settlement, expense,
 * order): the previous implementation did SELECT ... FOR UPDATE, then
 * branched into either an UPDATE (row exists) or an INSERT (row doesn't
 * exist yet). The INSERT branch — hit on the FIRST-EVER document of any
 * entityType for a tenant — was a genuine race: two concurrent callers can
 * both run the SELECT, both see zero rows (nothing exists yet to lock),
 * and both attempt the INSERT. One succeeds; the other throws an
 * uncaught `23505` unique-violation on idx_doc_seq_tenant_entity_prefix,
 * which was never caught anywhere in the call chain and crashed the
 * entire Node process via an unhandled promise rejection.
 *
 * Fixed by collapsing the whole read-branch-write sequence into a single
 * atomic `INSERT ... ON CONFLICT (tenant_id, entity_type, prefix) DO
 * UPDATE ... RETURNING`. Postgres guarantees this upsert-increment is
 * race-free even when two transactions attempt it for the same key at the
 * exact same instant — there is no window where two callers can compute
 * the same next-number, and no window where a first-use race can throw.
 *
 * Format: `{PREFIX}-{YYYY}-{NNNN}`
 *
 * @param entityType - e.g. "invoice", "return", "voucher", "expense", "order"
 * @param tenantId  - UUID of the tenant
 * @returns         - formatted document number string
 */
export async function nextDocumentNumber(entityType: string, tenantId: string): Promise<string> {
  const prefix = PREFIXES[entityType] ?? entityType.toUpperCase();
  const width = WIDTHS[entityType] ?? 4;
  const year = new Date().getFullYear().toString();

  const [row] = await db
    .insert(documentSequences)
    .values({ tenantId, entityType, prefix, lastNumber: 1 })
    .onConflictDoUpdate({
      target: [documentSequences.tenantId, documentSequences.entityType, documentSequences.prefix],
      set: { lastNumber: sql`${documentSequences.lastNumber} + 1` },
    })
    .returning({ lastNumber: documentSequences.lastNumber });

  const padded = String(row.lastNumber).padStart(width, "0");
  return `${prefix}-${year}-${padded}`;
}
