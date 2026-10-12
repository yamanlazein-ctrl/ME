/**
 * CODEBASE_AUDIT_REPORT_hermes F-004 (regression guard). A table under FORCE ROW LEVEL SECURITY with
 * no policy returns nothing to the app role. On the migrated schema every forced table has ≥1 policy
 * (sync_state's is `sync_state_tenant_isolation`, 0051), and each table whose tenant_id is NULLABLE
 * has a platform-aware one. PostgreSQL only: SQLite has no RLS (app predicate instead, by design).
 */
import { describe, it, expect } from "vitest";
import { sql } from "drizzle-orm";
import { db } from "@/infrastructure/orm/drizzle.js";
import { pgOnly } from "./_helpers/engine.js";

type Row = { relname: string; tenant_not_null: boolean; policies: number; platform: number };

describe.skipIf(pgOnly)("FORCE-RLS tables", () => {
  it("every forced tenant table has a policy; nullable-tenant ones admit platform mode", async () => {
    const res = await db.execute(sql`
      select c.relname, a.attnotnull as tenant_not_null,
             (select count(*) from pg_policy p where p.polrelid = c.oid)::int as policies,
             (select count(*) from pg_policy p where p.polrelid = c.oid
                and pg_get_expr(p.polqual, p.polrelid) like '%platform_mode%')::int as platform
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      join pg_attribute a on a.attrelid = c.oid and a.attname = 'tenant_id' and not a.attisdropped
      where n.nspname = 'public' and c.relkind = 'r' and c.relforcerowsecurity`);
    const rows = ((res as unknown as { rows?: Row[] }).rows ?? (res as unknown as Row[])) as Row[];
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.filter((r) => r.policies === 0).map((r) => r.relname)).toEqual([]);
    expect(
      rows.filter((r) => !r.tenant_not_null && r.platform === 0).map((r) => r.relname),
    ).toEqual([]);
  });
});
