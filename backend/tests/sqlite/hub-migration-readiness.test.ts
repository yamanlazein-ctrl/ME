/**
 * HUB MIGRATION — acceptance + regression tests for MIG-01…MIG-08 (MIGRATION_READINESS_AUDIT.md,
 * docs/HUB-MIGRATION-RUNBOOK.md). SQLite only: one temp desktop database + in-process fake hubs.
 *
 * The production hub runs PostgreSQL. Hub-side behaviour that also exists on the SQLite twin (the
 * applied_seq trigger, the pull filter, hub identity in `secrets`, number-tip raise, fingerprint)
 * is executed here on the twin; the PostgreSQL restore paths are only checked at source level (see
 * the last block) — they were NOT executed (PostgreSQL may not be run in this environment).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import express from "express";

const root = mkdtempSync(join(tmpdir(), "motard-migration-"));
process.env.DB_ENGINE = "sqlite";
process.env.SQLITE_PATH = join(root, "data", "motard.db");
process.env.MOTARD_STARTUP_STATE = "FRESH";
process.env.MOTARD_INSTALLATION_ID ??= randomUUID();
process.env.MOTARD_INSTALL_INSTANCE_ID ??= randomUUID();
process.env.MOTARD_DATA_ID ??= randomUUID();
process.env.HUB_CONFIG_PATH = join(root, "hub.json");
process.env.HUB_SESSION_PATH = join(root, "hub-session.json");
delete process.env.DATABASE_URL;
delete process.env.DESKTOP_SEED_PATH;
delete process.env.CENTRAL_SYNC_URL;
delete process.env.HUB_WRITE_FREEZE;

type BetterDb = import("better-sqlite3").Database;
const TENANT = randomUUID();
const USER = randomUUID();
const DEVICE = randomUUID();
const CUSTOMER = randomUUID();
const FABRIC = randomUUID();
const COLOR = randomUUID();
let ROLL = "";

let runtime: typeof import("@/infrastructure/orm/sqlite/runtime.js");
let tx: typeof import("@/infrastructure/orm/sqlite/transaction.js");
let container: import("@/infrastructure/di/container.js").Container;
let syncUc: typeof import("@/application/use-cases/sync/syncUseCases.js");
let hubConfig: typeof import("@/application/use-cases/sync/hubConfig.js");
let numberBlocks: typeof import("@/application/use-cases/sync/numberBlockUseCases.js");
let withTenant: typeof import("@/infrastructure/orm/tenant-context.js").runWithTenantContext;

/* ── fake hub (one HTTP server; `server` is the instance currently behind the address) ──────── */
type HubUnit = {
  opId: string;
  syncDeviceId: string | null;
  entityType: string;
  entityId: string;
  operation: string;
  payload: Record<string, unknown>;
  receivedSeq: number;
  receivedAt: string;
  appliedAt: string | null;
};
type HubInstance = {
  epoch: string;
  units: HubUnit[];
  /** op id → number of times it was delivered (dedupe = uq_sync_inbox_tenant_op). */
  delivered: Map<string, number>;
  tipReports: Array<{ entityType: string; knownUsed: number }>;
  frozen?: boolean;
};
const instance = (epoch: string = randomUUID()): HubInstance => ({
  epoch,
  units: [],
  delivered: new Map(),
  tipReports: [],
});
let server: HubInstance = instance();
const pulls: Array<{ afterSeq: string | null }> = [];
let http_: http.Server;
let hubUrl = "";

const ctx = () =>
  ({
    tenantId: TENANT,
    userId: USER,
    userRole: "admin",
    userName: "mig",
    syncDeviceId: DEVICE,
  }) as never;
const writer = () => runtime.getSqliteRuntime()!.conns.writer as unknown as BetterDb;

function saleUnit(invoiceId: string, number: string, kg: number) {
  return {
    invoiceId,
    invoiceNumber: number,
    invoiceType: "sale",
    createInput: {
      type: "sale",
      date: "2026-10-01",
      partyId: CUSTOMER,
      partyType: "customer",
      currency: "USD",
      lines: [
        {
          fabricId: FABRIC,
          colorId: COLOR,
          rollId: ROLL,
          quantityKg: kg,
          pieces: 1,
          pricePerKg: 10,
        },
      ],
    },
  };
}
function peerUnit(invoiceId: string, number: string, seq: number): HubUnit {
  return {
    opId: randomUUID(),
    syncDeviceId: randomUUID(), // another shop PC
    entityType: "invoice",
    entityId: invoiceId,
    operation: "create",
    payload: saleUnit(invoiceId, number, 1),
    receivedSeq: seq,
    receivedAt: new Date().toISOString(),
    appliedAt: new Date().toISOString(),
  };
}

