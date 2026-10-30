// Read-only queries behind the sync screen and the local notifications: rejected documents and fabrics under their minimum.
import { sql } from "drizzle-orm";
import type { Phone } from "./phone";

export interface RejectedDocument {
  opId: string;
  entityType: string;
  number: string | null;
  reason: string | null;
  /** The rolls of a rejected invoice (a lost claim names them, FR-34). */
  rollIds: string[];
}

interface Executor {
  execute<R>(q: ReturnType<typeof sql>): Promise<{ rows: R[] }>;
}

function executor(phone: Phone): Executor {
  return phone.repos.db as unknown as Executor;
}

function numberOf(payload: unknown): string | null {
  try {
    const p = (typeof payload === "string" ? JSON.parse(payload) : payload) as Record<
      string,
      unknown
    >;
    for (const key of [
      "invoiceNumber",
      "voucherNumber",
      "returnNumber",
      "orderCode",
      "expenseNumber",
    ]) {
      if (typeof p[key] === "string") return p[key] as string;
    }
  } catch {
    // not JSON: no number
  }
  return null;
}

function rollIdsOf(payload: unknown): string[] {
  try {
    const p = (typeof payload === "string" ? JSON.parse(payload) : payload) as {
      rollIds?: unknown;
    };
    return Array.isArray(p.rollIds)
      ? p.rollIds.filter((x): x is string => typeof x === "string")
      : [];
  } catch {
    return [];
  }
}

/** Units the hub refused (claim lost, validation...): their local documents were rolled back, and nothing requeues them. */
export async function listRejectedDocuments(phone: Phone): Promise<RejectedDocument[]> {
  const { rows } = await executor(phone).execute<{
    op_id: string;
    entity_type: string;
    payload: unknown;
    error_detail: string | null;
  }>(
    sql`SELECT op_id, entity_type, payload, error_detail FROM sync_outbox WHERE status = 'rejected' ORDER BY seq`,
  );
  return rows.map((r) => ({
    opId: r.op_id,
    entityType: r.entity_type,
    number: numberOf(r.payload),
    reason: r.error_detail,
    rollIds: rollIdsOf(r.payload),
  }));
}

/** Names of fabrics whose remaining stock is below `minStockKg` (both are scaled integers on the same scale). */
export async function listLowStockFabrics(phone: Phone): Promise<string[]> {
  const { rows } = await executor(phone).execute<{ name: string }>(sql`
    SELECT f.name AS name FROM fabrics f
     WHERE f.tenant_id = ${phone.identity.tenantId} AND f.min_stock_kg > 0
       AND (SELECT COALESCE(SUM(r.remaining_kg), 0) FROM rolls r JOIN colors c ON c.id = r.color_id
             WHERE c.fabric_id = f.id AND r.status <> 'exhausted') < f.min_stock_kg
     ORDER BY f.name`);
  return rows.map((r) => r.name);
}
