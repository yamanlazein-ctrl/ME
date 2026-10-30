// Sync parity harness (constitution IV gate 2, research R11, tasks T051). Three nodes on one disposable hub:
//
//   hub     the unchanged cloud backend (PostgreSQL), started from a fresh clone of the AC-8 template database;
//   desktop the unchanged desktop backend in SQLite mode, a real process driven through its HTTP API;
//   phone   the mobile core (src/core) in THIS process over a temp SQLite file (real better-sqlite3 behind the same
//           shim interface the app uses), with the phone's adapters, hub fetch wrapper and sync cycle.
//
// It reuses the AC-8 topology helpers (scripts/parity/lib/syncAc8.mjs). Needs PostgreSQL: CERT_PG_URL=<admin url>.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  setRuntimeCentralSyncUrl,
  persistHubSession,
} from "@backend/application/use-cases/sync/hubConfig";
import { openNodeShim } from "../helpers/nodeSqlite";
import { createPhone, type Phone } from "../../src/core/phone";
import { openRuntime } from "../../src/core/runtime";
import { installHubFetch } from "../../src/core/hubHttp";
import { applyPhoneConfig } from "../../src/platform/envConfig";
import type { ShimDatabase } from "../../src/platform/sqlite/types";
import { compareBusinessFiles } from "../../scripts/compare-db.mjs";

const repoRoot = path.resolve(__dirname, "../../..");

interface Child {
  exitCode: number | null;
  pid?: number;
}

/** Kills a process and its descendants (`tsx` starts the server as a child of the wrapper it spawns). */
function killTree(pid: number | undefined): void {
  if (!pid) return;
  let kids: number[] = [];
  try {
    kids = execFileSync("ps", ["-o", "pid=", "--ppid", String(pid)], { encoding: "utf8" })
      .split("\n")
      .map((l) => Number(l.trim()))
      .filter((n) => n > 0);
  } catch {
    kids = [];
  }
  for (const k of kids) killTree(k);
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    /* already gone */
  }
}
/** The few JSON fields the parity tests read from hub/desktop answers. */
export interface ApiJson {
  id?: string;
  version?: number;
  number?: string;
  data?: Array<Record<string, unknown>>;
  sessions?: unknown[];
  ensured?: unknown[];
  [key: string]: unknown;
}
export interface DeviceClient {
  (
    method: string,
    path: string,
    body?: unknown,
  ): Promise<{ status: number; json: ApiJson | null; text: string }>;
  deviceId?: string;
}
interface Ac8 {
  TENANT_ID: string;
  USER_ID: string;
  DEV_A: string;
  DEV_B: string;
  JWT_HUB: string;
  JWT_A: string;
  DATE: string;
  dbUrl(admin: string, db: string): string;
  ensurePgTemplate(admin: string, refresh: boolean): Promise<void>;
  clonePg(admin: string, db: string): Promise<void>;
  seedPg(url: string, label: string): Promise<void>;
  withClient<T>(
    url: string,
    fn: (c: {
      query: (sql: string, p?: unknown[]) => Promise<{ rows: Array<Record<string, unknown>> }>;
    }) => Promise<T>,
  ): Promise<T>;
  createSqlite(file: string, label: string): void;
  nodeEnv(extra: Record<string, string>): Record<string, string>;
  startNode(name: string, env: Record<string, string>, log: string): Child & { __log: string };
  waitHealthy(port: number, child: Child): Promise<void>;
  kill(child: Child): void;
  mintToken(secret: string): Promise<string>;
  client(port: number, token: string, deviceId: string): DeviceClient;
  must(
    call: DeviceClient,
    label: string,
    method: string,
    path: string,
    body?: unknown,
  ): Promise<ApiJson>;
  syncUntilDrained(
    call: DeviceClient,
    maxRounds?: number,
  ): Promise<Array<{ pushed?: number; pull?: { pulled?: number } }>>;
}

export async function loadAc8(): Promise<Ac8> {
  const url = pathToFileURL(path.join(repoRoot, "scripts/parity/lib/syncAc8.mjs")).href;
  return (await import(/* @vite-ignore */ url)) as Ac8;
}

export function parityAvailable(): boolean {
  return Boolean(process.env.CERT_PG_URL);
}

export interface Parity {
  /** Scratch directory with the node logs (hub.log, desktop.log). */
  work: string;
  ac8: Ac8;
  hub: { port: number; url: string; token: string; call: DeviceClient; dbUrl: string };
  desktop: { call: DeviceClient; deviceId: string; dbFile: string };
  phone: Phone & { dbFile: string; conn: ShimDatabase };
  /** Push and pull on desktop and phone until neither moves anything. */
  syncAll(maxRounds?: number): Promise<void>;
  /** Phone vs desktop business tables, then hub vs phone vs desktop party balances, cashbox and document sets. */
  compareAll(): Promise<string[]>;
  stop(): Promise<void>;
}

