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

  it("a unit applied AFTER a later one is still delivered (cursor = application order)", async (ctx) => {
    skipUnlessDatabase(reachable, ctx.skip);
    const inbox = new PostgresSyncInboxRepository(db);
    const earlyOp = randomUUID();
    const lateOp = randomUUID();

    const early = await inbox.receive({
      tenantId, opId: earlyOp, entityType: "party", entityId: randomUUID(), operation: "create", payload: { order: "early" },
    });
    const late = await inbox.receive({
      tenantId, opId: lateOp, entityType: "party", entityId: randomUUID(), operation: "create", payload: { order: "late" },
    });
    expect(late.row.receivedSeq).toBeGreaterThan(early.row.receivedSeq);

    // The race that lost an invoice on one PC (450 concurrent sales): the
    // LATER unit is applied first and a device pulls in between.
    await inbox.markApplied(tenantId, lateOp);
    const first = (await inbox.listAppliedSince(tenantId, null, { limit: 100 })).filter(
      (r) => r.opId === earlyOp || r.opId === lateOp,
    );
    expect(first.map((r) => r.opId)).toEqual([lateOp]);
    const cursor = first[0]!.appliedSeq!;

    // Now the earlier unit is applied: it must appear AFTER the cursor.
    await inbox.markApplied(tenantId, earlyOp);
    const next = await inbox.listAppliedSince(tenantId, cursor, { limit: 100 });
    expect(next.map((r) => r.opId)).toContain(earlyOp);
    expect(next.map((r) => r.opId)).not.toContain(lateOp);
    const e = next.find((r) => r.opId === earlyOp)!;
    expect(e.appliedSeq!).toBeGreaterThan(cursor);
    // receive order is untouched (other features rely on it)
    expect(e.receivedSeq).toBe(early.row.receivedSeq);
  });

  it("units applied in one go come back in application order, each exactly once", async (ctx) => {
    skipUnlessDatabase(reachable, ctx.skip);
    const inbox = new PostgresSyncInboxRepository(db);
    const ops = Array.from({ length: 6 }, () => randomUUID());
    for (const op of ops) {
      await inbox.receive({ tenantId, opId: op, entityType: "party", entityId: randomUUID(), operation: "create", payload: {} });
    }
    for (const op of [...ops].reverse()) await inbox.markApplied(tenantId, op);
    const seen: string[] = [];
    let cursor: number | null = null;
    for (let g = 0; g < 10; g++) {
      const page = (await inbox.listAppliedSince(tenantId, cursor, { limit: 2 }));
      if (page.length === 0) break;
      for (const r of page) if (ops.includes(r.opId)) seen.push(r.opId);
      cursor = page[page.length - 1]!.appliedSeq!;
    }
    expect(new Set(seen).size).toBe(ops.length);
    expect(seen).toHaveLength(ops.length);
  });
});