beforeAll(async () => {
  http_ = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://hub");
    res.setHeader("Content-Type", "application/json");
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      if (url.pathname === "/api/sync/pull") {
        const after = url.searchParams.get("afterSeq");
        pulls.push({ afterSeq: after });
        const items = server.units.filter((u) => after === null || u.receivedSeq > Number(after));
        const head = server.units.length
          ? Math.max(...server.units.map((u) => u.receivedSeq))
          : null;
        return res.end(JSON.stringify({ items, hubEpoch: server.epoch, headSeq: head }));
      }
      if (url.pathname === "/api/sync/push") {
        if (server.frozen) {
          res.statusCode = 503;
          return res.end(JSON.stringify({ code: "HUB_WRITE_FROZEN" }));
        }
        const unit = JSON.parse(body) as { opId: string };
        server.delivered.set(unit.opId, (server.delivered.get(unit.opId) ?? 0) + 1);
        return res.end(JSON.stringify({ materialized: true, hubStatus: "applied" }));
      }
      if (url.pathname === "/api/sync/number-blocks/tip") {
        server.tipReports.push(JSON.parse(body));
        return res.end(JSON.stringify({ ok: true }));
      }
      res.end(JSON.stringify({ items: [] }));
    });
  });
  await new Promise<void>((r) => http_.listen(0, "127.0.0.1", r));
  hubUrl = `http://127.0.0.1:${(http_.address() as AddressInfo).port}`;

  runtime = await import("@/infrastructure/orm/sqlite/runtime.js");
  tx = await import("@/infrastructure/orm/sqlite/transaction.js");
  await runtime.ensureSqliteRuntime();
  await tx.runInTransaction(async (t) => {
    await t.execute(sql`INSERT INTO tenants (id, name, slug) VALUES (${TENANT}, 'Mig Co', 'mig')`);
    await t.execute(sql`INSERT INTO users (id, tenant_id, name, email, password_hash, role)
                        VALUES (${USER}, ${TENANT}, 'مدير', 'mig@local.test', 'x', 'admin')`);
    await t.execute(sql`INSERT INTO sync_devices (id, tenant_id, device_fingerprint, platform)
                        VALUES (${DEVICE}, ${TENANT}, 'fp-mig', 'windows')`);
    await t.execute(sql`INSERT INTO parties (id, tenant_id, name, code, kind, currency)
                        VALUES (${CUSTOMER}, ${TENANT}, 'C', 'MIG-C', 'customer', 'USD')`);
    await t.execute(
      sql`INSERT INTO fabrics (id, tenant_id, name) VALUES (${FABRIC}, ${TENANT}, 'F')`,
    );
    await t.execute(
      sql`INSERT INTO colors (id, tenant_id, fabric_id, name) VALUES (${COLOR}, ${TENANT}, ${FABRIC}, 'C')`,
    );
    // This device already issued invoice numbers up to 9300 (its local tip covers its blocks).
    await t.execute(sql`INSERT INTO document_sequences (id, tenant_id, entity_type, prefix, last_number)
                        VALUES (${randomUUID()}, ${TENANT}, 'invoice', 'INV', 9300)`);
  });
  const { buildContainer } = await import("@/infrastructure/di/container.js");
  container = buildContainer();
  syncUc = await import("@/application/use-cases/sync/syncUseCases.js");
  hubConfig = await import("@/application/use-cases/sync/hubConfig.js");
  numberBlocks = await import("@/application/use-cases/sync/numberBlockUseCases.js");
  withTenant = (await import("@/infrastructure/orm/tenant-context.js")).runWithTenantContext;
  const roll = await withTenant({ tenantId: TENANT } as never, () =>
    container.rollRepo.create(
      {
        colorId: COLOR,
        rollNo: "R-MIG-1",
        initialKg: 50,
        remainingKg: 50,
        pieces: 10,
        pricePerKg: 4,
        currency: "USD",
        entryDate: "2026-09-01",
      } as never,
      ctx(),
    ),
  );
  ROLL = roll.id;
  // Paired with the hub at hubUrl (what «حفظ وربط» leaves behind).
  writeFileSync(process.env.HUB_CONFIG_PATH!, JSON.stringify({ url: hubUrl }));
  writeFileSync(
    process.env.HUB_SESSION_PATH!,
    JSON.stringify({
      accessToken: "hub-token",
      hubUrl,
      hubDeviceId: DEVICE,
      localTenantId: TENANT,
      localUserId: USER,
    }),
  );
}, 120_000);

