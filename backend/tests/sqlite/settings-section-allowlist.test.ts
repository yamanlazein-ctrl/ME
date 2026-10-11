/**
 * SS-01 (settings-sync trust gap): the sync path materializes an admin snapshot by calling
 * `updateSettingsUseCase(repo, section, data, ctx)` with a section name taken verbatim from the
 * unit payload (`syncMaterialize.ts:1955`). The repositories' `upsertSection` did
 * `setValues[section] = value` with NO allowlist — `ALLOWED_SECTIONS` was declared and never
 * referenced. A crafted unit could therefore write the protected `id` / `tenant_id` columns of
 * the `settings` row (or any future column), re-pointing a company's settings at another tenant.
 *
 * This test is RED before the fix: the protected sections must be refused, and every section the
 * `PUT /settings/:section` route accepts (incl. `drive`) must still work.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";

const root = mkdtempSync(join(tmpdir(), "motard-ss01-"));
process.env.DB_ENGINE = "sqlite";
process.env.SQLITE_PATH = join(root, "data", "motard.db");
process.env.MOTARD_STARTUP_STATE = "FRESH";
process.env.MOTARD_INSTALLATION_ID ??= randomUUID();
process.env.MOTARD_INSTALL_INSTANCE_ID ??= randomUUID();
process.env.MOTARD_DATA_ID ??= randomUUID();
delete process.env.DATABASE_URL;
delete process.env.DESKTOP_SEED_PATH;

const TENANT = randomUUID();
const OTHER_TENANT = randomUUID();

let runtime: typeof import("@/infrastructure/orm/sqlite/runtime.js");
let tx: typeof import("@/infrastructure/orm/sqlite/transaction.js");
let repo: import("@/infrastructure/repositories/sqlite/SqliteSettingsRepository.js").SqliteSettingsRepository;

const ctx = { tenantId: TENANT } as never;

beforeAll(async () => {
  runtime = await import("@/infrastructure/orm/sqlite/runtime.js");
  tx = await import("@/infrastructure/orm/sqlite/transaction.js");
  const { SqliteSettingsRepository } = await import("@/infrastructure/repositories/sqlite/SqliteSettingsRepository.js");
  await runtime.ensureSqliteRuntime();
  await tx.runInTransaction(async (t) => {
    await t.execute(sql`INSERT INTO tenants (id, name, slug) VALUES (${TENANT}, 'SS01', 'ss01')`);
    await t.execute(sql`INSERT INTO tenants (id, name, slug) VALUES (${OTHER_TENANT}, 'SS01-other', 'ss01-other')`);
  });
  repo = new SqliteSettingsRepository(runtime.getSqliteRuntime()!.conns.writerDb as never);
  // A settings row must exist before the attack tests: the `id` test correctly throws before any
  // write, so without this seed the later tests would read a null row and assert nothing.
  await repo.upsertSection("company", { name: "SS01" }, ctx);
});

afterAll(() => {
  runtime?.shutdownSqliteRuntime();
  rmSync(root, { recursive: true, force: true });
});

describe("SS-01: settings section allowlist", () => {
  it("refuses a protected column (id) instead of overwriting the row identity", async () => {
    const before = await repo.getSettings(ctx);
    await expect(repo.upsertSection("id", randomUUID(), ctx)).rejects.toThrow();
    const after = await repo.getSettings(ctx);
    expect(after).toEqual(before); // nothing changed
  });

  it("refuses tenant_id — a unit must not re-point settings at another tenant", async () => {
    await expect(repo.upsertSection("tenant_id", OTHER_TENANT, ctx)).rejects.toThrow();
    const after = await repo.getSettings(ctx);
    expect(after).not.toBeNull();
  });

  it("refuses an arbitrary/unknown section", async () => {
    await expect(repo.upsertSection("not_a_section", { x: 1 }, ctx)).rejects.toThrow();
  });

  it("still accepts every section the settings route allows, including drive", async () => {
    for (const section of ["company", "currencies", "paymentMethods", "taxes", "units", "warehouses", "printing", "drive"]) {
      await expect(repo.upsertSection(section, {}, ctx)).resolves.not.toThrow();
    }
  });
});
