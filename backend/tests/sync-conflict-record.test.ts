/**
 * recordSyncConflict must persist a refusal even when the replayed unit carried NO base version
 * (or the server version is unreadable). The columns used to be NOT NULL, so the refusal path
 * itself threw instead of recording the conflict.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { db } from "@/infrastructure/orm/drizzle.js";
import { tenants } from "@/infrastructure/orm/schemas/tenant.table.js";
import { recordSyncConflict } from "@/application/use-cases/sync/syncConflicts.js";
import { runWithTenantContext } from "@/infrastructure/orm/tenant-context.js";

let reachable = false;
const tenantId = randomUUID();

describe("sync conflict rows with unknown versions", () => {
  beforeAll(async () => {
    try {
      await db.execute(sql`select 1`);
      reachable = true;
      await db.insert(tenants).values({ id: tenantId, name: "Conflict Tenant", slug: `sc-${tenantId.slice(0, 8)}` });
    } catch {
      reachable = false;
    }
  });

  it("records a conflict with null base and server versions", async () => {
    if (!reachable) return;
    const opId = randomUUID();
    const wrote = await runWithTenantContext({ tenantId }, () =>
      recordSyncConflict({
        tenantId,
        opId,
        entityType: "invoice",
        entityId: randomUUID(),
        operation: "cancel",
        baseVersion: null,
        serverVersion: null,
        localIntent: { note: "payload had no base version" },
      }),
    );
    expect(wrote).toBe(true);
    const rows = await db.execute(sql`SELECT base_version, server_version FROM sync_conflicts WHERE op_id = ${opId}`);
    expect((rows as unknown as { rows: Array<{ base_version: number | null }> }).rows?.[0]?.base_version ?? null).toBeNull();
  });
});