afterAll(async () => {
  await new Promise((r) => http_.close(r));
  runtime?.shutdownSqliteRuntime();
  rmSync(root, { recursive: true, force: true });
});

const repos = () =>
  ({
    invoiceRepo: container.invoiceRepo,
    voucherRepo: container.voucherRepo,
    returnRepo: container.returnRepo,
    orderRepo: container.orderRepo,
    expenseRepo: container.expenseRepo,
    auditRepo: container.auditRepo,
    partyRepo: container.partyRepo,
    fabricRepo: container.fabricRepo,
    colorRepo: container.colorRepo,
    rollRepo: container.rollRepo,
    ledgerRepo: container.ledgerRepo,
    statementRepo: container.statementRepo,
    cashboxRepo: container.cashboxRepo,
    settingsRepo: container.settingsRepo,
    companyRepo: container.companyRepo,
  }) as never;

/** The actions the real sync route passes (sync.route.ts pullWith). */
const rebaseActions = () => ({
  requeueSynced: (tenantId: string) => container.syncOutboxRepo.requeueSyncedForNewHub(tenantId),
  reassertNumberTips: async () => {
    await numberBlocks.reassertNumberTipsOnHub({ tenantId: TENANT, syncDeviceId: DEVICE });
  },
});
const pull = (withActions = true) =>
  withTenant({ tenantId: TENANT } as never, () =>
    syncUc.runLocalSyncPull(
      tx.sqliteDb() as never,
      repos(),
      ctx(),
      undefined,
      DEVICE,
      container.syncInboxRepo,
      undefined,
      undefined,
      withActions ? rebaseActions() : undefined,
    ),
  );
const push = () =>
  withTenant({ tenantId: TENANT } as never, () =>
    syncUc.runLocalSyncPush(
      container.syncOutboxRepo,
      container.invoiceRepo,
      container.auditRepo,
      container.notificationRepo,
      ctx(),
      undefined,
    ),
  );
async function materialize(entityType: string, payload: Record<string, unknown>) {
  const { materializeSyncUnit } = await import("@/application/use-cases/sync/syncMaterialize.js");
  return withTenant({ tenantId: TENANT } as never, () =>
    materializeSyncUnit(
      tx.sqliteDb() as never,
      repos(),
      { entityType, operation: "create", payload },
      ctx(),
    ),
  );
}
const count = (q: string, ...a: unknown[]) =>
  Number(
    (
      writer()
        .prepare(q)
        .get(...a) as { n: number }
    ).n,
  );
const remainingKg = () =>
  Number(
    (
      writer().prepare("SELECT remaining_kg AS k FROM rolls WHERE id = ?").get(ROLL) as {
        k: number;
      }
    ).k,
  );
const cursor = async () => {
  const { getSyncStateStore } = await import("@/infrastructure/repositories/engineStores.js");
  return (await (await getSyncStateStore()).getPullCursor(TENANT)).lastPullSeq;
};
const setCursor = async (seq: number) => {
  const { getSyncStateStore } = await import("@/infrastructure/repositories/engineStores.js");
  const store = await getSyncStateStore();
  await store.resetPullCursor(TENANT);
  await store.setPullCursor(TENANT, seq, new Date());
};
const enqueue = (opId: string) =>
  withTenant({ tenantId: TENANT } as never, () =>
    container.syncOutboxRepo.enqueue({
      tenantId: TENANT,
      syncDeviceId: DEVICE,
      opId,
      entityType: "party",
      entityId: randomUUID(),
      operation: "update",
      payload: {},
    } as never),
  );
const settleOutbox = () =>
  withTenant({ tenantId: TENANT } as never, async () => {
    for (const u of await container.syncOutboxRepo.claimBatch(TENANT, 500, 60_000, "settle"))
      await container.syncOutboxRepo.markSynced(u.id, TENANT, u.leaseToken!);
  });

describe("MIG-01/02 — the device detects a new hub instance (decision rule)", () => {
  it("rebase on a changed epoch or a stream head below the cursor; adopt the first epoch; else none", () => {
    const d = (k: string | null, h: string | null, head: number | null, c: number | null) =>
      syncUc.decideHubRebase({ knownEpoch: k, hubEpoch: h, headSeq: head, cursor: c });
    expect(d("E1", "E2", 50, 10)).toEqual({ kind: "rebase", reason: "HUB_EPOCH_CHANGED" });
    expect(d("E1", "E1", 5, 900)).toEqual({ kind: "rebase", reason: "HUB_STREAM_REWOUND" });
    expect(d(null, "E1", 5, 900)).toEqual({ kind: "rebase", reason: "HUB_STREAM_REWOUND" });
    expect(d(null, "E1", 50, 10)).toEqual({ kind: "adopt" });
    expect(d("E1", "E1", 50, 10)).toEqual({ kind: "none" });
    expect(d("E1", null, null, 10)).toEqual({ kind: "none" }); // a hub that predates epochs
    expect(d("E1", "E1", 50, null)).toEqual({ kind: "none" });
  });
});

