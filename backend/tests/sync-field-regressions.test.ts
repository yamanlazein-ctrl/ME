/**
 * Regressions found pairing real devices through a real hub (2026-09-24).
 *
 * Each case below made sync look "connected / syncing" while nothing moved,
 * or dropped/refused data after it moved:
 *  1. claimBatch returned snake_case rows → leaseToken undefined → every push
 *     failed with SYNC_LEASE_MISSING, forever.
 *  2. cashbox_daily_* functions carried `SET row_security = off`, which a
 *     non-BYPASSRLS role (the hub on Neon) cannot set → every hub write that
 *     touched cash failed.
 *  3. Two devices numbering independently produced the same human number;
 *     replay refused (or silently dropped) the second record.
 *  4. A synced number from an earlier year / with a collision suffix was
 *     refused by the pre-allocated path.
 *  5. Hub sign-in was lost with the session file (app closed / token expired).
 *  6. Pull did not identify the device, so each device re-pulled its own units.
 *  7. Stock claims were measured from the pieces-less summary lines (every
 *     2 kg cut counted as 1 piece), and purchases were claimed as consumption.
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { db } from "@/infrastructure/orm/drizzle.js";
import { tenants } from "@/infrastructure/orm/schemas/tenant.table.js";
import { parties } from "@/infrastructure/orm/schemas/party.table.js";
import { syncDevices } from "@/infrastructure/orm/schemas/sync-device.table.js";
import { applyPartyOpeningForReplay, ensureInvoiceSyncDependencies } from "@/application/use-cases/sync/syncDependencySnapshots.js";
import { PostgresSyncOutboxRepository } from "@/infrastructure/repositories/PostgresSyncOutboxRepository.js";
import { resolveCollision, numberSuffix } from "@/application/use-cases/sync/syncNumberCollision.js";
import { allocateDocumentNumber, claimNumberBlockInTx } from "@/infrastructure/utils/documentNumbers.js";
import { documentSequences } from "@/infrastructure/orm/schemas/document-sequence.table.js";
import {
  disconnectHub,
  loadHubCredentials,
  resolveConnectCredentials,
  resolveHubAuthHeader,
  saveHubCredentials,
  setRuntimeCentralSyncUrl,
} from "@/application/use-cases/sync/hubConfig.js";
import { extractConflictResources, runLocalSyncPull, runLocalSyncPush, withPartyOpening } from "@/application/use-cases/sync/syncUseCases.js";
import type { TenantContext } from "@/domain/types/index.js";

const rows = (r: unknown) =>
  (Array.isArray(r) ? r : ((r as { rows?: unknown[] }).rows ?? [])) as Array<Record<string, unknown>>;

async function newTenant(label: string) {
  const id = randomUUID();
  await db.insert(tenants).values({ id, name: label, slug: `${label}-${id.slice(0, 8)}` });
  return id;
}

describe("sync field regressions", () => {
  beforeAll(async () => {
    await db.execute(sql`select 1`);
  });

  it("1. claimBatch rows carry camelCase leaseToken/tenantId (push can mark them synced)", async () => {
    const tenantId = await newTenant("claim");
    const repo = new PostgresSyncOutboxRepository(db);
    await repo.enqueue({
      tenantId,
      opId: randomUUID(),
      entityType: "party",
      entityId: randomUUID(),
      operation: "create",
      payload: { x: 1 },
    });
    const [held] = await repo.claimBatch(tenantId, 10, 60_000, "test-owner");
    expect(held).toBeDefined();
    expect(held!.tenantId).toBe(tenantId);
    expect(held!.leaseToken).toMatch(/^[0-9a-f-]{36}$/);
    expect(held!.status).toBe("pushing");
    expect(await repo.markSynced(held!.id, tenantId, held!.leaseToken!)).toBe(1);
  });

  it("1b. pairing with a NEW hub re-queues everything already delivered to the old one, in order", async () => {
    const tenantId = await newTenant("requeue");
    const repo = new PostgresSyncOutboxRepository(db);
    const ops: string[] = [];
    for (let i = 0; i < 3; i++) {
      const opId = randomUUID();
      ops.push(opId);
      await repo.enqueue({ tenantId, opId, entityType: "party", entityId: randomUUID(), operation: "create", payload: { i } });
    }
    for (const u of await repo.claimBatch(tenantId, 10, 60_000, "old-hub")) {
      await repo.markSynced(u.id, tenantId, u.leaseToken!);
    }
    expect(await repo.countOutstanding(tenantId)).toBe(0);
    // A hub-parked (hubDead) unit is live locally → re-sent; a conflict loser
    // was rolled back locally → stays rejected.
    for (const [reason, n] of [["hubDead: roll missing", 1], ["SYNC_CONFLICT lost", 1]] as const) {
      for (let i = 0; i < n; i++) {
        const opId = randomUUID();
        await repo.enqueue({ tenantId, opId, entityType: "invoice", entityId: randomUUID(), operation: "create", payload: {} });
        const [u] = await repo.claimBatch(tenantId, 1, 60_000, "old-hub");
        await repo.markRejected(u!.id, tenantId, reason, u!.leaseToken!);
        if (reason.startsWith("hubDead")) ops.push(opId);
      }
    }
    expect(await repo.requeueSyncedForNewHub(tenantId)).toBe(4);
    const again = await repo.claimBatch(tenantId, 10, 60_000, "new-hub");
    expect(again.map((u) => u.opId)).toEqual(ops);
  });

  it("2. cashbox functions no longer force row_security (works for a NOBYPASSRLS hub role)", async () => {
    const r = rows(
      await db.execute(sql`
        SELECT p.proname, array_to_string(p.proconfig, ',') AS cfg
          FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = 'public'
           AND p.proname IN ('cashbox_daily_apply_delta', 'cashbox_daily_shift_all',
                             'trg_cashbox_daily_from_ledger', 'trg_cashbox_daily_from_manual')`),
    );
    expect(r.length).toBe(4);
    for (const f of r) expect(String(f.cfg ?? "")).not.toMatch(/row_security/);
  });

  describe("3. number collisions converge whatever the arrival order", () => {
    // Ids are global primary keys, so each simulated node gets its own pair;
    // only the ORDER matters: x < y always.
    const pair = () => ({
      x: `0a${randomUUID().slice(2)}`, // smaller id → keeps the number
      y: `fb${randomUUID().slice(2)}`,
    });
    const spec = { table: "parties", column: "code", scope: {}, suffix: numberSuffix };

    async function node(ids: { x: string; y: string }, xFirst: boolean) {
      const [first, second] = xFirst ? [ids.x, ids.y] : [ids.y, ids.x];
      const tenantId = await newTenant("coll");
      await db.insert(parties).values({
        id: first, tenantId, name: `P-${first.slice(0, 4)}`, code: "C-0001", kind: "customer", currency: "USD",
      });
      const code = await resolveCollision(db, tenantId, spec, second, "C-0001");
      await db.insert(parties).values({
        id: second, tenantId, name: `P-${second.slice(0, 4)}`, code, kind: "customer", currency: "USD",
      });
      const out = rows(await db.execute(sql`SELECT id::text AS id, code FROM parties WHERE tenant_id = ${tenantId} ORDER BY id`));
      const codeOf = (id: string) => String(out.find((r) => r.id === id)?.code);
      return { x: codeOf(ids.x), y: codeOf(ids.y), yTag: ids.y.slice(0, 4) };
    }

    it("both orders end in the same state, no record refused or lost", async () => {
      const a = await node(pair(), true); // x local, y arrives (loses → suffixed)
      const b = await node(pair(), false); // y local, x arrives (wins → y renamed)
      for (const n of [a, b]) {
        expect(n.x).toBe("C-0001");
        expect(n.y).toBe(`C-0001-${n.yTag}`);
      }
    });
  });

  describe("4. pre-allocated (synced) numbers", () => {
    it("keeps a collision suffix and accepts a number from an earlier year", async () => {
      const tenantId = await newTenant("prealloc");
      const year = new Date().getFullYear();
      const got = await db.transaction((tx) =>
        allocateDocumentNumber(tx as never, "invoice", tenantId, { preAllocatedNumber: `INV-${year - 1}-0042-3f8d` }),
      );
      expect(got).toBe(`INV-${year - 1}-0042-3f8d`);
    });

    it("a company past 9,999 documents in total still gets number blocks (width is padding, not a cap)", async () => {
      const tenantId = await newTenant("bigco");
      const device = randomUUID();
      await db.insert(syncDevices).values({ id: device, tenantId, deviceFingerprint: "big", platform: "windows" });
      await db.insert(documentSequences).values({ tenantId, entityType: "invoice", prefix: "INV", lastNumber: 10_936 });
      const block = await db.transaction((tx) =>
        claimNumberBlockInTx(tx as never, { tenantId, syncDeviceId: device, entityType: "invoice", size: 100 }),
      );
      expect(block.startNumber).toBe(10_937);
      expect(block.endNumber).toBe(11_036);
    });

    it("still refuses a number from a later year (wrong device clock)", async () => {
      const tenantId = await newTenant("prealloc2");
      const year = new Date().getFullYear();
      await expect(
        db.transaction((tx) =>
          allocateDocumentNumber(tx as never, "invoice", tenantId, { preAllocatedNumber: `INV-${year + 1}-0001` }),
        ),
      ).rejects.toThrow(/سنة لاحقة/);
    });
  });

  describe("5+6. stored hub credentials and device-identified pull", () => {
    let dir = "";
    beforeEach(() => {
      dir = fs.mkdtempSync(path.join(os.tmpdir(), "hub-cred-"));
      process.env.HUB_CONFIG_PATH = path.join(dir, "hub.json");
      process.env.HUB_SESSION_PATH = path.join(dir, "hub-session.json");
      process.env.HUB_CREDENTIALS_PATH = path.join(dir, "hub-credentials.dat");
      disconnectHub();
    });
    afterEach(() => {
      disconnectHub();
      vi.unstubAllGlobals();
      delete process.env.HUB_CONFIG_PATH;
      delete process.env.HUB_SESSION_PATH;
      delete process.env.HUB_CREDENTIALS_PATH;
      fs.rmSync(dir, { recursive: true, force: true });
    });

    it("credentials round-trip encrypted; tampering or deletion yields null", () => {
      const creds = { url: "https://hub.example.test", email: "a@b.c", password: "s3cret-كلمة" };
      saveHubCredentials(creds);
      const raw = fs.readFileSync(process.env.HUB_CREDENTIALS_PATH!, "utf8");
      expect(raw).not.toContain("s3cret");
      expect(loadHubCredentials()).toEqual(creds);

      const blob = JSON.parse(raw) as { ct: string };
      const ct = Buffer.from(blob.ct, "base64");
      ct[0] = ct[0]! ^ 0xff;
      fs.writeFileSync(process.env.HUB_CREDENTIALS_PATH!, JSON.stringify({ ...blob, ct: ct.toString("base64") }));
      expect(loadHubCredentials()).toBeNull();

      saveHubCredentials(creds);
      saveHubCredentials(null);
      expect(fs.existsSync(process.env.HUB_CREDENTIALS_PATH!)).toBe(false);
    });

    it("changing only the hub URL reuses the stored account; a different email needs its password", () => {
      expect(resolveConnectCredentials({})).toEqual({ email: undefined, password: undefined });
      saveHubCredentials({ url: "https://old.trycloudflare.com", email: "a@b.c", password: "pw" });
      expect(resolveConnectCredentials({})).toEqual({ email: "a@b.c", password: "pw" });
      expect(resolveConnectCredentials({ email: "a@b.c" })).toEqual({ email: "a@b.c", password: "pw" });
      expect(resolveConnectCredentials({ email: "other@b.c" })).toEqual({ email: "other@b.c", password: undefined });
      expect(resolveConnectCredentials({ password: "new" })).toEqual({ email: "a@b.c", password: "new" });
    });

    it("a lost session signs in again from the stored credentials (no re-pairing)", async () => {
      saveHubCredentials({ url: "https://hub.example.test", email: "a@b.c", password: "pw" });
      const calls: string[] = [];
      vi.stubGlobal(
        "fetch",
        vi.fn(async (input: string | URL) => {
          calls.push(String(input));
          return new Response(JSON.stringify({ accessToken: "fresh-token", refreshToken: "r" }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }),
      );
      const header = await resolveHubAuthHeader();
      expect(header).toBe("Bearer fresh-token");
      expect(calls).toEqual(["https://hub.example.test/api/auth/login"]);
    });

    it("pull sends X-Sync-Device-Id so the hub never returns this device's own units", async () => {
      const tenantId = await newTenant("pull");
      const deviceId = randomUUID();
      setRuntimeCentralSyncUrl("https://hub.example.test");
      fs.writeFileSync(process.env.HUB_SESSION_PATH!, JSON.stringify({ accessToken: "hub-access-token" }));
      const seen: Array<Record<string, string>> = [];
      vi.stubGlobal(
        "fetch",
        vi.fn(async (_input: string | URL, init?: RequestInit) => {
          seen.push((init?.headers ?? {}) as Record<string, string>);
          return new Response(JSON.stringify({ items: [] }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }),
      );
      const ctx: TenantContext = { tenantId, userId: randomUUID(), userRole: "admin", userName: "pull" };
      await runLocalSyncPull(db, {} as never, ctx, undefined, deviceId);
      expect(seen.length).toBeGreaterThan(0);
      expect(seen[0]!["X-Sync-Device-Id"]).toBe(deviceId);
    });
  });

  describe("8. push attribution", () => {
    let dir = "";
    beforeEach(() => {
      dir = fs.mkdtempSync(path.join(os.tmpdir(), "hub-push-"));
      process.env.HUB_CONFIG_PATH = path.join(dir, "hub.json");
      process.env.HUB_SESSION_PATH = path.join(dir, "hub-session.json");
      process.env.HUB_CREDENTIALS_PATH = path.join(dir, "hub-credentials.dat");
      disconnectHub();
    });
    afterEach(() => {
      disconnectHub();
      vi.unstubAllGlobals();
      delete process.env.HUB_CONFIG_PATH;
      delete process.env.HUB_SESSION_PATH;
      delete process.env.HUB_CREDENTIALS_PATH;
      fs.rmSync(dir, { recursive: true, force: true });
    });

    it("units recorded before pairing (NULL) or on another machine are pushed as THIS device", async () => {
      const tenantId = await newTenant("push-attr");
      const here = randomUUID();
      const repo = new PostgresSyncOutboxRepository(db);
      // A restored database brings the OLD machine's device row with it.
      const otherMachine = randomUUID();
      await db.insert(syncDevices).values({
        id: otherMachine, tenantId, deviceFingerprint: "old-machine", platform: "windows",
      });
      for (const syncDeviceId of [null, otherMachine]) {
        await repo.enqueue({
          tenantId,
          syncDeviceId,
          opId: randomUUID(),
          entityType: "expense",
          entityId: randomUUID(),
          operation: "create",
          payload: {},
        });
      }
      setRuntimeCentralSyncUrl("https://hub.example.test");
      fs.writeFileSync(process.env.HUB_SESSION_PATH!, JSON.stringify({ accessToken: "hub-access-token" }));
      const sent: Array<{ header?: string; body: { syncDeviceId: string | null } }> = [];
      vi.stubGlobal(
        "fetch",
        vi.fn(async (_input: string | URL, init?: RequestInit) => {
          const headers = (init?.headers ?? {}) as Record<string, string>;
          sent.push({ header: headers["X-Sync-Device-Id"], body: JSON.parse(String(init?.body)) });
          return new Response(JSON.stringify({ materialized: true }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }),
      );
      const ctx: TenantContext = { tenantId, userId: randomUUID(), userRole: "admin", userName: "p", syncDeviceId: here };
      const r = await runLocalSyncPush(repo, {} as never, {} as never, {} as never, ctx, undefined);
      expect(sent).toHaveLength(2);
      for (const u of sent) {
        expect(u.body.syncDeviceId).toBe(here);
        expect(u.header).toBe(here);
      }
      expect(r.pushed).toBe(2);
    });
  });

  describe("9. opening balances travel with the party", () => {
    it("the receiving node writes the same balanced opening journal, once", async () => {
      const tenantId = await newTenant("opening");
      const ctx: TenantContext = { tenantId, userId: randomUUID(), userRole: "admin", userName: "o" };
      const id = randomUUID();
      const snap = {
        id, kind: "customer", code: "CUS-9", name: `Opening ${id.slice(0, 4)}`, currency: "USD", status: "active",
        openingBalance: 922.53, openingDate: "2026-01-15",
      };
      await ensureInvoiceSyncDependencies(db, { parties: [snap as never], fabrics: [], colors: [], rolls: [] }, ctx);
      await applyPartyOpeningForReplay(db, snap as never, ctx);
      await applyPartyOpeningForReplay(db, snap as never, ctx); // duplicate delivery
      const legs = rows(await db.execute(sql`
        SELECT type, debit::float8 d, credit::float8 c, date::text dt FROM ledger_entries
         WHERE tenant_id = ${tenantId} AND reference_type = 'opening' ORDER BY type`));
      expect(legs).toEqual([
        { type: "opening", d: 922.53, c: 0, dt: "2026-01-15" },
        { type: "opening_equity", d: 0, c: 922.53, dt: "2026-01-15" },
      ]);
      const [p] = rows(await db.execute(sql`SELECT opening_balance::float8 ob FROM parties WHERE id = ${id}::uuid`));
      expect(p!.ob).toBe(922.53);
    });

    it("an old party unit without the opening balance is filled from the local record at push", async () => {
      const tenantId = await newTenant("opening-old");
      const ctx: TenantContext = { tenantId, userId: randomUUID(), userRole: "admin", userName: "o" };
      const id = randomUUID();
      const snap = { id, kind: "supplier", code: "SUP-9", name: `Old ${id.slice(0, 4)}`, currency: "USD", status: "active" };
      await ensureInvoiceSyncDependencies(db, { parties: [snap as never], fabrics: [], colors: [], rolls: [] }, ctx);
      await applyPartyOpeningForReplay(db, { ...snap, openingBalance: 300, openingDate: "2025-03-01" } as never, ctx);
      const out = await withPartyOpening({ entityType: "party", operation: "create", entityId: id, payload: { snapshot: snap } }, tenantId);
      expect((out.snapshot as Record<string, unknown>).openingBalance).toBe(300);
      expect((out.snapshot as Record<string, unknown>).openingDate).toBe("2025-03-01");
    });
  });

  describe("7. stock claims", () => {
    const roll = randomUUID();
    it("measure pieces from the exact user lines (a kg-only cut is 0 pieces, not 1)", () => {
      const r = extractConflictResources("invoice", "create", {
        rollIds: [roll],
        invoiceType: "sale",
        lines: [{ rollId: roll, quantityKg: 2 }],
        createInput: { type: "sale", lines: [{ rollId: roll, quantityKg: 2, pieces: 0 }] },
      });
      expect(r).toEqual([{ resourceType: "roll", resourceId: roll, quantityKg: 2, quantityPieces: 0 }]);
    });

    it("a purchase (entry) invoice claims entry_roll — it adds stock, it cannot oversell", () => {
      const r = extractConflictResources("invoice", "create", {
        rollIds: [roll],
        invoiceType: "entry",
        createInput: { type: "entry", lines: [{ rollId: roll, quantityKg: 100, pieces: 1 }] },
      });
      expect(r[0]!.resourceType).toBe("entry_roll");
    });
  });
});
