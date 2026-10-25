import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { disconnectHub } from "@backend/application/use-cases/sync/hubConfig";
import { closeRuntime, openRuntime, type PhoneRuntime } from "../../src/core/runtime";
import { EnrollmentRefusedError, enroll, loadEnrollment } from "../../src/core/enrollment";
import { openNodeShim } from "../helpers/nodeSqlite";
import { clearHubFsMemory } from "../../src/platform/hubFs";
import { config } from "../../src/platform/envConfig";
import type { ShimDatabase } from "../../src/platform/sqlite/types";
import { store } from "../helpers/expoSecureStoreMemory";

const HUB_TENANT = "11111111-1111-4111-8111-111111111111";
const HUB_USER = "22222222-2222-4222-8222-222222222222";
let dir = "";
let conn: ShimDatabase;
let runtime: PhoneRuntime;

function hubFetch(codeOk: boolean) {
  return vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const json = (status: number, body: unknown) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      });
    if (url.endsWith("/api/health/live")) return json(200, { ok: true });
    if (url.endsWith("/api/setup/status")) return json(200, { isCompleted: true });
    if (url.endsWith("/api/license/status"))
      return json(200, { license: { key: "LIC-1", status: "active" } });
    if (url.endsWith("/api/sync/enroll")) {
      if (!codeOk)
        return json(401, { code: "ENROLL_CODE_INVALID", message: "رمز التسجيل غير صحيح" });
      const body = JSON.parse(String(init?.body)) as { device: { id: string } };
      return json(201, {
        ok: true,
        tenantId: HUB_TENANT,
        deviceId: body.device.id,
        deviceSecret: "s".repeat(43),
        accessToken: "access-enrolled-xxxx",
        refreshToken: "refresh-enrolled",
        user: { id: HUB_USER, name: "المدير", role: "admin" },
      });
    }
    return json(404, {});
  });
}

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "motard-enroll-"));
  conn = openNodeShim(path.join(dir, "motard.db"));
  runtime = openRuntime(conn);
  store.clear();
  clearHubFsMemory();
});
afterEach(() => {
  vi.unstubAllGlobals();
  disconnectHub();
  closeRuntime(runtime);
  rmSync(dir, { recursive: true, force: true });
});

describe("enroll (T062)", () => {
  it("exchanges the code, fixes the tenant locally and stores the enrolment", async () => {
    vi.stubGlobal("fetch", hubFetch(true));
    const e = await enroll(runtime, conn, {
      hubUrl: "https://hub.example",
      code: " ABCD-EFGH-JKLM ",
      appVersion: "1.0.0",
    });
    expect(e).toMatchObject({
      hubUrl: "https://hub.example",
      tenantId: HUB_TENANT,
      firstDownloadDone: false,
    });
    expect(e.user).toEqual({ id: HUB_USER, name: "المدير", role: "admin" });
    expect(conn.prepare("SELECT id FROM tenants").all()).toEqual([{ id: HUB_TENANT }]);
    expect(conn.prepare("SELECT id, role FROM users").all()).toEqual([
      { id: HUB_USER, role: "admin" },
    ]);
    expect(conn.prepare("SELECT id FROM sync_devices").all()).toEqual([{ id: e.syncDeviceId }]);
    expect(
      conn.prepare("SELECT tenant_id, created_by_installation_id FROM motard_meta").all(),
    ).toEqual([{ tenant_id: HUB_TENANT, created_by_installation_id: e.installationId }]);
    expect((await loadEnrollment())?.syncDeviceId).toBe(e.syncDeviceId);
    expect(config.CENTRAL_SYNC_URL).toBe("https://hub.example");
  });

  it("an invalid or expired code throws EnrollmentRefusedError with the hub's Arabic message and changes nothing", async () => {
    vi.stubGlobal("fetch", hubFetch(false));
    const error = await enroll(runtime, conn, {
      hubUrl: "https://hub.example",
      code: "WRONG-CODE",
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(EnrollmentRefusedError);
    expect((error as Error).message).toBe("رمز التسجيل غير صحيح");
    expect(conn.prepare("SELECT count(*) AS c FROM tenants").get()).toEqual({ c: 0 });
    expect(await loadEnrollment()).toBeNull();
  });

  it("an unreachable hub is a 'reach' refusal", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("network down");
      }),
    );
    const error = await enroll(runtime, conn, {
      hubUrl: "https://hub.example",
      code: "ABCD-EFGH-JKLM",
    }).catch((e: unknown) => e);
    expect(error).toMatchObject({ name: "EnrollmentRefusedError", stage: "reach" });
  });
});