describe("MIG-01 — hub instance identity (epoch) on the hub side", () => {
  it("is stable across reads (restarts), changes on rotation, and is new when the stored row is gone (restore)", async () => {
    const { getHubEpoch, rotateHubEpoch, HUB_EPOCH_KEY } =
      await import("@/application/use-cases/sync/hubIdentity.js");
    const hubTenant = randomUUID();
    writer()
      .prepare("INSERT INTO tenants (id, name, slug) VALUES (?, 'Hub E', ?)")
      .run(hubTenant, `e-${hubTenant.slice(0, 6)}`);
    const inTenant = <T>(fn: () => Promise<T>) => withTenant({ tenantId: hubTenant } as never, fn);
    const a = await inTenant(() => getHubEpoch(container, hubTenant));
    const b = await inTenant(() => getHubEpoch(container, hubTenant));
    expect(b.epoch).toBe(a.epoch);
    const c = await inTenant(() => rotateHubEpoch(container, hubTenant, "cutover to new VPS"));
    expect(c.epoch).not.toBe(a.epoch);
    expect(c.reason).toBe("cutover to new VPS");
    // What both restore paths do (DELETE the secrets row) — the next read is a new instance.
    await inTenant(() => container.secretsRepo.delete(hubTenant, HUB_EPOCH_KEY));
    const d = await inTenant(() => getHubEpoch(container, hubTenant));
    expect(d.epoch).not.toBe(c.epoch);
  });

  it("the pull stream head (maxAppliedSeq) is the highest applied unit, so a device cursor above it is detectable", async () => {
    const hubTenant = randomUUID();
    writer()
      .prepare("INSERT INTO tenants (id, name, slug) VALUES (?, 'Hub U', ?)")
      .run(hubTenant, `u-${hubTenant.slice(0, 6)}`);
    expect(await container.syncInboxRepo.maxAppliedSeq(hubTenant)).toBeNull();
    for (let i = 0; i < 3; i++) {
      await container.syncInboxRepo.receive({
        tenantId: hubTenant,
        opId: randomUUID(),
        entityType: "invoice",
        entityId: randomUUID(),
        operation: "create",
        payload: {},
        status: "applied",
      } as never);
    }
    const all = await container.syncInboxRepo.listAppliedSince(hubTenant, null, { limit: 100 });
    const head = await container.syncInboxRepo.maxAppliedSeq(hubTenant);
    expect(head).toBe(Math.max(...all.map((u) => Number(u.appliedSeq))));
    expect(
      syncUc.decideHubRebase({
        knownEpoch: "E",
        hubEpoch: "E",
        headSeq: head,
        cursor: head! + 1000,
      }),
    ).toEqual({ kind: "rebase", reason: "HUB_STREAM_REWOUND" });
  });

  it("context for the restore fix: the applied_seq trigger re-stamps a row inserted as applied (why both restore paths load with it disabled)", () => {
    const d = writer();
    const hubTenant = randomUUID();
    d.prepare("INSERT INTO tenants (id, name, slug) VALUES (?, 'Hub T', ?)").run(
      hubTenant,
      `h-${hubTenant.slice(0, 6)}`,
    );
    const id = randomUUID();
    d.prepare(
      `INSERT INTO sync_inbox (id, tenant_id, op_id, entity_type, entity_id, operation, payload, status, received_seq, applied_seq)
       VALUES (?, ?, ?, 'invoice', ?, 'create', '{}', 'applied', 900, 900)`,
    ).run(id, hubTenant, randomUUID(), randomUUID());
    const after = d.prepare("SELECT applied_seq AS s FROM sync_inbox WHERE id = ?").get(id) as {
      s: number;
    };
    expect(after.s).not.toBe(900);
  });
});

