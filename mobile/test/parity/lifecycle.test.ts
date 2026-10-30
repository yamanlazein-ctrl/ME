// Device lifecycle against the real hub (tasks T066 scenario (h), T082 scenario (i)): a first download that is killed and
// resumed ends equal to the hub, and a revoked phone learns it from the hub and wipes itself.
import { existsSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { parityAvailable, startParity, type Parity } from "./harness";
import { runFirstDownload } from "../../src/core/firstDownload";
import { deviceFirstDownloadDeps } from "../../src/core/firstDownloadDeps";
import { createHubFetch, type HubSignal } from "../../src/core/hubHttp";
import { wipeDevice } from "../../src/core/wipe";
import { persistHubSession } from "@backend/application/use-cases/sync/hubConfig";

vi.mock("expo-file-system/legacy", () => ({
  getFreeDiskStorageAsync: async () => 10 ** 12,
  documentDirectory: "file:///docs/",
  cacheDirectory: "file:///cache/",
}));

describe.skipIf(!parityAvailable())("device lifecycle (T066, T082)", () => {
  let p: Parity;

  beforeAll(async () => {
    p = await startParity(18400);
    const D = p.desktop.call;
    const must = p.ac8.must;
    await must(D, "desktop blocks", "POST", "/api/sync/number-blocks/ensure", {
      syncDeviceId: p.desktop.deviceId,
      entityTypes: ["customer", "supplier", "invoice", "invoice_entry", "voucher"],
    });
    const fabric = (
      await must(D, "fabric", "POST", "/api/inventory/fabrics", { name: "Life Fabric" })
    ).id as string;
    const color = (
      await must(D, "color", "POST", "/api/inventory/colors", {
        fabricId: fabric,
        name: "Life Color",
      })
    ).id as string;
    const roll = (
      await must(D, "roll", "POST", "/api/inventory/rolls", {
        colorId: color,
        rollNo: "LIFE-R1",
        initialKg: 5000,
        pieces: 500,
        pricePerKg: 2,
        currency: "USD",
        entryDate: "2026-03-01",
      })
    ).id as string;
    // Enough documents for several 50-unit pull pages, so a kill at 40 % really happens mid-download.
    for (let i = 0; i < 30; i++) {
      const party = (
        await must(D, `customer ${i}`, "POST", "/api/customers", { name: `Life ${i}` })
      ).id as string;
      await must(D, `sale ${i}`, "POST", "/api/invoices", {
        type: "sale",
        date: "2026-03-01",
        partyId: party,
        partyType: "customer",
        currency: "USD",
        exchangeRate: 1,
        lines: [
          {
            fabricId: fabric,
            colorId: color,
            rollId: roll,
            quantityKg: 3,
            pieces: 1,
            pricePerKg: 4.5,
          },
        ],
        paid: i % 3,
      });
    }
    await p.ac8.syncUntilDrained(D, 10);
  }, 900_000);

  afterAll(async () => {
    await p?.stop();
  }, 120_000);

  it("(h) a first download killed at 40 % resumes from the stored cursor and ends equal to the hub", async () => {
    const deps = deviceFirstDownloadDeps(p.phone);
    let killed = false;
    await expect(
      runFirstDownload({
        ...deps,
        afterPage: (progress) => {
          if (!killed && progress.percent >= 0.4) {
            killed = true;
            throw new Error("killed");
          }
        },
      }),
    ).rejects.toThrow("killed");
    const cursorAfterKill = await deps.cursor();
    expect(cursorAfterKill).toBeGreaterThan(0);

    const resumed = await runFirstDownload(deps);
    expect(resumed.done).toBe(true);
    expect(resumed.cursor).toBeGreaterThanOrEqual(cursorAfterKill);

    // Counts and balances equal the hub's, and the business tables equal the desktop's.
    expect(await p.compareAll()).toEqual([]);
    const hubCount = ((await p.hub.call("GET", "/api/invoices?limit=1000")).json?.data ?? [])
      .length;
    const rows = await p.phone.repos.invoiceRepo.list({ limit: 1000 } as never, p.phone.context());
    expect(rows.data.length).toBe(hubCount);
  }, 900_000);

  it("(i) a revoked phone gets SYNC_DEVICE_REVOKED, and wipeDevice removes its database file", async () => {
    const signals: HubSignal[] = [];
    const original = globalThis.fetch;
    globalThis.fetch = createHubFetch(original, (s) => signals.push(s));
    try {
      const revoke = await p.ac8.must(
        p.hub.call,
        "revoke phone",
        "POST",
        `/api/sync/devices/${p.phone.identity.syncDeviceId}/revoke`,
        {},
      );
      expect(revoke).toBeTruthy();
      // Revoking also ends the user's hub sessions (SESSION_REVOKED); the phone then exchanges its device credential for a
      // new token, which the hub refuses with SYNC_DEVICE_REVOKED. Present a fresh token to model that exchange.
      await new Promise((r) => setTimeout(r, 2_100)); // a token issued after the session cut-off
      persistHubSession({
        accessToken: await p.ac8.mintToken(p.ac8.JWT_HUB),
        hubUrl: p.hub.url,
        hubTenantId: p.ac8.TENANT_ID,
        hubUserId: p.ac8.USER_ID,
        hubDeviceId: p.phone.identity.syncDeviceId,
        localTenantId: p.ac8.TENANT_ID,
        localUserId: p.ac8.USER_ID,
      });
      await p.phone.syncOnce();
    } finally {
      globalThis.fetch = original;
    }
    expect(signals.some((s) => s.kind === "revoked")).toBe(true);

    expect(existsSync(p.phone.dbFile)).toBe(true);
    const order: string[] = [];
    const result = await wipeDevice({
      closeAndDeleteDatabase: async () => {
        order.push("database");
        p.phone.close();
        const { rmSync } = await import("node:fs");
        for (const suffix of ["", "-wal", "-shm"])
          rmSync(`${p.phone.dbFile}${suffix}`, { force: true });
      },
      deleteSecrets: async () => void order.push("secrets"),
      deleteAppState: async () => void order.push("app-state"),
      deleteCachedPdfs: async () => void order.push("cached-pdfs"),
      navigateToEnroll: () => void order.push("navigate"),
    });
    expect(result.failed).toEqual([]);
    expect(order).toEqual(["database", "secrets", "app-state", "cached-pdfs", "navigate"]);
    expect(existsSync(p.phone.dbFile)).toBe(false);
  }, 300_000);
});
