import { sql } from "drizzle-orm";
import type { DB } from "../../../infrastructure/orm/drizzle.js";

/** A db or an open transaction — anything that can execute SQL. */
type Executor = Pick<DB, "execute">;
import { runWithTenantContext } from "../../../infrastructure/orm/tenant-context.js";
import { logger } from "../../../infrastructure/config/logger.js";

/**
 * Deterministic resolution of human-number collisions during sync replay.
 *
 * Two DIFFERENT records can carry the same human number/code when they were
 * created on devices that numbered independently — typically a device used
 * standalone before it was paired (both start at 0001), or the same customer
 * name typed on two devices between syncs. The unique index then refused the
 * second record forever (it stayed "received" and never synced), and invoice
 * replay even treated "same number" as "already delivered" and DROPPED it.
 *
 * Rule, applied identically on the hub and on every device, whatever the
 * arrival order: the record with the smaller id keeps the number; the other
 * one gets a visible suffix derived from its own id. Every node that sees both
 * records reaches the same state, so the system converges without
 * coordination and no record is lost. Only sync replay uses this — a user who
 * types a duplicate locally still gets the normal refusal.
 */
type Spec = {
  table: string;
  column: string;
  /** Extra columns of the unique index, with the incoming values. */
  scope: Record<string, string>;
  /** How a losing value is disambiguated. */
  suffix: (value: string, id: string) => string;
};

const tag = (id: string) => id.replace(/-/g, "").slice(0, 4);
export const numberSuffix = (value: string, id: string) => `${value}-${tag(id)}`;
export const nameSuffix = (value: string, id: string) => `${value} (${tag(id)})`;

const q = (ident: string) => `"${ident.replace(/"/g, '""')}"`;

async function holderOf(
  database: Executor,
  tenantId: string,
  spec: Spec,
  value: string,
  exceptId: string,
): Promise<string | null> {
  const scope = Object.entries(spec.scope)
    .map(([col, v]) => sql` AND ${sql.raw(q(col))} = ${v}`)
    .reduce((a, b) => sql`${a}${b}`, sql``);
  const r = await database.execute(sql`
    SELECT id::text AS id FROM ${sql.raw(q(spec.table))}
     WHERE tenant_id = ${tenantId} AND ${sql.raw(q(spec.column))} = ${value}
       AND id <> ${exceptId}::uuid ${scope}
     LIMIT 1`);
  const rows = (Array.isArray(r) ? r : ((r as { rows?: unknown[] }).rows ?? [])) as Array<{ id: string }>;
  return rows[0]?.id ?? null;
}

/**
 * Returns the value the INCOMING record must use. When the incoming record
 * wins (smaller id), the existing holder is renamed in place (and `onRename`
 * lets the caller fix values derived from it).
 */
export async function resolveCollision(
  database: Executor,
  tenantId: string,
  spec: Spec,
  incomingId: string,
  value: string,
  onRename?: (holderId: string, oldValue: string, newValue: string) => Promise<void>,
): Promise<string> {
  return runWithTenantContext({ tenantId }, async () => {
    let candidate = value;
    for (let round = 0; round < 5; round++) {
      const holder = await holderOf(database, tenantId, spec, candidate, incomingId);
      if (!holder) return candidate;
      if (incomingId.toLowerCase() < holder.toLowerCase()) {
        // Incoming keeps the number; the existing record moves aside.
        let renamed = spec.suffix(candidate, holder);
        while (await holderOf(database, tenantId, spec, renamed, holder)) renamed = spec.suffix(renamed, holder);
        await database.execute(sql`
          UPDATE ${sql.raw(q(spec.table))} SET ${sql.raw(q(spec.column))} = ${renamed}
           WHERE tenant_id = ${tenantId} AND id = ${holder}::uuid`);
        if (onRename) await onRename(holder, candidate, renamed);
        logger.warn({ table: spec.table, holder, from: candidate, to: renamed }, "sync number collision: existing record renamed");
        return candidate;
      }
      const next = spec.suffix(candidate, incomingId);
      logger.warn({ table: spec.table, incomingId, from: candidate, to: next }, "sync number collision: incoming record renamed");
      candidate = next;
    }
    return candidate;
  });
}