describe("duplicate-invoice prevention", () => {
  it("an invoice unit delivered again after a server switch is applied once (stock and ledger move once)", async () => {
    const id = randomUUID();
    const kgBefore = remainingKg();
    expect((await materialize("invoice", saleUnit(id, "INV-2026-9001", 2))).status).toBe("created");
    const ledger = count("SELECT count(*) AS n FROM ledger_entries WHERE reference_id = ?", id);
    expect(ledger).toBeGreaterThan(0);
    const kgAfter = remainingKg();
    expect(kgAfter).toBeLessThan(kgBefore);
    expect((await materialize("invoice", saleUnit(id, "INV-2026-9001", 2))).status).toBe("exists");
    expect(count("SELECT count(*) AS n FROM invoices WHERE id = ?", id)).toBe(1);
    expect(count("SELECT count(*) AS n FROM ledger_entries WHERE reference_id = ?", id)).toBe(
      ledger,
    );
    expect(remainingKg()).toBe(kgAfter);
    const unit = {
      tenantId: TENANT,
      opId: randomUUID(),
      entityType: "invoice",
      entityId: id,
      operation: "create",
      payload: {},
    } as never;
    expect((await container.syncInboxRepo.receive(unit)).created).toBe(true);
    expect((await container.syncInboxRepo.receive(unit)).created).toBe(false);
  });
});

describe("MIG-01/02/06 — acceptance: a move behind the SAME address", () => {
  it("epoch changed: the device resets its cursor, re-pulls the new server's units, re-reports its number tip — and a repeated sync changes nothing", async () => {
    hubConfig.rememberHubEpoch("E-OLD");
    await setCursor(100); // position reached on the OLD server
    const peer = randomUUID();
    server = instance("E-NEW");
    server.units = [peerUnit(peer, "INV-2026-9101", 7)]; // the new server numbers anew
    pulls.length = 0;

    const r = await pull();
    expect(r.rebased?.reason).toBe("HUB_EPOCH_CHANGED");
    expect(pulls.map((p) => p.afterSeq)).toEqual(["100", null]); // detected, then from the start
    expect(count("SELECT count(*) AS n FROM invoices WHERE id = ?", peer)).toBe(1);
    expect(await cursor()).toBe(7);
    expect(hubConfig.getHubSessionInfo()?.hubEpoch).toBe("E-NEW");
    // MIG-06: the new instance learned this device's highest issued invoice number.
    const tip = server.tipReports.find((t) => t.entityType === "invoice");
    expect(tip?.knownUsed).toBeGreaterThanOrEqual(9300);

    // Repeated sync: no second rebase, no duplicate.
    const again = await pull();
    expect(again.rebased).toBeUndefined();
    expect(count("SELECT count(*) AS n FROM invoices WHERE id = ?", peer)).toBe(1);
  });

  it("same epoch but the stream was rewound (restored sequence): the device re-pulls instead of skipping", async () => {
    const peer = randomUUID();
    // Device cursor is 7 (previous test). The restored server lost unit 7 and numbers anew from 3.
    server.units = [peerUnit(peer, "INV-2026-9102", 3)];
    const r = await pull();
    expect(r.rebased?.reason).toBe("HUB_STREAM_REWOUND");
    expect(count("SELECT count(*) AS n FROM invoices WHERE id = ?", peer)).toBe(1);
    expect(await cursor()).toBe(3);
  });

  it("without rebase actions a changed instance is held, never skipped: nothing applied, cursor unchanged", async () => {
    const peer = randomUUID();
    const before = await cursor();
    server = instance("E-OTHER");
    server.units = [peerUnit(peer, "INV-2026-9103", 2)];
    const r = await pull(false);
    expect(r.rebaseRequired).toBe("HUB_EPOCH_CHANGED");
    expect(r.applied).toBe(0);
    expect(await cursor()).toBe(before);
    expect(count("SELECT count(*) AS n FROM invoices WHERE id = ?", peer)).toBe(0);
    const ok = await pull(); // the real route always passes the actions
    expect(ok.rebased?.reason).toBe("HUB_EPOCH_CHANGED");
    expect(count("SELECT count(*) AS n FROM invoices WHERE id = ?", peer)).toBe(1);
  });
});

