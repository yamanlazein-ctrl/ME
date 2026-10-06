/**
 * Device side of enrollment, against a fake hub over real HTTP: link once with
 * a code, survive a restart without re-pairing, recover lost tokens with the
 * device credential (never a password), and stop — without forgetting the
 * pairing — when the hub disables the device.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, readFileSync, rmSync, existsSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "motard-hubdev-"));
process.env.HUB_CONFIG_PATH = join(dir, "hub.json");
process.env.HUB_SESSION_PATH = join(dir, "hub-session.json");
delete process.env.CENTRAL_SYNC_URL;
delete process.env.HUB_SYNC_ACCESS_TOKEN;

const HUB_TENANT = "11111111-1111-4111-8111-111111111111";
const DEVICE = {
  id: "22222222-2222-4222-8222-222222222222",
  fingerprint: "fp-device-0123456789",
  fingerprintVersion: 1,
  platform: "windows",
  hostname: "PC-1",
  label: null,
};
const SECRET = "s".repeat(43);
let revoked = false;
let oldHub = false;
let tokenCalls: Array<Record<string, unknown>> = [];
let server: http.Server;
let url = "";

beforeAll(async () => {
  server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const body = raw ? JSON.parse(raw) : {};
      const json = (status: number, b: unknown) => {
        res.writeHead(status, { "Content-Type": "application/json" });
        res.end(JSON.stringify(b));
      };
      if (req.url === "/api/health/live") return json(200, { ok: true });
      if (req.url === "/api/setup/status") return json(200, { isCompleted: true });
      if (req.url === "/api/license/status") return json(200, { license: { key: "LIC-1", status: "active" } });
      if (req.url === "/api/sync/enroll") {
        if (body.code !== "ABCD-EFGH-JKLM") return json(401, { message: "رمز التسجيل غير صحيح" });
        return json(201, {
          ok: true,
          tenantId: HUB_TENANT,
          deviceId: body.device.id,
          deviceSecret: SECRET,
          accessToken: "access-enrolled-xxxx",
          refreshToken: "refresh-enrolled",
          user: { id: "u1", name: "Admin", role: "admin" },
        });
      }
      if (req.url === "/api/auth/login") {
        return json(200, { accessToken: "h.eyJ0ZW5hbnRJZCI6IjExMTExMTExLTExMTEtNDExMS04MTExLTExMTExMTExMTExMSJ9.s", refreshToken: "r", user: { id: "u1", role: "admin", email: body.email } });
      }
      if (req.url === "/api/auth/sync-device") return json(200, { id: body.deviceId });
      if (req.url === "/api/sync/devices/self/credential") {
        return oldHub ? json(404, {}) : json(201, { deviceSecret: "minted-for-account-pairing-0000000000000" });
      }
      if (req.url === "/api/sync/device-token") {
        tokenCalls.push(body);
        if (revoked) return json(403, { code: "SYNC_DEVICE_REVOKED", message: "الجهاز معطَّل" });
        if (body.secret !== SECRET) return json(401, { message: "bad" });
        return json(200, { ok: true, accessToken: "access-from-credential", refreshToken: "r2" });
      }
      json(404, {});
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise((r) => server.close(r));
  rmSync(dir, { recursive: true, force: true });
});

const fresh = async () => {
  vi.resetModules(); // a restart: nothing in memory, only what was saved on disk
  return import("@/application/use-cases/sync/hubConfig.js");
};

describe("device enrollment (device side)", () => {
  it("a wrong code changes nothing", async () => {
    const hub = await fresh();
    const r = await hub.enrollHub({ url, code: "WRONG-CODE", device: DEVICE, local: { tenantId: "t-local", userId: "u-local" } });
    expect(r).toMatchObject({ ok: false, stage: "login" });
    expect(existsSync(process.env.HUB_SESSION_PATH!)).toBe(false);
    expect(hub.getCentralSyncUrl()).toBeNull();
  });

  it("links once with the code and keeps the device credential, not a password", async () => {
    const hub = await fresh();
    const r = await hub.enrollHub({ url, code: "ABCD-EFGH-JKLM", device: DEVICE, local: { tenantId: "t-local", userId: "u-local" } });
    expect(r.ok).toBe(true);
    const session = JSON.parse(readFileSync(process.env.HUB_SESSION_PATH!, "utf8"));
    expect(session).toMatchObject({ hubDeviceId: DEVICE.id, hubTenantId: HUB_TENANT, hubLicenseKey: "LIC-1", localTenantId: "t-local" });
    const credFile = readFileSync(join(dir, "hub-credentials.dat"), "utf8");
    expect(credFile).not.toContain(SECRET); // encrypted at rest
    expect(hub.loadHubCredentials()).toMatchObject({ url, tenantId: HUB_TENANT, deviceId: DEVICE.id, deviceSecret: SECRET });
    expect(hub.loadHubCredentials()?.password).toBeUndefined();
  });

  it("after a restart the link and the background-sync identity are still there", async () => {
    const hub = await fresh();
    expect(hub.getCentralSyncUrl()).toBe(url);
    expect(hub.backgroundSyncIdentity()).toEqual({ tenantId: "t-local", userId: "u-local", deviceId: DEVICE.id });
    expect(await hub.resolveHubAuthHeader()).toBe("Bearer access-enrolled-xxxx");
  });

  it("lost tokens come back from the device credential", async () => {
    unlinkSync(process.env.HUB_SESSION_PATH!);
    const hub = await fresh();
    tokenCalls = [];
    expect(await hub.resolveHubAuthHeader()).toBe("Bearer access-from-credential");
    expect(tokenCalls).toEqual([{ tenantId: HUB_TENANT, deviceId: DEVICE.id, secret: SECRET }]);
    expect(hub.getHubSessionInfo()?.hubDeviceId).toBe(DEVICE.id);
  });

  it("a disabled device gets no token but keeps its pairing (re-enable resumes it)", async () => {
    unlinkSync(process.env.HUB_SESSION_PATH!);
    revoked = true;
    const hub = await fresh();
    expect(await hub.resolveHubAuthHeader()).toBeUndefined();
    expect(hub.loadHubCredentials()?.deviceId).toBe(DEVICE.id);
    revoked = false;
    expect(await hub.resolveHubAuthHeader()).toBe("Bearer access-from-credential");
  });

  it("pairing with the admin account keeps a device credential, not the password", async () => {
    const hub = await fresh();
    const r = await hub.connectHub({ url, email: "admin@hub.test", password: "pw-123", device: DEVICE, local: { tenantId: "t-local", userId: "u-local" } });
    expect(r.ok).toBe(true);
    expect(hub.loadHubCredentials()).toMatchObject({ deviceId: DEVICE.id, deviceSecret: "minted-for-account-pairing-0000000000000", tenantId: HUB_TENANT });
    expect(hub.loadHubCredentials()?.password).toBeUndefined();
    expect(hub.backgroundSyncIdentity()?.deviceId).toBe(DEVICE.id);
  });

  it("a hub without device credentials falls back to the stored account (as before)", async () => {
    oldHub = true;
    const hub = await fresh();
    const r = await hub.connectHub({ url, email: "admin@hub.test", password: "pw-123", device: DEVICE });
    oldHub = false;
    expect(r.ok).toBe(true);
    expect(hub.loadHubCredentials()).toMatchObject({ email: "admin@hub.test", password: "pw-123" });
  });

  it("older pairings with a stored account still load", async () => {
    const hub = await fresh();
    hub.saveHubCredentials({ url, email: "admin@hub.test", password: "pw" });
    expect(hub.loadHubCredentials()).toMatchObject({ email: "admin@hub.test", password: "pw" });
  });
});
