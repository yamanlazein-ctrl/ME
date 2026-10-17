/**
 * DESK-030: a restore registers a NEW sync identity on the hub. Its durable device credential must
 * be stored with it — re-login after an expired session would otherwise use the previous identity's
 * secret, which stops working as soon as the admin disables that old device.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "motard-hub-cred-"));
const saved = { ...process.env };
process.env.HUB_CONFIG_PATH = join(dir, "hub.json");
process.env.HUB_SESSION_PATH = join(dir, "hub-session.json");
process.env.HUB_CREDENTIALS_PATH = join(dir, "hub-credentials.dat");
delete process.env.CENTRAL_SYNC_URL;
delete process.env.HUB_SYNC_ACCESS_TOKEN;

const URL_ = "https://hub.test";
const HUB_TENANT = "11111111-1111-4111-8111-111111111111";
const OLD = "22222222-2222-4222-8222-222222222222";
const NEW = "33333333-3333-4333-8333-333333333333";

let hub: typeof import("@/application/use-cases/sync/hubConfig.js");

beforeAll(async () => {
  hub = await import("@/application/use-cases/sync/hubConfig.js");
  hub.setRuntimeCentralSyncUrl(URL_);
  hub.persistHubSession({
    accessToken: "hub-access",
    hubTenantId: HUB_TENANT,
    hubDeviceId: OLD,
  } as never);
  hub.saveHubCredentials({
    url: URL_,
    tenantId: HUB_TENANT,
    deviceId: OLD,
    deviceSecret: "old-secret",
  });
});

afterAll(() => {
  vi.unstubAllGlobals();
  process.env = saved;
  rmSync(dir, { recursive: true, force: true });
});

describe("restore identity on a paired device", () => {
  it("stores the new identity's own credential before switching the session", async () => {
    const calls: string[] = [];
    vi.stubGlobal("fetch", async (url: string, init?: { body?: string }) => {
      const path = new URL(url).pathname;
      calls.push(path);
      if (path === "/api/auth/sync-device") {
        const body = JSON.parse(String(init?.body)) as { deviceId: string };
        return new Response(JSON.stringify({ id: body.deviceId }), { status: 200 });
      }
      if (path === "/api/sync/devices/self/credential") {
        return new Response(JSON.stringify({ deviceSecret: "new-secret" }), { status: 201 });
      }
      return new Response("{}", { status: 404 });
    });
    const r = await hub.registerDeviceOnHub({
      id: NEW,
      fingerprint: "fp#r1",
      fingerprintVersion: 1,
      platform: "windows",
      hostname: "PC",
      label: "PC",
    } as never);
    expect(r).toEqual({ ok: true, id: NEW });
    expect(calls).toEqual(["/api/auth/sync-device", "/api/sync/devices/self/credential"]);
    expect(hub.loadHubCredentials()).toMatchObject({
      url: URL_,
      tenantId: HUB_TENANT,
      deviceId: NEW,
      deviceSecret: "new-secret",
    });
  });

  it("keeps the previous credential when the hub cannot mint one", async () => {
    hub.saveHubCredentials({
      url: URL_,
      tenantId: HUB_TENANT,
      deviceId: OLD,
      deviceSecret: "old-secret",
    });
    vi.stubGlobal("fetch", async (url: string, init?: { body?: string }) => {
      const path = new URL(url).pathname;
      if (path === "/api/auth/sync-device") {
        const body = JSON.parse(String(init?.body)) as { deviceId: string };
        return new Response(JSON.stringify({ id: body.deviceId }), { status: 200 });
      }
      return new Response(JSON.stringify({ message: "old hub" }), { status: 404 });
    });
    await hub.registerDeviceOnHub({
      id: NEW,
      fingerprint: "fp#r2",
      fingerprintVersion: 1,
      platform: "windows",
    } as never);
    expect(hub.loadHubCredentials()).toMatchObject({ deviceId: OLD, deviceSecret: "old-secret" });
  });
});