describe("offline changes across a switch, freeze and rollback (acceptance)", () => {
  it("cutover: pending work and work the OLD server acknowledged both reach the NEW server; repeated sync sends nothing more", async () => {
    await settleOutbox();
    const delivered = randomUUID();
    await enqueue(delivered);
    await withTenant({ tenantId: TENANT } as never, async () => {
      const [u] = await container.syncOutboxRepo.claimBatch(TENANT, 1, 60_000, "old-hub");
      expect(u.opId).toBe(delivered);
      await container.syncOutboxRepo.markSynced(u.id, TENANT, u.leaseToken!); // old server acked
    });
    const offline = randomUUID();
    await enqueue(offline); // made while the hub was unreachable during the move

    // New server, restored from a copy taken BEFORE `delivered` arrived.
    server = instance("E-CUTOVER");
    await push();
    expect(server.delivered.get(offline)).toBe(1);
    expect(server.delivered.has(delivered)).toBe(false); // the device has not seen the new epoch yet

    const r = await pull(); // sees the new epoch → re-queues its delivered history
    expect(r.rebased?.reason).toBe("HUB_EPOCH_CHANGED");
    await push();
    expect(server.delivered.get(delivered)).toBe(1);
    // `offline` is re-delivered once more; the real hub answers it from its inbox (op id unique).
    expect(server.delivered.get(offline)).toBe(2);
    expect(await container.syncOutboxRepo.countOutstanding(TENANT)).toBe(0);

    const total = () => [...server.delivered.values()].reduce((a, b) => a + b, 0);
    const before = total();
    await pull();
    await push();
    expect(total()).toBe(before);
  });

  it("freeze: pushes to a frozen server are refused with 503 and stay pending; they go through after the freeze", async () => {
    const op = randomUUID();
    await enqueue(op);
    server.frozen = true;
    await push();
    expect(server.delivered.has(op)).toBe(false);
    expect(await container.syncOutboxRepo.countOutstanding(TENANT)).toBe(1);
    server.frozen = false;
    await push();
    expect(server.delivered.get(op)).toBe(1);
    expect(await container.syncOutboxRepo.countOutstanding(TENANT)).toBe(0);
  });

  it("rollback: switching back to the OLD server (epoch rotated by the runbook) re-delivers what was made on the new one, each op once", async () => {
    const madeOnNew = randomUUID();
    await enqueue(madeOnNew);
    await push(); // delivered to the NEW server
    expect(server.delivered.get(madeOnNew)).toBe(1);

    const oldServer = instance("E-ROLLBACK"); // DNS back; epoch rotated on the old server
    server = oldServer;
    const r = await pull();
    expect(r.rebased?.reason).toBe("HUB_EPOCH_CHANGED");
    await push();
    expect(oldServer.delivered.get(madeOnNew)).toBe(1);
    expect([...oldServer.delivered.values()].every((n) => n === 1)).toBe(true);
    expect(await container.syncOutboxRepo.countOutstanding(TENANT)).toBe(0);
  });

  it("rollback (hub side): units the new server holds and the old one lacks are found by op id and replay idempotently", async () => {
    const invoiceId = randomUUID();
    const unit = {
      opId: randomUUID(),
      entityType: "invoice",
      entityId: invoiceId,
      operation: "create",
      payload: saleUnit(invoiceId, "INV-2026-9201", 1),
    };
    const oldOps = new Set(
      (await container.syncInboxRepo.listAppliedSince(TENANT, null, { limit: 100 })).map(
        (u) => u.opId,
      ),
    );
    const delta = [...oldOps, unit.opId].filter((op) => !oldOps.has(op));
    expect(delta).toEqual([unit.opId]);
    for (let round = 0; round < 2; round++) {
      const r = await withTenant({ tenantId: TENANT } as never, () =>
        container.syncInboxRepo.receive({ tenantId: TENANT, ...unit } as never),
      );
      expect(r.created).toBe(round === 0);
      expect((await materialize("invoice", unit.payload)).status).toBe(
        round === 0 ? "created" : "exists",
      );
    }
    expect(count("SELECT count(*) AS n FROM invoices WHERE id = ?", invoiceId)).toBe(1);
  });
});

