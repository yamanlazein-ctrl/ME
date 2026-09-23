/**
 * Settings → «المزامنة السحابية»: hub pairing, presence feed, activity text.
 *
 * - connectHub must register the LOCAL sync-device id on the hub (otherwise
 *   every push is refused as SYNC_UNKNOWN_DEVICE), persist tenant/license
 *   metadata, and refuse accounts that cannot push.
 * - The presence feed returns only new events and never replays a stale cursor.
 * - Pulled units produce the notification text/deep link the toasts show.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  connectHub,
  disconnectHub,
  getCentralSyncUrl,
  getHubSessionInfo,
  listHubActivity,
  recordHubActivity,
  testHubConnection,
} from "@/application/use-cases/sync/hubConfig.js";
import {
  describeHubActivity,
  describePulledUnit,
} from "@/application/use-cases/sync/syncActivity.js";
import type { PulledUnit } from "@/application/use-cases/sync/syncUseCases.js";

const HUB = "https://hub.example.test";
const LOCAL_DEVICE = "5f0c3b8e-1d2a-4c6b-9e7f-0a1b2c3d4e5f";

function jwt(claims: Record<string, unknown>): string {
  const b = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${b({ alg: "none" })}.${b(claims)}.sig`;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

type Call = { url: string; init?: RequestInit };

function mockHub(opts: { role?: string; loginStatus?: number; setupCompleted?: boolean } = {}) {
  const calls: Call[] = [];
  const fetchMock = vi.fn(async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    if (url.endsWith("/api/health/live")) return json({ ok: true });
    if (url.endsWith("/api/setup/status"))
      return json({ isCompleted: opts.setupCompleted ?? true, tenantId: "hub-tenant" });
    if (url.endsWith("/api/auth/login")) {
      if (opts.loginStatus && opts.loginStatus !== 200) {
        return json({ message: "البريد الإلكتروني أو كلمة المرور غير صحيحة" }, opts.loginStatus);
      }
      return json({
        accessToken: jwt({ sub: "hub-user", tenantId: "11111111-2222-3333-4444-555555555555" }),
        refreshToken: "refresh-token-value",
        user: {
          id: "hub-user",
          name: "مدير المركز",
          email: "admin@example.com",
          role: opts.role ?? "admin",
        },
      });
    }
    if (url.endsWith("/api/license/status"))
      return json({ license: { key: "LIC-HUB-ABCD1234", status: "active" } });
    if (url.endsWith("/api/auth/sync-device")) {
      const body = JSON.parse(String(init?.body ?? "{}")) as { deviceId?: string };
      return json({ id: body.deviceId ?? "hub-generated" });
    }
    return json({}, 404);
  });
  vi.stubGlobal("fetch", fetchMock);
  return calls;
}

const device = {
  id: LOCAL_DEVICE,
  fingerprint: "fp-local-device-hash",
  fingerprintVersion: 1,
  platform: "windows",
  hostname: "ACCOUNTING-PC",
  label: "ACCOUNTING-PC",
};

describe("connectHub — pairing from Settings", () => {
  let dir = "";
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "hub-pair-"));
    process.env.HUB_CONFIG_PATH = path.join(dir, "hub.json");
    process.env.HUB_SESSION_PATH = path.join(dir, "hub-session.json");
    disconnectHub();
  });
  afterEach(() => {
    disconnectHub();
    vi.unstubAllGlobals();
    delete process.env.HUB_CONFIG_PATH;
    delete process.env.HUB_SESSION_PATH;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("registers the local device id on the hub and persists tenant + license", async () => {
    const calls = mockHub();
    const r = await connectHub({
      url: `${HUB}/`,
      email: "admin@example.com",
      password: "x",
      device,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;

    const reg = calls.find((c) => c.url.endsWith("/api/auth/sync-device"));
    expect(reg).toBeDefined();
    const regBody = JSON.parse(String(reg!.init!.body)) as Record<string, unknown>;
    expect(regBody.deviceId).toBe(LOCAL_DEVICE);
    expect(regBody.deviceFingerprint).toBe("fp-local-device-hash");

    // Login carries no tenantId — the hub resolves its single tenant itself.
    const login = calls.find((c) => c.url.endsWith("/api/auth/login"));
    expect(JSON.parse(String(login!.init!.body))).not.toHaveProperty("tenantId");

    expect(r.info.hubDeviceId).toBe(LOCAL_DEVICE);
    expect(r.info.hubTenantId).toBe("11111111-2222-3333-4444-555555555555");
    expect(r.info.hubLicenseKey).toBe("LIC-HUB-ABCD1234");
    expect(getCentralSyncUrl()).toBe(HUB);

    const saved = JSON.parse(fs.readFileSync(process.env.HUB_SESSION_PATH!, "utf8")) as Record<
      string,
      unknown
    >;
    expect(saved.accessToken).toBeTypeOf("string");
    expect(saved.hubLicenseKey).toBe("LIC-HUB-ABCD1234");
    expect(JSON.parse(fs.readFileSync(process.env.HUB_CONFIG_PATH!, "utf8"))).toEqual({ url: HUB });
    // The public info never exposes tokens.
    expect(getHubSessionInfo()).not.toHaveProperty("accessToken");
  });

  it("reports hubChanged when re-pairing to a different hub (pull cursor must reset)", async () => {
    mockHub();
    const first = await connectHub({ url: HUB, email: "a@b.co", password: "x", device });
    expect(first.ok && first.hubChanged).toBe(true);
    const same = await connectHub({ url: HUB, email: "a@b.co", password: "x", device });
    expect(same.ok && same.hubChanged).toBe(false);
    const other = await connectHub({
      url: "https://other-hub.test",
      email: "a@b.co",
      password: "x",
      device,
    });
    expect(other.ok && other.hubChanged).toBe(true);
  });

  it("keeps the previous session when login fails", async () => {
    mockHub();
    await connectHub({ url: HUB, email: "a@b.co", password: "x", device });
    const before = getHubSessionInfo();
    mockHub({ loginStatus: 401 });
    const r = await connectHub({ url: HUB, email: "a@b.co", password: "wrong", device });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.stage).toBe("login");
      expect(r.error).toContain("غير صحيحة");
    }
    expect(getHubSessionInfo()?.pairedAt).toBe(before?.pairedAt);
  });

  it("refuses a hub account that cannot push (viewer/warehouse)", async () => {
    mockHub({ role: "viewer" });
    const r = await connectHub({ url: HUB, email: "v@b.co", password: "x", device });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.stage).toBe("role");
    expect(getHubSessionInfo()).toBeNull();
  });

  it("stops before login when the hub has not completed its setup", async () => {
    const calls = mockHub({ setupCompleted: false });
    const r = await connectHub({ url: HUB, email: "a@b.co", password: "x", device });
    expect(r.ok).toBe(false);
    expect(calls.some((c) => c.url.endsWith("/api/auth/login"))).toBe(false);
  });

  it("warns when the hub already knows this device under a different id", async () => {
    mockHub();
    const inner = globalThis.fetch;
    vi.stubGlobal("fetch", async (input: string | URL, init?: RequestInit) =>
      String(input).endsWith("/api/auth/sync-device")
        ? json({ id: "00000000-0000-4000-8000-00000000abcd" })
        : inner(input, init),
    );
    const r = await connectHub({ url: HUB, email: "a@b.co", password: "x", device });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.deviceWarning).toContain("بمعرّف آخر");
  });

  it("pairs but warns when there is no local sync device", async () => {
    mockHub();
    const r = await connectHub({ url: HUB, email: "a@b.co", password: "x", device: null });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.info.hubDeviceId).toBeNull();
      expect(r.deviceWarning).toBeTruthy();
    }
  });

  it("testHubConnection does not change the saved configuration", async () => {
    mockHub();
    const t = await testHubConnection(HUB);
    expect(t.reachable).toBe(true);
    expect(t.setupCompleted).toBe(true);
    expect(getCentralSyncUrl()).toBeNull();
  });
});

describe("hub presence feed", () => {
  it("returns only events after the cursor, and everything for a stale cursor", () => {
    const tenant = `t-${Date.now()}`;
    const a = recordHubActivity(tenant, {
      kind: "login",
      userName: "محمد",
      userRole: "accountant",
      deviceLabel: "PC-2",
      sourceDeviceId: null,
    });
    const b = recordHubActivity(tenant, {
      kind: "login",
      userName: "سارة",
      userRole: "admin",
      deviceLabel: "PC-1",
      sourceDeviceId: null,
    });
    expect(listHubActivity(tenant, a.seq).map((e) => e.userName)).toEqual(["سارة"]);
    expect(listHubActivity(tenant, b.seq)).toEqual([]);
    // Fresh device (no cursor): recent events only.
    expect(listHubActivity(tenant, null)).toHaveLength(2);
    // Cursor from before a hub restart (above the current max): not silently empty.
    expect(listHubActivity(tenant, b.seq + 10_000)).toHaveLength(2);
    // Tenants are isolated.
    expect(listHubActivity(`${tenant}-other`, null)).toEqual([]);
  });

  it("describes a login for the toast", () => {
    const n = describeHubActivity({
      seq: 1,
      kind: "login",
      userName: "",
      userRole: "accountant",
      deviceLabel: "PC-2",
      sourceDeviceId: null,
      at: new Date().toISOString(),
    });
    expect(n.title).toBe("المحاسب سجّل دخوله الآن");
    expect(n.detail).toContain("PC-2");
  });
});

describe("describePulledUnit — activity text and deep links", () => {
  const unit = (over: Partial<PulledUnit>): PulledUnit => ({
    opId: "op",
    syncDeviceId: null,
    entityType: "invoice",
    entityId: "9d2c1a3b-0000-4000-8000-000000000102",
    operation: "create",
    payload: {},
    receivedSeq: 1,
    receivedAt: new Date().toISOString(),
    appliedAt: null,
    ...over,
  });

  it("new sale invoice links to the invoice", () => {
    const n = describePulledUnit(
      unit({ payload: { actorUserName: "محمد", invoiceType: "sale", invoiceNumber: "102" } }),
    );
    expect(n?.title).toBe("أضاف محمد فاتورة مبيعات جديدة رقم #102");
    expect(n?.targetPath).toBe("/invoices/9d2c1a3b-0000-4000-8000-000000000102");
    expect(n?.kind).toBe("sync");
  });

  it("update and cancel are worded and graded", () => {
    expect(
      describePulledUnit(
        unit({
          operation: "update",
          payload: { actorUserName: "محمد", invoiceType: "entry", invoiceNumber: "7" },
        }),
      )?.title,
    ).toBe("عدّل محمد فاتورة إدخال رقم #7");
    const cancel = describePulledUnit(
      unit({ operation: "cancel", payload: { actorRole: "accountant", invoiceNumber: "7" } }),
    );
    expect(cancel?.title).toBe("ألغى المحاسب فاتورة رقم #7");
    expect(cancel?.severity).toBe("warning");
  });

  it("vouchers link to their list; masters stay silent", () => {
    const v = describePulledUnit(
      unit({
        entityType: "voucher",
        payload: { actorUserName: "سارة", voucherKind: "payment", voucherNumber: "15" },
      }),
    );
    expect(v?.title).toBe("أضاف سارة سند دفع جديداً رقم #15");
    expect(v?.targetPath).toBe("/payments");
    expect(describePulledUnit(unit({ entityType: "party" }))).toBeNull();
    expect(describePulledUnit(unit({ entityType: "roll" }))).toBeNull();
  });
});
