// A phone core over a temp SQLite file for tests that need real repositories but no hub: tenant, admin and device are
// seeded the way enrolment does, and numbers are pre-allocated by the caller (no number blocks without a hub).
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { openNodeShim } from "./nodeSqlite";
import { closeRuntime, openRuntime } from "../../src/core/runtime";
import { createPhone, type Phone } from "../../src/core/phone";
import type { Role } from "../../src/core/roles";

export interface TestPhone {
  phone: Phone;
  dir: string;
  conn: ReturnType<typeof openNodeShim>;
  nextNumber(prefix: string): string;
  /** Gives this device a number block for the current year, as a hub claim would. */
  giveBlock(entityType: string, prefix: string, size?: number): Promise<void>;
  close(): void;
}

export async function makeTestPhone(role: Role = "admin"): Promise<TestPhone> {
  const dir = mkdtempSync(path.join(tmpdir(), "motard-phone-"));
  const conn = openNodeShim(path.join(dir, "phone.db"));
  const runtime = openRuntime(conn);
  const tenantId = randomUUID();
  const userId = randomUUID();
  const deviceId = randomUUID();
  conn.exec("PRAGMA foreign_keys = OFF");
  conn
    .prepare(
      "INSERT INTO tenants (id, name, slug, status, license_status, license_type) VALUES (?, 'Test', ?, 'active', 'no_license', 'trial')",
    )
    .run(tenantId, `t-${tenantId.slice(0, 8)}`);
  conn
    .prepare(
      "INSERT INTO users (id, tenant_id, name, email, password_hash, role, active) VALUES (?, ?, 'Test Admin', ?, 'x', ?, 1)",
    )
    .run(userId, tenantId, `${userId}@device.local`, role);
  conn.exec("PRAGMA foreign_keys = ON");
  const phone = createPhone(runtime, {
    tenantId,
    syncDeviceId: deviceId,
    user: { id: userId, name: "Test Admin", role },
  });
  await phone.repos.syncDeviceRepo.registerOrTouch({
    tenantId: tenantId as never,
    userId: userId as never,
    deviceFingerprint: "test-device",
    deviceFingerprintVersion: 1,
    platform: "android",
    hostname: "test",
    label: "test",
    deviceId: deviceId as never,
  });
  const counters = new Map<string, number>();
  return {
    phone,
    dir,
    conn,
    nextNumber(prefix) {
      const n = (counters.get(prefix) ?? 0) + 1;
      counters.set(prefix, n);
      return `${prefix}-2026-${String(n).padStart(4, "0")}`;
    },
    async giveBlock(entityType, prefix, size = 50) {
      await phone.repos.documentNumberBlockRepo.insertClaimed({
        tenantId: tenantId as never,
        syncDeviceId: deviceId as never,
        entityType,
        year: new Date().getFullYear(),
        prefix,
        startNumber: 1,
        endNumber: size,
      });
    },
    close() {
      closeRuntime(runtime);
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