describe("MIG-04 — write freeze and pre-cutover verification", () => {
  it("HUB_WRITE_FREEZE=1 refuses mutations with 503 and keeps reads, sign-in, integrity and epoch rotation", async () => {
    const { hubWriteFreezeGuard } =
      await import("@/infrastructure/http/middleware/hubWriteFreeze.middleware.js");
    const app = express().use(hubWriteFreezeGuard());
    app.use((_q, r) => void r.json({ ok: true }));
    const srv = app.listen(0);
    await new Promise<void>((r) => srv.once("listening", () => r()));
    const base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
    const call = (method: string, path: string) =>
      fetch(base + path, { method }).then((r) => r.status);
    try {
      process.env.HUB_WRITE_FREEZE = "1";
      expect(await call("POST", "/api/invoices")).toBe(503);
      expect(await call("POST", "/api/sync/push")).toBe(503);
      expect(await call("GET", "/api/invoices")).toBe(200);
      expect(await call("POST", "/api/auth/login")).toBe(200);
      expect(await call("GET", "/api/integrity/fingerprint")).toBe(200);
      expect(await call("POST", "/api/sync/hub/identity/rotate")).toBe(200);
      delete process.env.HUB_WRITE_FREEZE;
      expect(await call("POST", "/api/invoices")).toBe(200);
    } finally {
      delete process.env.HUB_WRITE_FREEZE;
      await new Promise<void>((r) => srv.close(() => r()));
    }
  });

  it("fingerprint: identical when nothing changed; a write names the table, the balance, the roll and the stream head", async () => {
    const { takeHubFingerprint, compareFingerprints } =
      await import("@/infrastructure/integrity/hubFingerprint.js");
    const a = await takeHubFingerprint(TENANT);
    const b = await takeHubFingerprint(TENANT);
    expect(compareFingerprints(a, b)).toEqual({ ok: true, differences: [], warnings: [] });
    expect(a.tables.invoices.rows).toBeGreaterThan(0);
    expect(a.tables.secrets).toBeUndefined(); // differs by design between hosts

    await materialize("invoice", saleUnit(randomUUID(), "INV-2026-9301", 3));
    await container.syncInboxRepo.receive({
      tenantId: TENANT,
      opId: randomUUID(),
      entityType: "invoice",
      entityId: randomUUID(),
      operation: "create",
      payload: {},
      status: "applied",
    } as never);
    const c = await takeHubFingerprint(TENANT);
    const diff = compareFingerprints(a, c);
    expect(diff.ok).toBe(false);
    expect(diff.differences.some((d) => d.startsWith("table invoices:"))).toBe(true);
    expect(diff.differences.some((d) => d.startsWith("table ledger_entries:"))).toBe(true);
    expect(diff.differences.some((d) => d.startsWith("balance "))).toBe(true);
    expect(diff.differences.some((d) => d.startsWith(`roll ${ROLL}`))).toBe(true);
    expect(diff.differences.some((d) => d.startsWith("sync stream head"))).toBe(true);
  });

  it("compare: audit_logs is a warning only; another company or engine is a failure", async () => {
    const { compareFingerprints } =
      await import("@/infrastructure/integrity/hubFingerprintCompare.js");
    const base = {
      tenantId: "t",
      engine: "postgres",
      takenAt: "",
      tables: { audit_logs: { rows: 1, sha256: "a" }, invoices: { rows: 2, sha256: "x" } },
      balances: [],
      stock: [],
      stream: { headAppliedSeq: 5, inboxByStatus: {} },
    };
    const r = compareFingerprints(base, {
      ...base,
      tables: { ...base.tables, audit_logs: { rows: 2, sha256: "b" } },
    });
    expect(r.ok).toBe(true);
    expect(r.warnings).toHaveLength(1);
    expect(compareFingerprints(base, { ...base, tenantId: "u" }).ok).toBe(false);
    expect(compareFingerprints(base, { ...base, engine: "sqlite" }).ok).toBe(false);
  });
});

describe("MIG-06 — number counter re-report (hub side)", () => {
  it("raiseTip advances the counter without carving a block, never lowers it, and is bounded (+2000 per call)", async () => {
    const { getNumberBlockStore } = await import("@/infrastructure/repositories/engineStores.js");
    const store = await getNumberBlockStore();
    const blocks = () =>
      count("SELECT count(*) AS n FROM document_number_blocks WHERE tenant_id = ?", TENANT);
    const blocksBefore = blocks();
    const tipOf = () =>
      Number(
        (
          writer()
            .prepare(
              "SELECT last_number AS n FROM document_sequences WHERE tenant_id = ? AND entity_type = 'invoice'",
            )
            .get(TENANT) as { n: number }
        ).n,
      );
    const raise = (knownUsed: number) =>
      withTenant({ tenantId: TENANT } as never, () =>
        store.raiseTip({ tenantId: TENANT, entityType: "invoice", knownUsed }),
      );
    const start = tipOf();
    await raise(start + 50);
    expect(tipOf()).toBe(start + 50);
    await raise(1);
    expect(tipOf()).toBe(start + 50); // never lowers
    await raise(start + 99_000);
    expect(tipOf()).toBe(start + 50 + 2000); // bounded, like claimBlock's tip reconciliation
    expect(blocks()).toBe(blocksBefore);
  });

  it("raiseNumberTip refuses a device that is not this company's", async () => {
    await expect(
      withTenant({ tenantId: TENANT } as never, () =>
        numberBlocks.raiseNumberTip({
          tenantId: TENANT,
          syncDeviceId: randomUUID(),
          entityType: "invoice",
          knownUsed: 10,
        }),
      ),
    ).rejects.toThrow();
  });
});

