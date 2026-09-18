/**
 * Conflict ledger: list returns local intent; resolve closes the row and
 * never mutates the underlying invoice (rebase is a NEW edit via the
 * normal update path, not an overwrite here).
 */
import { describe, expect, it, beforeAll } from "vitest";
import { randomUUID } from "node:crypto";
import { pool } from "../src/infrastructure/orm/drizzle.js";
import { runWithTenantContext } from "../src/infrastructure/orm/tenant-context.js";
import {
  listSyncConflicts,
  recordSyncConflict,
  resolveSyncConflict,
} from "../src/application/use-cases/sync/syncConflicts.js";

let reachable = false;
let tenantId = "";

describe("sync conflict resolution (no silent overwrite)", () => {
  beforeAll(async () => {
    try {
      await pool.query("select 1");
      const t = await pool.query<{ id: string }>(`SELECT id::text AS id FROM tenants LIMIT 1`);
      tenantId = t.rows[0]?.id ?? "";
      reachable = Boolean(tenantId);
      if (reachable) {
        await pool.query(`SELECT set_config('app.current_tenant_id', $1, false)`, [tenantId]);
      }
    } catch {
      reachable = false;
    }
  });

  it("keep-server and withdraw close the conflict; rebase returns serverVersion without applying intent", async () => {
    if (!reachable) return;

    await runWithTenantContext({ tenantId }, async () => {
      const invoiceId = randomUUID();
      const keepOp = randomUUID();
      const withdrawOp = randomUUID();
      const rebaseOp = randomUUID();

      await recordSyncConflict({
        tenantId,
        opId: keepOp,
        entityType: "invoice",
        entityId: invoiceId,
        operation: "update",
        baseVersion: 2,
        serverVersion: 3,
        localIntent: { notes: "device-a", exchangeRate: "12500" },
      });
      await recordSyncConflict({
        tenantId,
        opId: withdrawOp,
        entityType: "invoice",
        entityId: invoiceId,
        operation: "update",
        baseVersion: 2,
        serverVersion: 3,
        localIntent: { notes: "device-b" },
      });
      await recordSyncConflict({
        tenantId,
        opId: rebaseOp,
        entityType: "invoice",
        entityId: invoiceId,
        operation: "update",
        baseVersion: 2,
        serverVersion: 3,
        localIntent: { notes: "device-c-rebase" },
      });

      const listed = await listSyncConflicts(tenantId, { openOnly: true });
      const keepRow = listed.find((r) => r.opId === keepOp);
      expect(keepRow?.localIntent?.notes).toBe("device-a");
      expect(keepRow?.serverVersion).toBe(3);

      const invBefore = await pool.query(
        `SELECT COUNT(*)::int AS n FROM invoices WHERE id = $1 AND tenant_id = $2`,
        [invoiceId, tenantId],
      );

      const kept = await resolveSyncConflict(tenantId, keepRow!.id, "keep-server", null);
      expect(kept?.status).toBe("resolved");
      expect(kept?.resolution?.decision).toBe("keep-server");

      const withdrawRow = (await listSyncConflicts(tenantId, { openOnly: true })).find(
        (r) => r.opId === withdrawOp,
      );
      const withdrawn = await resolveSyncConflict(tenantId, withdrawRow!.id, "withdraw", null);
      expect(withdrawn?.status).toBe("resolved");
      expect(withdrawn?.resolution?.decision).toBe("withdraw");

      const rebaseListed = (await listSyncConflicts(tenantId, { openOnly: true })).find(
        (r) => r.opId === rebaseOp,
      );
      const rebased = await resolveSyncConflict(tenantId, rebaseListed!.id, "rebase", null);
      expect(rebased?.status).toBe("resolved");
      expect(rebased?.resolution?.decision).toBe("rebase");
      expect(rebased?.serverVersion).toBe(3);
      expect(rebased?.localIntent?.notes).toBe("device-c-rebase");

      const again = await resolveSyncConflict(tenantId, rebaseListed!.id, "keep-server", null);
      expect(again).toBeNull();

      const invAfter = await pool.query(
        `SELECT COUNT(*)::int AS n FROM invoices WHERE id = $1 AND tenant_id = $2`,
        [invoiceId, tenantId],
      );
      expect(invAfter.rows[0]?.n).toBe(invBefore.rows[0]?.n);

      const stillOpen = (await listSyncConflicts(tenantId, { openOnly: true })).filter((r) =>
        [keepOp, withdrawOp, rebaseOp].includes(r.opId),
      );
      expect(stillOpen).toEqual([]);
    });
  });
});
