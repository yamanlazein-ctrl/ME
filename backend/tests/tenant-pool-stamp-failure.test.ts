/**
 * CODEBASE_AUDIT_REPORT M-05 — a checkout whose tenant-GUC stamp fails must give the connection back
 * (destroyed), or each failure leaks one and the pool starves. PostgreSQL only: the SQLite engine has
 * no connection pool (pgOnly — node-pg internals).
 */
import { describe, it, expect, vi } from "vitest";
import pg from "pg";
import { TenantScopedPool } from "../src/infrastructure/orm/drizzle.js";
import { config } from "../src/infrastructure/config/env.js";
import { pgOnly } from "./_helpers/engine.js";

describe.skipIf(pgOnly)("TenantScopedPool: stamping failure", () => {
  it("releases the client on both connect() forms; the 1-slot pool still serves the next checkout", async () => {
    // Built here, not in the describe body: collection runs on the SQLite engine too.
    const pool = new TenantScopedPool({
      connectionString: config.DATABASE_URL,
      max: 1,
      connectionTimeoutMillis: 2000,
    });
    const real = pg.Client.prototype.query;
    const spy = vi.spyOn(pg.Client.prototype, "query").mockImplementation(function (
      this: pg.Client,
      ...args: unknown[]
    ) {
      if (typeof args[0] === "string" && args[0].includes("set_config"))
        return Promise.reject(new Error("stamp failed")) as never;
      return (real as (...a: unknown[]) => unknown).apply(this, args) as never;
    });
    await expect(pool.connect()).rejects.toThrow("stamp failed");
    await expect(
      new Promise((resolve, reject) =>
        pool.connect((err, client) => (err ? reject(err) : resolve(client))),
      ),
    ).rejects.toThrow("stamp failed");
    spy.mockRestore();
    const client = await pool.connect(); // would time out if a failed checkout had leaked the only slot
    expect((await client.query("select 1 as n")).rows[0].n).toBe(1);
    client.release();
    await pool.end();
  });
});