describe("MIG-03 — hub backup scheduler (orchestration; the PostgreSQL export itself is not executed)", () => {
  it("writes .partial, verifies, then keeps the archive; a failed verification is never listed and nothing is deleted", async () => {
    const { runHubBackupOnce, newestHubBackupAgeMs } =
      await import("@/infrastructure/backup/hubBackupScheduler.js");
    const dir = join(root, "hub-backups");
    const verified: string[] = [];
    const results = await runHubBackupOnce(dir, {
      listTenants: async () => ["good", "bad"],
      createBackup: async (_t, out) => writeFileSync(out, "zip"),
      verifyBackup: async (file) => {
        if (file.includes("-bad-")) throw new Error("manifest checksum mismatch");
        verified.push(file);
      },
      now: () => new Date("2026-10-12T02:00:00Z"),
    });
    expect(results.map((r) => [r.tenantId, r.ok])).toEqual([
      ["good", true],
      ["bad", false],
    ]);
    const names = readdirSync(dir).sort();
    expect(names.filter((n) => n.endsWith(".zip"))).toEqual([
      "hub-backup-good-20261012-020000.zip",
    ]);
    expect(names.some((n) => n.endsWith(".zip.failed"))).toBe(true);
    expect(names.some((n) => n.endsWith(".partial"))).toBe(false);
    expect(verified).toHaveLength(1);
    expect(newestHubBackupAgeMs(dir)).not.toBeNull();
    await runHubBackupOnce(dir, {
      listTenants: async () => ["good"],
      createBackup: async (_t, out) => writeFileSync(out, "zip"),
      verifyBackup: async () => undefined,
      now: () => new Date("2026-10-13T02:00:00Z"),
    });
    expect(existsSync(join(dir, "hub-backup-good-20261012-020000.zip"))).toBe(true);
    expect(readdirSync(dir).filter((n) => n.endsWith(".zip"))).toHaveLength(2);
  });
});

describe("MIG-08 — preflight on the new host", () => {
  it("reports a missing licence, readable secrets, the hub epoch and devices without a hub credential", async () => {
    const { cutoverPreflight } = await import("@/infrastructure/integrity/cutoverPreflight.js");
    const r = await cutoverPreflight(container, TENANT);
    const by = Object.fromEntries(r.checks.map((c) => [c.name, c.status]));
    expect(by.license).toBe("failed"); // this test company has none
    expect(r.ok).toBe(false);
    expect(by["master-key"]).toBe("ok");
    expect(by["hub-epoch"]).toBe("ok");
    expect(by["device-credentials"]).toBe("warning"); // DEVICE has no sync.device.cred.* here
    expect(by["jwt-secret"]).toBe("ok");
  });
});

describe("MIG-02/07 — PostgreSQL restore paths (source contract only — NOT executed)", () => {
  const read = (p: string) => readFileSync(join(__dirname, "..", "..", p), "utf8");
  it("portable v2 restore advances sync_inbox_applied_seq, drops the hub epoch and ends pre-restore sessions", () => {
    const src = read("src/infrastructure/backup/portableBackup.ts");
    expect(src).toMatch(/seq: "sync_inbox_applied_seq", tbl: "sync_inbox", col: "applied_seq"/);
    expect(src).toMatch(/for \(const sa of STANDALONE_SEQUENCES\)/);
    expect(src).toMatch(/DELETE FROM secrets WHERE tenant_id = \$1 AND key = \$2/);
    expect(src).toMatch(/UPDATE users SET tokens_revoked_before = now\(\) WHERE tenant_id = \$1/);
    expect(src.indexOf("of STANDALONE_SEQUENCES")).toBeLessThan(
      src.indexOf('await live.query("COMMIT")'),
    );
  });
  it("portable v2 backups now carry revoked_tokens and idempotency_keys (still not secrets)", async () => {
    const { DEVICE_BOUND_TABLES } = await import("@/infrastructure/backup/deviceBoundTables.js");
    expect(DEVICE_BOUND_TABLES.has("revoked_tokens")).toBe(false);
    expect(DEVICE_BOUND_TABLES.has("idempotency_keys")).toBe(false);
    expect(DEVICE_BOUND_TABLES.has("secrets")).toBe(true);
  });
  it("restore-from-backup.mjs loads with the applied_seq trigger disabled and advances its sequence", () => {
    const src = read("scripts/restore-from-backup.mjs");
    const off = src.indexOf("DISABLE TRIGGER trg_sync_inbox_applied_seq");
    const insert = src.indexOf("for (const table of INSERT_ORDER)");
    const on = src.indexOf("ENABLE TRIGGER trg_sync_inbox_applied_seq");
    expect(off).toBeGreaterThan(0);
    expect(off).toBeLessThan(insert);
    expect(on).toBeGreaterThan(insert);
    expect(src).toMatch(/setval\('sync_inbox_applied_seq'::regclass/);
    expect(src).toMatch(/DELETE FROM secrets WHERE tenant_id = \$1 AND key = 'sync.hub.epoch'/);
    expect(src).toMatch(/UPDATE users SET tokens_revoked_before = now\(\)/);
  });
});
