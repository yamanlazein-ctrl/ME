/**
 * Behavioral: pull cursor uses monotonic received_seq, not timestamps.
 *
 * Guards F-02: out-of-order apply times must not hide earlier-received units
 * once the cursor has advanced past their receive wall-clock.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { db } from "@/infrastructure/orm/drizzle.js";
import { runWithTenantContext, runWithPlatformContext } from "@/infrastructure/orm/tenant-context.js";
import { PostgresSyncInboxRepository } from "@/infrastructure/repositories/PostgresSyncInboxRepository.js";
import { databaseReachable, skipUnlessDatabase } from "./_helpers/requireDatabase.js";

let reachable = false;
let tenantId = "";

describe("sync behavioral — pull cursor / out-of-order arrival", () => {
  beforeAll(async () => {
    reachable = await databaseReachable();
    if (!reachable) return;
    tenantId = randomUUID();
    await runWithPlatformContext(async () => {
      await db.execute(sql`
        insert into tenants (id, name, slug, status, license_status, license_type)
        values (${tenantId}, 'Sync Pull Cursor Tenant', ${`spc-${tenantId.slice(0, 8)}`},
                'active', 'no_license', 'trial')
        on conflict (id) do nothing
      `);
    });
  });

  afterAll(async () => {
    if (!reachable || !tenantId) return;
    await runWithPlatformContext(async () => {
      await db.execute(sql`delete from sync_inbox where tenant_id = ${tenantId}`);
      await db.execute(sql`delete from tenants where id = ${tenantId}`);
    });
  });

  it("listAppliedSince returns units by received_seq even when applied out of order", async (ctx) => {
    skipUnlessDatabase(reachable, ctx.skip);
    const inbox = new PostgresSyncInboxRepository(db);
    const earlyOp = randomUUID();
    const lateOp = randomUUID();
    const entityEarly = randomUUID();
    const entityLate = randomUUID();

    const early = await inbox.receive({
      tenantId,
      opId: earlyOp,
      entityType: "party",
      entityId: entityEarly,
      operation: "create",
      payload: { order: "early" },
    });
    const late = await inbox.receive({
      tenantId,
      opId: lateOp,
      entityType: "party",
      entityId: entityLate,
      operation: "create",
      payload: { order: "late" },
    });
    expect(late.row.receivedSeq).toBeGreaterThan(early.row.receivedSeq);

    // Apply late first, then early — wall-clock apply order ≠ receive order.
    await inbox.markApplied(tenantId, lateOp);
    await new Promise((r) => setTimeout(r, 15));
    await inbox.markApplied(tenantId, earlyOp);

    const afterBeforeBoth = early.row.receivedSeq - 1;
    const page = await inbox.listAppliedSince(tenantId, afterBeforeBoth, { limit: 50 });
    const ours = page.filter((r) => r.opId === earlyOp || r.opId === lateOp);
    expect(ours.map((r) => r.opId)).toEqual([earlyOp, lateOp]);
    expect(ours[0]!.receivedSeq).toBeLessThan(ours[1]!.receivedSeq);

    // Cursor parked at early seq must still surface the later unit.
    const afterEarly = await inbox.listAppliedSince(tenantId, early.row.receivedSeq, {
      limit: 50,
    });
    expect(afterEarly.some((r) => r.opId === lateOp)).toBe(true);
    expect(afterEarly.some((r) => r.opId === earlyOp)).toBe(false);
  });
});
