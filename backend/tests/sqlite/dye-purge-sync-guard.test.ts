/**
 * N-05 (ERP_VERIFIED_ISSUES_AND_REMEDIATION_PLAN): the dye purge is sync-exempt
 * (syncCoverage.ts "hub-authoritative"), so a purge on a device enrolled with a
 * hub silently diverges the devices. The purge route must REFUSE (409) while a
 * non-revoked sync device exists for the tenant, and allow it once none remain.
 *
 * RED first: run against the unmodified route — the enrollment case must fail
 * (the route purges today) before the guard is added.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import express from "express";

const root = mkdtempSync(join(tmpdir(), "motard-dye-"));
process.env.DB_ENGINE = "sqlite";
process.env.SQLITE_PATH = join(root, "data", "motard.db");
process.env.MOTARD_STARTUP_STATE = "FRESH";
process.env.MOTARD_INSTALLATION_ID ??= randomUUID();
process.env.MOTARD_INSTALL_INSTANCE_ID ??= randomUUID();
process.env.MOTARD_DATA_ID ??= randomUUID();
delete process.env.DATABASE_URL;
delete process.env.DESKTOP_SEED_PATH;
const TENANT = randomUUID();
const USER = randomUUID();

let server: Server;
let base = "";
let w: import("better-sqlite3").Database;
type Runtime = typeof import("@/infrastructure/orm/sqlite/runtime.js");
let runtime: Runtime;

async function json(r: Response): Promise<Record<string, unknown>> {
  try {
    return (await r.json()) as Record<string, unknown>;
  } catch {
    return {};
  }
}

beforeAll(async () => {
  runtime = await import("@/infrastructure/orm/sqlite/runtime.js");
  await runtime.ensureSqliteRuntime();
  w = runtime.getSqliteRuntime()!.conns.writer as unknown as import("better-sqlite3").Database;
  w.prepare(`INSERT INTO tenants (id, name, slug) VALUES (?, 'شركة الحجب', 'blk')`).run(TENANT);
  // A user row is required: registerOrTouch binds the enrolling user and the
  // FK on sync_device_authorized_users.user_id points at users.
  w.prepare(
    `INSERT INTO users (id, tenant_id, name, email, password_hash, role) VALUES (?, ?, 'مدير', 'owner@dye.test', 'x', 'admin')`,
  ).run(USER, TENANT);
  // One fabric (dye) to purge.
  w.prepare(
    `INSERT INTO fabrics (id, tenant_id, name, min_stock_kg, version) VALUES (?, ?, 'صبغة تجريبية', 0, 1)`,
  ).run(randomUUID(), TENANT);

  const { registerDyeRoutes } = await import("@/presentation/routes/dye.route.js");
  const { SqliteSyncDeviceRepository } = await import(
    "@/infrastructure/repositories/sqlite/SqliteSyncDeviceRepository.js"
  );
  const txMod = await import("@/infrastructure/orm/sqlite/transaction.js");
  const db = txMod.sqliteIndependentDb() as never;

  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { tenantContext: unknown }).tenantContext = {
      tenantId: TENANT,
      userRole: "admin",
      userId: USER,
    };
    next();
  });
  // The real Sqlite device repository against the same writer connection.
  const deviceRepo = new SqliteSyncDeviceRepository(db);
  app.use(
    "/api",
    (() => {
      const r = express.Router();
      registerDyeRoutes(
        r,
        (_req, _res, next) => next(), // auth: already injected above
        (_req, _res, next) => next(), // writeGuard: admin injected above
        (_req, _res, next) => next(), // readGuard
        { devices: deviceRepo },
      );
      return r;
    })(),
  );
  server = await new Promise<Server>((res) => {
    const s = app.listen(0, "127.0.0.1", () => res(s));
  });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}, 120_000);

afterAll(async () => {
  if (server) await new Promise((r) => server.close(r));
  runtime?.shutdownSqliteRuntime();
  rmSync(root, { recursive: true, force: true });
});

describe("dye purge sync-enrollment guard (N-05)", () => {
  it("REFUSES with 409 SYNC_DEVICES_ENROLLED while a non-revoked device is enrolled", async () => {
    // Enroll one device directly through the repository.
    const txMod2 = await import("@/infrastructure/orm/sqlite/transaction.js");
    const db2 = txMod2.sqliteIndependentDb() as never;
    const { SqliteSyncDeviceRepository } = await import(
      "@/infrastructure/repositories/sqlite/SqliteSyncDeviceRepository.js"
    );
    const repo = new SqliteSyncDeviceRepository(db2);
    await repo.registerOrTouch({
      tenantId: TENANT,
      userId: USER,
      deviceFingerprint: "fp-dye-guard-test",
      deviceFingerprintVersion: 1,
      platform: "windows",
      hostname: "test-host",
      label: "جهاز الاختبار",
    } as never);

    const fabrics = w.prepare(`SELECT id, name FROM fabrics WHERE tenant_id = ?`).all(TENANT) as Array<{ id: string; name: string }>;
    const fabric = fabrics[0];
    expect(fabric).toBeTruthy();

    const r = await fetch(`${base}/api/inventory/dyes/${fabric.id}/purge`, {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ confirmation: "تأكيد", reason: "اختبار الحجب" }),
    });
    expect(r.status).toBe(409);
    const body = await json(r);
    expect(body.code).toBe("SYNC_DEVICES_ENROLLED");

    // The fabric must still exist — nothing was purged.
    const still = w.prepare(`SELECT id FROM fabrics WHERE id = ?`).get(fabric.id);
    expect(still).toBeTruthy();
  }, 60_000);

  it("allows the purge once no non-revoked device remains", async () => {
    const txMod3 = await import("@/infrastructure/orm/sqlite/transaction.js");
    const db3 = txMod3.sqliteIndependentDb() as never;
    const { SqliteSyncDeviceRepository } = await import(
      "@/infrastructure/repositories/sqlite/SqliteSyncDeviceRepository.js"
    );
    const repo = new SqliteSyncDeviceRepository(db3);
    const devices = await repo.listForTenant(TENANT as never);
    for (const d of devices) {
      await repo.setRevoked(TENANT as never, d.id, true, "test teardown");
    }

    const fabrics = w.prepare(`SELECT id, name FROM fabrics WHERE tenant_id = ?`).all(TENANT) as Array<{ id: string; name: string }>;
    const fabric = fabrics[0];
    expect(fabric).toBeTruthy();

    const r = await fetch(`${base}/api/inventory/dyes/${fabric.id}/purge`, {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ confirmation: fabric.name, reason: "اختبار السماح" }),
    });
    expect(r.status).toBe(200);
    const gone = w.prepare(`SELECT id FROM fabrics WHERE id = ?`).get(fabric.id);
    expect(gone).toBeFalsy();
  }, 60_000);
});
