/**
 * T109 — restore on a synced device (OQ-12, SY-6, SY-7; owner decision 2026-10-05, option b).
 * reconcileRestoredSnapshot through in-memory ports: new identity, pause, auto-pull, own op-ids
 * acknowledged (never re-pushed, never re-applied), resume.
 */
import { describe, expect, it } from "vitest";
import { reconcileRestoredSnapshot, type RestoreReconcileDeps } from "../src/application/use-cases/sync/syncRestoreUseCases.js";
import type { ISyncRestoreStateStore, SyncRestoreState } from "../src/application/ports/ISyncRestoreStateStore.js";
import type { PulledUnit } from "../src/application/use-cases/sync/syncUseCases.js";

const TENANT = "11111111-1111-4111-8111-111111111111";
const ctx = { tenantId: TENANT, userId: "22222222-2222-4222-8222-222222222222", userRole: "admin", userName: "t" } as never;
const OLD = "33333333-3333-4333-8333-333333333333";
const NEW = "44444444-4444-4444-8444-444444444444";
const FP = "a".repeat(64);

function memoryStore(initial: SyncRestoreState | null): ISyncRestoreStateStore & { state: SyncRestoreState | null } {
  const s = {
    state: initial,
    get: async () => (s.state ? { ...s.state } : null),
    setRegistered: async (id: string) => {
      if (s.state?.phase === "register") s.state = { ...s.state, newDeviceId: id, phase: "pull", lastError: null };
    },
    addProgress: async (p: number, a: number) => {
      if (s.state) s.state = { ...s.state, pulled: s.state.pulled + p, acknowledged: s.state.acknowledged + a };
    },
    setError: async (m: string | null) => {
      if (s.state) s.state = { ...s.state, lastError: m };
    },
    markDone: async () => {
      if (s.state?.phase === "pull") s.state = { ...s.state, phase: "done", lastError: null };
    },
  };
  return s;
}

const restored = (): SyncRestoreState => ({
  restoredAt: "2026-10-05T00:00:00.000000Z",
  generation: 1,
  previousDeviceIds: [OLD],
  newDeviceId: null,
  phase: "register",
  pulled: 0,
  acknowledged: 0,
  lastError: null,
});

const unit = (opId: string): PulledUnit => ({ opId, syncDeviceId: OLD, entityType: "invoice", entityId: opId, operation: "create", payload: {} }) as never;

function deps(over: Partial<RestoreReconcileDeps> & { outboxStatus: Map<string, string>; pages: PulledUnit[][]; applied: string[]; registered: unknown[] }) {
  const { outboxStatus, pages, applied, registered } = over;
  const base: RestoreReconcileDeps = {
    store: memoryStore(restored()),
    outbox: {
      acknowledgeByOpId: async (_t: string, opId: string) => {
        const st = outboxStatus.get(opId);
        if (!st) return "unknown";
        if (st === "synced") return "settled";
        outboxStatus.set(opId, "synced");
        return "acknowledged";
      },
    } as never,
    devices: {
      findById: async (_t: string, id: string) => (id === OLD ? { id: OLD, deviceFingerprint: FP, deviceFingerprintVersion: 1, platform: "windows", hostname: "PC-1", label: "PC-1" } : null),
      registerOrTouch: async (input: unknown) => {
        registered.push(input);
        return {} as never;
      },
    } as never,
    registerOnHub: async (device) => {
      registered.push({ hub: device });
      return { ok: true, id: device.id };
    },
    pullPage: async (_deviceId, isOwn) => {
      const page = pages.shift() ?? [];
      let acknowledged = 0;
      for (const u of page) {
        if (await isOwn(u)) acknowledged += 1;
        else applied.push(u.opId);
      }
      return { pulled: page.length, failed: 0, acknowledged };
    },
    newId: () => NEW,
  };
  return { ...base, ...over } as RestoreReconcileDeps;
}