const sorted = (rows: Array<Record<string, unknown>>) =>
  rows
    .map((r) =>
      JSON.stringify(
        Object.keys(r)
          .sort()
          .map((k) => [k, String(r[k])]),
      ),
    )
    .sort();

export async function startParity(basePort = 18200): Promise<Parity> {
  const cleanups: Array<() => Promise<void> | void> = [];
  try {
    return await startParityInner(basePort, cleanups);
  } catch (error) {
    // A half-started harness must not leak backend processes into the next run.
    for (const c of cleanups.reverse()) {
      try {
        await c();
      } catch {
        /* best effort */
      }
    }
    throw error;
  }
}

async function startParityInner(
  basePort: number,
  cleanups: Array<() => Promise<void> | void>,
): Promise<Parity> {
  // The AC-8 helpers spawn backend processes that validate their environment.
  process.env.JWT_SECRET ??= "parity-harness-jwt-secret-key-32-chars!!";
  process.env.APP_MASTER_KEY ??= "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa=";
  const ac8 = await loadAc8();
  const admin = process.env.CERT_PG_URL;
  if (!admin) throw new Error("CERT_PG_URL is required for the parity harness");
  const work = mkdtempSync(path.join(tmpdir(), "motard-mobile-parity-"));
  const hubDb = `erp_parity_${Date.now()}`;
  const children: Child[] = [];
  cleanups.push(() => {
    for (const c of children) killTree(c.pid);
  });

  await ac8.ensurePgTemplate(admin, false);
  await ac8.clonePg(admin, hubDb);
  await ac8.seedPg(ac8.dbUrl(admin, hubDb), "hub");
  const hubDbUrl = ac8.dbUrl(admin, hubDb);

  const hubPort = basePort + 1;
  const hubProc = ac8.startNode(
    "hub",
    ac8.nodeEnv({
      DB_ENGINE: "postgres",
      DATABASE_URL: hubDbUrl,
      PORT: String(hubPort),
      JWT_SECRET: ac8.JWT_HUB,
    }),
    path.join(work, "hub.log"),
  );
  children.push(hubProc);
  await ac8.waitHealthy(hubPort, hubProc);
  const hubUrl = `http://127.0.0.1:${hubPort}`;
  const hubToken = await ac8.mintToken(ac8.JWT_HUB);

  // desktop: a real SQLite desktop backend paired with the hub (device A).
  const desktopPort = basePort + 2;
  const desktopDir = path.join(work, "desktop");
  mkdirSync(desktopDir, { recursive: true });
  const desktopFile = path.join(desktopDir, "motard.db");
  ac8.createSqlite(desktopFile, "desktop");
  // A paired desktop: its session names its sync device (otherwise the block claim registers a fingerprint-derived second device).
  const desktopSession = path.join(desktopDir, "hub-session.json");
  writeFileSync(
    desktopSession,
    JSON.stringify({
      accessToken: hubToken,
      hubUrl,
      hubTenantId: ac8.TENANT_ID,
      hubUserId: ac8.USER_ID,
      hubDeviceId: ac8.DEV_A,
      localTenantId: ac8.TENANT_ID,
      localUserId: ac8.USER_ID,
    }),
  );
  const desktopProc = ac8.startNode(
    "desktop",
    ac8.nodeEnv({
      DB_ENGINE: "sqlite",
      SQLITE_PATH: desktopFile,
      MOTARD_STARTUP_STATE: "OPEN_EXISTING",
      PORT: String(desktopPort),
      JWT_SECRET: ac8.JWT_A,
      CENTRAL_SYNC_URL: hubUrl,
      HUB_SESSION_PATH: desktopSession,
    }),
    path.join(work, "desktop.log"),
  );
  children.push(desktopProc);
  await ac8.waitHealthy(desktopPort, desktopProc);
  const desktop = ac8.client(desktopPort, await ac8.mintToken(ac8.JWT_A), ac8.DEV_A);
  desktop.deviceId = ac8.DEV_A;

  // phone: this process (device B), over a temp SQLite file.
  const phoneFile = path.join(work, "phone", "motard.db");
  mkdirSync(path.dirname(phoneFile), { recursive: true });
  const conn = openNodeShim(phoneFile);
  const runtime = openRuntime(conn);
  conn.exec("PRAGMA foreign_keys = OFF");
  conn
    .prepare(
      "INSERT INTO tenants (id, name, slug, status, license_status, license_type) VALUES (?, 'AC-8 Tenant', 'ac8-desktop', 'active', 'no_license', 'trial')",
    )
    .run(ac8.TENANT_ID);
  conn
    .prepare(
      "INSERT INTO users (id, tenant_id, name, email, password_hash, role, active) VALUES (?, ?, 'AC-8 Admin', 'admin-desktop@ac8.local', 'not-used-tokens-are-minted', 'admin', 1)",
    )
    .run(ac8.USER_ID, ac8.TENANT_ID);
  conn
    .prepare(
      "INSERT INTO setup_wizard_state (tenant_id, current_step, completed_steps, is_completed, completed_at) VALUES (?, 'done', '[\"welcome\"]', 1, ?)",
    )
    .run(ac8.TENANT_ID, new Date().toISOString().replace("Z", "000Z"));
  conn.exec("PRAGMA foreign_keys = ON");
  const phone = createPhone(runtime, {
    tenantId: ac8.TENANT_ID,
    syncDeviceId: ac8.DEV_B,
    user: { id: ac8.USER_ID, name: "AC-8 Admin", role: "admin" },
  });
  await phone.repos.syncDeviceRepo.registerOrTouch({
    tenantId: ac8.TENANT_ID as never,
    userId: ac8.USER_ID as never,
    deviceFingerprint: "fp-device-b",
    deviceFingerprintVersion: 1,
    platform: "android",
    hostname: "phone",
    label: "phone",
    deviceId: ac8.DEV_B as never,
  });
  applyPhoneConfig({ CENTRAL_SYNC_URL: hubUrl });
  setRuntimeCentralSyncUrl(hubUrl);
  persistHubSession({
    accessToken: hubToken,
    hubUrl,
    hubTenantId: ac8.TENANT_ID,
    hubUserId: ac8.USER_ID,
    hubDeviceId: ac8.DEV_B,
    localTenantId: ac8.TENANT_ID,
    localUserId: ac8.USER_ID,
  });
  const restoreFetch = installHubFetch(() => undefined);

  const hubCall = ac8.client(hubPort, hubToken, ac8.DEV_B);

  const syncAll = async (maxRounds = 8) => {
    for (let i = 0; i < maxRounds; i++) {
      const d = await ac8.syncUntilDrained(desktop, 4);
      const p = await phone.syncOnce();
      const moved =
        d.length > 1 ||
        (d[0]?.pushed ?? 0) + (d[0]?.pull?.pulled ?? 0) > 0 ||
        p.push.pushed + p.push.failed + p.push.rejected + p.pull.pulled > 0;
      if (!moved) return;
    }
  };

  const compareAll = async (): Promise<string[]> => {
    const diffs: string[] = [];
    await syncAll();
    for (const d of compareBusinessFiles(phoneFile, desktopFile, "phone", "desktop")) {
      diffs.push(`phone↔desktop ${d}`);
    }
    // Party balances and counts: hub vs desktop vs phone.
    const balances = async (call: DeviceClient) => {
      const r = await call("GET", "/api/reports/party-balances?kind=customer");
      return sorted((r.json?.data ?? []) as Array<Record<string, unknown>>);
    };
    const hubBalances = await balances(hubCall);
    const desktopBalances = await balances(desktop);
    const phoneBalances = sorted(
      (await phone.repos.reportsRepo.partyBalances(ac8.TENANT_ID, "customer")) as unknown as Array<
        Record<string, unknown>
      >,
    );
    if (JSON.stringify(hubBalances) !== JSON.stringify(desktopBalances))
      diffs.push("party balances: hub ≠ desktop");
    if (JSON.stringify(hubBalances) !== JSON.stringify(phoneBalances))
      diffs.push("party balances: hub ≠ phone");
    const cashbox = async (call: DeviceClient) =>
      JSON.stringify((await call("GET", "/api/cashbox/state")).json?.sessions ?? []);
    const hubCash = await cashbox(hubCall);
    if (hubCash !== (await cashbox(desktop))) diffs.push("cashbox state: hub ≠ desktop");
    return diffs;
  };

  const stop = async () => {
    restoreFetch();
    try {
      phone.close();
    } catch {
      /* already closed */
    }
    for (const c of children) killTree(c.pid);
    await new Promise((r) => setTimeout(r, 1000));
    try {
      await ac8.withClient(admin, async (c) => {
        await c.query(`DROP DATABASE IF EXISTS "${hubDb}" WITH (FORCE)`);
        return null;
      });
    } catch {
      /* best effort */
    }
    rmSync(work, { recursive: true, force: true });
  };

  return {
    work,
    ac8,
    hub: { port: hubPort, url: hubUrl, token: hubToken, call: hubCall, dbUrl: hubDbUrl },
    desktop: { call: desktop, deviceId: ac8.DEV_A, dbFile: desktopFile },
    phone: Object.assign(phone, { dbFile: phoneFile, conn }),
    syncAll,
    compareAll,
    stop,
  };
}
