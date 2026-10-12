/**
 * Primary-device enforcement tests: exactly-one-coordinator semantics,
 * fail-closed behavior, and worker gating.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

process.env.DB_ENGINE = "sqlite";
process.env.SQLITE_PATH = join(mkdtempSync(join(tmpdir(), "motard-coord-")), "data", "motard.db");
process.env.MOTARD_STARTUP_STATE = "FRESH";
process.env.MOTARD_INSTALLATION_ID ??= randomUUID();
process.env.MOTARD_INSTALL_INSTANCE_ID ??= randomUUID();
process.env.MOTARD_DATA_ID ??= randomUUID();
delete process.env.DATABASE_URL;
delete process.env.DESKTOP_SEED_PATH;

let writerDb: unknown;
let tenantId: string;
let coord: typeof import("../src/infrastructure/googledrive/coordinator.js");

beforeAll(async () => {
  await import("../src/infrastructure/orm/sqlite/runtime.js").then((m) =>
    m.ensureSqliteRuntime({}),
  );
  const rt = (await import("../src/infrastructure/orm/sqlite/runtime.js")).getSqliteRuntime()!;
  writerDb = rt.conns.writerDb;
  coord = await import("../src/infrastructure/googledrive/coordinator.js");
  tenantId = randomUUID();
  rt.conns.writer
    .prepare(`INSERT INTO tenants (id, name, slug) VALUES (?, 'c', 'coord')`)
    .run(tenantId);
  rt.conns.writer
    .prepare(`INSERT INTO settings (id, tenant_id) VALUES (?, ?)`)
    .run(randomUUID(), tenantId);
});

describe("primary archive device (fail-closed)", () => {
  it("refuses everything when the feature is not enabled", async () => {
    const d = await coord.authorizeUploadDevice(writerDb as never, "device-a");
    expect(d).toEqual({ allowed: false, reason: "NOT_ENABLED" });
  });

  it("refuses when enabled but no coordinator designated", async () => {
    await coord.writeDriveSettings(writerDb as never, { archiveEnabled: true }, tenantId);
    const d = await coord.authorizeUploadDevice(writerDb as never, "device-a");
    expect(d).toEqual({ allowed: false, reason: "NO_COORDINATOR" });
  });

  it("allows only the designated coordinator", async () => {
    await coord.writeDriveSettings(
      writerDb as never,
      { archiveEnabled: true, coordinatorDeviceId: "device-a" },
      tenantId,
    );
    expect(await coord.authorizeUploadDevice(writerDb as never, "device-a")).toEqual({
      allowed: true,
    });
    const d = await coord.authorizeUploadDevice(writerDb as never, "device-b");
    expect(d).toEqual({ allowed: false, reason: "NOT_COORDINATOR" });
  });

  it("re-designation transfers the role: the old primary is refused", async () => {
    await coord.writeDriveSettings(
      writerDb as never,
      { coordinatorDeviceId: "device-b" },
      tenantId,
    );
    expect(await coord.authorizeUploadDevice(writerDb as never, "device-a")).toEqual({
      allowed: false,
      reason: "NOT_COORDINATOR",
    });
    expect(await coord.authorizeUploadDevice(writerDb as never, "device-b")).toEqual({
      allowed: true,
    });
  });

  it("disabling the feature fails closed even for the coordinator", async () => {
    await coord.writeDriveSettings(writerDb as never, { archiveEnabled: false }, tenantId);
    const d = await coord.authorizeUploadDevice(writerDb as never, "device-b");
    expect(d).toEqual({ allowed: false, reason: "NOT_ENABLED" });
  });

  it("absent settings row reads as empty (no crash, no upload)", async () => {
    // Delete the row and confirm the gate still fails closed.
    const rt = (await import("../src/infrastructure/orm/sqlite/runtime.js")).getSqliteRuntime()!;
    rt.conns.writer.prepare(`DELETE FROM settings`).run();
    const empty = await coord.readDriveSettings(writerDb as never);
    expect(empty).toEqual({});
    const d = await coord.authorizeUploadDevice(writerDb as never, "device-a");
    expect(d.allowed).toBe(false);
  });
});