/** A paid invoice's receipt is numbered `RCP-<invoice number>`; keep it in step. */
async function renameDerivedReceipt(database: Executor, tenantId: string, invoiceId: string, oldNo: string, newNo: string) {
  await database.execute(sql`
    UPDATE vouchers SET number = ${`RCP-${newNo}`}
     WHERE tenant_id = ${tenantId} AND invoice_id = ${invoiceId}::uuid AND number = ${`RCP-${oldNo}`}`);
}

/**
 * Apply the rule to a create unit's own number before it is replayed.
 * Mutates the payload so the replay stores the resolved number.
 */
export async function resolveDocumentNumberForReplay(
  database: Executor,
  entityType: string,
  payload: Record<string, unknown>,
  tenantId: string,
): Promise<void> {
  const s = (v: unknown) => (typeof v === "string" && v.length > 0 ? v : null);
  const createInput = (payload.createInput ?? {}) as Record<string, unknown>;
  let spec: Spec | null = null;
  let id: string | null = null;
  let field: string | null = null;
  if (entityType === "invoice") {
    id = s(payload.invoiceId);
    field = "invoiceNumber";
    const type = s(payload.invoiceType) ?? s(createInput.type);
    if (type) spec = { table: "invoices", column: "number", scope: { type }, suffix: numberSuffix };
  } else if (entityType === "voucher") {
    id = s(payload.voucherId);
    field = "voucherNumber";
    const kind = s(payload.voucherKind) ?? s(createInput.kind);
    if (kind) spec = { table: "vouchers", column: "number", scope: { kind }, suffix: numberSuffix };
  } else if (entityType === "return") {
    id = s(payload.returnId);
    field = "returnNumber";
    const kind = s(payload.returnKind) ?? s(createInput.kind);
    if (kind) spec = { table: "returns", column: "number", scope: { kind }, suffix: numberSuffix };
  } else if (entityType === "expense") {
    id = s(payload.expenseId);
    field = "expenseNumber";
    spec = { table: "expenses", column: "number", scope: {}, suffix: numberSuffix };
  }
  if (!spec || !id || !field) return;
  const value = s(payload[field]);
  if (!value) return;
  const resolved = await resolveCollision(
    database,
    tenantId,
    spec,
    id,
    value,
    entityType === "invoice"
      ? (holder, oldNo, newNo) => renameDerivedReceipt(database, tenantId, holder, oldNo, newNo)
      : undefined,
  );
  if (resolved !== value) {
    payload[field] = resolved;
    if ("preAllocatedNumber" in createInput) createInput.preAllocatedNumber = resolved;
  }
}

/** Party code/name and roll number of a dependency or master snapshot. */
export async function resolveMasterSnapshotForReplay(
  database: Executor,
  kind: "party" | "roll",
  snap: Record<string, unknown>,
  tenantId: string,
): Promise<void> {
  const id = typeof snap.id === "string" ? snap.id : null;
  if (!id) return;
  if (kind === "party") {
    if (typeof snap.code === "string" && snap.code) {
      snap.code = await resolveCollision(database, tenantId, { table: "parties", column: "code", scope: {}, suffix: numberSuffix }, id, snap.code);
    }
    if (typeof snap.name === "string" && snap.name) {
      snap.name = await resolveCollision(database, tenantId, { table: "parties", column: "name", scope: {}, suffix: nameSuffix }, id, snap.name);
    }
  } else if (typeof snap.rollNo === "string" && snap.rollNo) {
    snap.rollNo = await resolveCollision(database, tenantId, { table: "rolls", column: "roll_no", scope: {}, suffix: numberSuffix }, id, snap.rollNo);
  }
}