describe("restore on a synced device (T109, option b)", () => {
  it("does nothing when the database was not restored from a synced snapshot", async () => {
    const d = deps({ store: memoryStore(null), outboxStatus: new Map(), pages: [], applied: [], registered: [] });
    expect(await reconcileRestoredSnapshot(d, ctx)).toBeNull();
  });

  it("registers a NEW identity (new id and fingerprint), pulls the newer hub data and resumes", async () => {
    const outboxStatus = new Map([
      ["op-synced-before-backup", "synced"],
      ["op-pending-at-backup", "pending"], // pushed after the backup: the hub already holds it
      ["op-never-pushed", "pending"], // never reached the hub: stays pending, pushed normally later
    ]);
    const applied: string[] = [];
    const registered: Array<Record<string, unknown>> = [];
    const store = memoryStore(restored());
    const d = deps({
      store,
      outboxStatus,
      applied,
      registered,
      pages: [[unit("op-synced-before-backup"), unit("op-pending-at-backup"), unit("op-post-backup-work"), unit("op-peer")], []],
    });
    const r = await reconcileRestoredSnapshot(d, ctx);

    const hubReg = registered.find((x) => "hub" in x)!.hub as { id: string; fingerprint: string };
    expect(hubReg.id).toBe(NEW);
    expect(hubReg.fingerprint).not.toBe(FP);
    expect(hubReg.fingerprint.startsWith(FP)).toBe(true);
    expect(hubReg.fingerprint.length).toBeLessThanOrEqual(128);
    expect(registered.some((x) => (x as { deviceId?: string }).deviceId === NEW)).toBe(true); // local registry too

    // own operations are not re-applied; the one still pending is acknowledged (never re-pushed)
    expect(applied).toEqual(["op-post-backup-work", "op-peer"]);
    expect(outboxStatus.get("op-pending-at-backup")).toBe("synced");
    expect(outboxStatus.get("op-never-pushed")).toBe("pending");

    expect(r).toMatchObject({ paused: false, phase: "done", deviceId: NEW, pulled: 4, acknowledged: 2, error: null });
    expect(store.state?.phase).toBe("done");
  });

  it("retires the previous identity's stale number blocks and reserves fresh ones for the new identity", async () => {
    const calls: string[] = [];
    const d = deps({ store: memoryStore(restored()), outboxStatus: new Map(), applied: [], registered: [], pages: [[]] });
    d.numberBlocks = {
      retire: async (id) => {
        calls.push(`retire:${id}`);
        return 4;
      },
      ensure: async (id) => {
        calls.push(`ensure:${id}`);
      },
    };
    await reconcileRestoredSnapshot(d, ctx);
    expect(calls).toEqual([`retire:${OLD}`, `ensure:${NEW}`]);
  });

  it("stays paused when the hub refuses the registration, and retries on the next run", async () => {
    const store = memoryStore(restored());
    const d = deps({
      store,
      outboxStatus: new Map(),
      applied: [],
      registered: [],
      pages: [],
      registerOnHub: async () => ({ ok: false, error: "hub unreachable" }),
    });
    const r = await reconcileRestoredSnapshot(d, ctx);
    expect(r).toMatchObject({ paused: true, phase: "register", deviceId: null, error: "hub unreachable" });
    expect(store.state?.phase).toBe("register");
  });

  it("stays paused while a pulled unit waits for a dependency (cursor held)", async () => {
    const store = memoryStore(restored());
    const d = deps({ store, outboxStatus: new Map(), applied: [], registered: [], pages: [] });
    d.pullPage = async () => ({ pulled: 3, failed: 1, acknowledged: 0 });
    const r = await reconcileRestoredSnapshot(d, ctx);
    expect(r).toMatchObject({ paused: true, phase: "pull", deviceId: NEW });
  });

  it("after completion keeps reporting the new identity for every later run", async () => {
    const store = memoryStore({ ...restored(), phase: "done", newDeviceId: NEW });
    const d = deps({ store, outboxStatus: new Map(), applied: [], registered: [], pages: [] });
    expect(await reconcileRestoredSnapshot(d, ctx)).toMatchObject({ paused: false, phase: "done", deviceId: NEW });
  });
});
