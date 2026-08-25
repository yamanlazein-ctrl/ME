import { db, type Tx } from "../orm/drizzle.js";
import { documentSequences } from "../orm/schemas/document-sequence.table.js";
import { sql } from "drizzle-orm";

const PREFIXES: Record<string, string> = {
  invoice: "INV",
  // Entry (purchase) invoices get their own prefix AND their own sequence
  // counter — distinct entityType key below keeps the counters separate, so
  // the first entry invoice after this change is ENT-<year>-0001 while the
  // existing INV-<year>-NNNN sale-invoice counter continues untouched.
  invoice_entry: "ENT",
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
  invoice_entry: 4,
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

/**
 * In-transaction number allocation. Same atomic upsert as `nextDocumentNumber`,
 * but runs against a caller-provided `Tx` so the sequence increment and the
 * downstream insert share one transaction — if the downstream insert fails,
 * the rollback undoes the sequence bump as well. This is the fix for the
 * "failed save burns a number" pathology: a use-case that throws, a FK that
 * violates, a stock guard that rejects — none of them leave a gap in the
 * numbering because the increment was never committed.
 *
 * Race-free for the same reason as `nextDocumentNumber` (single
 * `INSERT ... ON CONFLICT DO UPDATE ... RETURNING` statement, which Postgres
 * serializes per-row), so concurrent callers in separate transactions still
 * receive distinct, consecutive numbers.
 */
export async function allocateDocumentNumber(
  tx: Tx,
  entityType: string,
  tenantId: string,
): Promise<string> {
  const { prefix, width } = resolveNumberFormat(entityType);
  const year = new Date().getFullYear().toString();

  const [row] = await tx
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

/**
 * Convenience wrapper: allocate a number inside the caller's transaction, then
 * invoke `fn` with the allocated number. The callback runs in the SAME
 * transaction, so any throw from `fn` rolls back the sequence increment.
 *
 * Use this when a single repository method needs both a new number and the
 * insert that consumes it. For repositories whose insert logic is already
 * a multi-statement transaction, prefer calling `allocateDocumentNumber`
 * directly at the top of the existing `db.transaction(async (tx) => ...)`
 * block.
 */
export async function withNumberedSequence<T>(
  tx: Tx,
  entityType: string,
  tenantId: string,
  fn: (number: string) => Promise<T>,
): Promise<T> {
  const number = await allocateDocumentNumber(tx, entityType, tenantId);
  return await fn(number);
}

function resolveNumberFormat(entityType: string): { prefix: string; width: number } {
  return {
    prefix: PREFIXES[entityType] ?? entityType.toUpperCase(),
    width: WIDTHS[entityType] ?? 4,
  };
}
