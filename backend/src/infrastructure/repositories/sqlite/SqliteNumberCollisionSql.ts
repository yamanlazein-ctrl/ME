// PORTED-FROM: src/infrastructure/repositories/PostgresNumberCollisionSql.ts sha256=5fc04d3689427beaa374cd92fefd0200dda8d66b2582300039e2624e11be510d
// SQLite twin (specs/001-desktop-sqlite-engine S4). Keep behavior identical to the PG source.
/** PostgreSQL statements of the sync number-collision rule — moved verbatim from syncNumberCollision.ts (S1). */
import { sql } from "drizzle-orm";
import type { DB } from "../../orm/sqlite/drizzleCompat.js";
import type { CollisionTarget, INumberCollisionSql } from "../../../application/ports/INumberCollisionSql.js";

type Executor = Pick<DB, "execute">;
const q = (ident: string) => `"${ident.replace(/"/g, '""')}"`;

export const sqliteNumberCollisionSql: INumberCollisionSql = {
  async holderOf(executor, tenantId, spec: CollisionTarget, value, exceptId) {
    const database = executor as Executor;
    const scope = Object.entries(spec.scope)
      .map(([col, v]) => sql` AND ${sql.raw(q(col))} = ${v}`)
      .reduce((a, b) => sql`${a}${b}`, sql``);
    const r = await database.execute(sql`
    SELECT id AS id FROM ${sql.raw(q(spec.table))}
     WHERE tenant_id = ${tenantId} AND ${sql.raw(q(spec.column))} = ${value}
       AND id <> ${exceptId} ${scope}
     LIMIT 1`);
    const rows = (Array.isArray(r) ? r : ((r as { rows?: unknown[] }).rows ?? [])) as Array<{ id: string }>;
    return rows[0]?.id ?? null;
  },

  async renameValue(executor, tenantId, spec: CollisionTarget, holderId, newValue) {
    const database = executor as Executor;
    await database.execute(sql`
          UPDATE ${sql.raw(q(spec.table))} SET ${sql.raw(q(spec.column))} = ${newValue}
           WHERE tenant_id = ${tenantId} AND id = ${holderId}`);
  },

  async renameDerivedReceipt(executor, tenantId, invoiceId, oldNo, newNo) {
    const database = executor as Executor;
    await database.execute(sql`
    UPDATE vouchers SET number = ${`RCP-${newNo}`}
     WHERE tenant_id = ${tenantId} AND invoice_id = ${invoiceId} AND number = ${`RCP-${oldNo}`}`);
  },
};
