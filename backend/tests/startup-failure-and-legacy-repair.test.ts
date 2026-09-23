/**
 * Regression for the "server exits with code 1 on first start" report:
 *  1. an OLD database (licenses without tenant + devices bound to them) made migration DFP-013 refuse to run, the
 *     server died, and the real reason never reached server.log (only an unrelated deprecation warning did);
 *  2. every connection checkout issued two concurrent client.query() calls (pg deprecation warning).
 */
import { describe, it, expect, beforeAll } from "vitest";
import { randomUUID } from "node:crypto";
import { startupFailureReason } from "@/infrastructure/config/startupFailure.js";
import { repairLegacyLicenseTenantPairing } from "@/infrastructure/orm/runDesktopMigrations.js";
import { pool } from "@/infrastructure/orm/drizzle.js";

describe("startupFailureReason", () => {
  it("prefers the database's own message (drizzle keeps it in `cause`) and keeps only its first line", () => {
    const err = Object.assign(new Error("Failed query: -- DFP-013 …\nparams:"), {
      cause: new Error(
        "DFP-013: device_registrations has license rows with NULL or mismatched tenant_id\nCONTEXT: PL/pgSQL",
      ),
    });
    expect(startupFailureReason(err)).toBe(
      "DFP-013: device_registrations has license rows with NULL or mismatched tenant_id",
    );
  });
  it("falls back to the error message, then to String()", () => {
    expect(startupFailureReason(new Error("boom\nstack"))).toBe("boom");
    expect(startupFailureReason("plain")).toBe("plain");
  });
});

const deprecations: string[] = [];
process.on("warning", (w: Error) => deprecations.push(`${w.name}: ${w.message}`));

let reachable = false;
beforeAll(async () => {
  try {
    await pool.query("select 1");
    reachable = true;
  } catch {
    reachable = false;
  }
});

describe("repairLegacyLicenseTenantPairing (runs before migration DFP-013)", () => {
  it("claims an unowned license for the single tenant whose devices use it, and leaves ambiguous ones alone", async () => {
    if (!reachable) return;
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      // The composite FK exists in the test DB; the repair only matters while it does NOT (pre-migration state).
      await client.query(
        "ALTER TABLE device_registrations DROP CONSTRAINT IF EXISTS device_registrations_tenant_license_fk",
      );
      const t1 = randomUUID(),
        t2 = randomUUID(),
        lOne = randomUUID(),
        lBoth = randomUUID();
      for (const [id, slug] of [
        [t1, "a"],
        [t2, "b"],
      ] as const) {
        await client.query("INSERT INTO tenants (id,name,slug) VALUES ($1,$2,$3)", [
          id,
          `T-${slug}`,
          `t-${slug}-${id.slice(0, 6)}`,
        ]);
      }
      for (const [id, key] of [
        [lOne, "L1"],
        [lBoth, "L2"],
      ] as const) {
        await client.query(
          "INSERT INTO licenses (id,key,type,status) VALUES ($1,$2,'full','active')",
          [id, `${key}-${id.slice(0, 6)}`],
        );
      }
      const dev = (tenant: string, lic: string) =>
        client.query(
          "INSERT INTO device_registrations (tenant_id,license_id,device_id,device_fingerprint,name,platform) VALUES ($1,$2,$3,$4,'d','windows')",
          [tenant, lic, randomUUID(), randomUUID() + randomUUID().slice(0, 8)],
        );
      await dev(t1, lOne); // used only by tenant 1  -> repairable
      await dev(t1, lBoth); // used by two tenants   -> ambiguous, must stay unowned
      await dev(t2, lBoth);

      const claimed = await repairLegacyLicenseTenantPairing(client);
      expect(claimed).toBe(1);
      const owner = async (id: string) =>
        (await client.query("SELECT tenant_id FROM licenses WHERE id=$1", [id])).rows[0].tenant_id;
      expect(await owner(lOne)).toBe(t1);
      expect(await owner(lBoth)).toBeNull();
      // Idempotent
      expect(await repairLegacyLicenseTenantPairing(client)).toBe(0);
    } finally {
      await client.query("ROLLBACK");
      client.release();
    }
  });

  it("does nothing once the foreign key exists (fully migrated database)", async () => {
    if (!reachable) return;
    expect(await repairLegacyLicenseTenantPairing(pool)).toBe(0);
  });
});

describe("connection checkout", () => {
  it("does not trigger pg's 'client.query() while already executing a query' deprecation", () => {
    // The listener is attached at module load (below), BEFORE the first connection of this file is checked out:
    // pg emits this deprecation only once per process, on the first offending checkout.
    expect(deprecations.filter((w) => /already executing a query/.test(w))).toEqual([]);
  });
});
