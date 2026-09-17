import { describe, it, expect, beforeAll } from "vitest";
import { pool } from "@/infrastructure/orm/drizzle.js";
import { ensureDesktopSchema } from "@/infrastructure/orm/ensureDesktopSchema.js";

let reachable = false;

describe("ensureDesktopSchema matches the current sync protocol", () => {
  beforeAll(async () => {
    try {
      await pool.query("select 1");
      reachable = true;
      await ensureDesktopSchema((sql) => pool.query(sql));
    } catch {
      reachable = false;
    }
  });

  it("has seq / received_seq / last_pull_seq, drops the old unique claim index, allows two qty claims", async () => {
    if (!reachable) return;

    const cols = await pool.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
        WHERE table_schema='public' AND (
          (table_name='sync_outbox' AND column_name='seq') OR
          (table_name='sync_inbox' AND column_name='received_seq') OR
          (table_name='sync_state' AND column_name='last_pull_seq') OR
          (table_name='sync_resource_claims' AND column_name='quantity_kg')
        )`,
    );
    expect(cols.rows.map((r) => r.column_name).sort()).toEqual(
      ["last_pull_seq", "quantity_kg", "received_seq", "seq"].sort(),
    );

    const oldIdx = await pool.query(
      `SELECT 1 FROM pg_indexes WHERE indexname = 'uq_sync_resource_claims_tenant_resource'`,
    );
    expect(oldIdx.rowCount ?? 0).toBe(0);

    const rls = await pool.query<{ relforcerowsecurity: boolean }>(
      `SELECT c.relforcerowsecurity FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname='public' AND c.relname='sync_resource_claims'`,
    );
    expect(rls.rows[0]?.relforcerowsecurity).toBe(true);

    const cutoffCol = await pool.query(
      `SELECT 1 FROM information_schema.columns
        WHERE table_schema='public' AND table_name='users' AND column_name='tokens_revoked_before'`,
    );
    expect(cutoffCol.rowCount).toBe(1);

    const tables = await pool.query(
      `SELECT table_name FROM information_schema.tables
        WHERE table_schema='public' AND table_name IN ('sync_tombstones','sync_conflicts')`,
    );
    expect(tables.rowCount).toBe(2);
  });
});
