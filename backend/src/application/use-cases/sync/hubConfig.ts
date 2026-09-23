import fs from "node:fs";
import path from "node:path";
import { config } from "../../../infrastructure/config/env.js";
import { logger } from "../../../infrastructure/config/logger.js";

type HubSession = {
  accessToken: string;
  refreshToken?: string;
  /**
   * Pairing metadata captured at connect time (Settings → المزامنة السحابية).
   * Optional so sessions written by older builds (tokens only) still load.
   */
  hubUrl?: string;
  hubTenantId?: string;
  hubUserId?: string;
  hubUserEmail?: string;
  hubUserName?: string;
  hubUserRole?: string;
  hubLicenseKey?: string | null;
  hubLicenseStatus?: string | null;
  /** Local sync-device id registered on the hub under the SAME id (push attribution). */
  hubDeviceId?: string | null;
  pairedAt?: string;
};

export type HubSessionInfo = Omit<HubSession, "accessToken" | "refreshToken">;

let runtimeHubUrl: string | null = null;
let runtimeSession: HubSession | null = null;
let hubReachable: boolean | null = null;
let lastProbeAt = 0;

const PROBE_TTL_MS = 15_000;

function trimUrl(raw: string | null | undefined): string | null {
  const t = raw?.trim().replace(/\/+$/, "") ?? "";
  if (!t) return null;
  try {
    const u = new URL(t);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    return t;
  } catch {
    return null;
  }
}

function configPath(): string | null {
  const p = process.env.HUB_CONFIG_PATH?.trim();
  return p && p.length > 0 ? p : null;
}

function sessionPath(): string | null {
  const p = process.env.HUB_SESSION_PATH?.trim();
  return p && p.length > 0 ? p : null;
}

function readHubUrlFile(): string | null {
  const file = configPath();
  if (!file) return null;
  try {
    const raw = fs.readFileSync(file, "utf8");
    const parsed = JSON.parse(raw) as { url?: unknown };
    return typeof parsed.url === "string" ? trimUrl(parsed.url) : null;
  } catch {
    return null;
  }
}

function readSessionFile(): HubSession | null {
  const file = sessionPath();
  if (!file) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as Partial<HubSession>;
    if (typeof parsed.accessToken !== "string" || parsed.accessToken.length < 8) return null;
    return {
      ...parsed,
      accessToken: parsed.accessToken,
      refreshToken: typeof parsed.refreshToken === "string" ? parsed.refreshToken : undefined,
    };
  } catch {
    return null;
  }
}

export function getCentralSyncUrl(): string | null {
  if (runtimeHubUrl) return runtimeHubUrl;
  const fromEnv = trimUrl(config.CENTRAL_SYNC_URL);
  if (fromEnv) return fromEnv;
  return readHubUrlFile();
}

export function setRuntimeCentralSyncUrl(url: string | null): string | null {
  const normalized = trimUrl(url);
  runtimeHubUrl = normalized;
  const file = configPath();
  if (file) {
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      if (normalized) {
        fs.writeFileSync(file, JSON.stringify({ url: normalized }, null, 2), "utf8");
      } else if (fs.existsSync(file)) {
        fs.unlinkSync(file);
      }
    } catch (err) {
      logger.warn({ err }, "failed to persist hub.json");
    }
  }
  hubReachable = null;
  return normalized;
}

export function persistHubSession(session: HubSession | null): void {
  runtimeSession = session;
  const file = sessionPath();
  if (!file) return;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    if (!session) {
      if (fs.existsSync(file)) fs.unlinkSync(file);
      return;
    }
    fs.writeFileSync(file, JSON.stringify(session), { encoding: "utf8", mode: 0o600 });
  } catch (err) {
    logger.warn({ err }, "failed to persist hub session");
  }
}

function loadSession(): HubSession | null {
  if (runtimeSession?.accessToken) return runtimeSession;
  const fromEnv = process.env.HUB_SYNC_ACCESS_TOKEN?.trim();
  if (fromEnv) {
    runtimeSession = {
      accessToken: fromEnv,
      refreshToken: process.env.HUB_SYNC_REFRESH_TOKEN?.trim() || undefined,
    };
    return runtimeSession;
  }
  runtimeSession = readSessionFile();
  return runtimeSession;
}

/**
 * Authorization header for hub transport. Prefers a hub-issued session so
 * each desktop can keep its own JWT_SECRET. Falls back to the caller's local
 * bearer (lab topologies that share a signing secret).
 */
export async function resolveHubAuthHeader(localAuthHeader?: string): Promise<string | undefined> {
  const session = loadSession();
  if (session?.accessToken) return `Bearer ${session.accessToken}`;
  return localAuthHeader;
}

export async function refreshHubSession(): Promise<boolean> {
  const hub = getCentralSyncUrl();
  const session = loadSession();
  if (!hub || !session?.refreshToken) return false;
  try {
    const res = await fetch(`${hub}/api/auth/refresh`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ refreshToken: session.refreshToken }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) return false;
    const body = (await res.json()) as { accessToken?: string; refreshToken?: string };
    if (!body.accessToken) return false;
    persistHubSession({
      ...session,
      accessToken: body.accessToken,
      refreshToken: body.refreshToken ?? session.refreshToken,
    });
    return true;
  } catch (err) {
    logger.warn({ err }, "hub session refresh failed");
    return false;
  }
}

export async function pairHubSession(input: {
  url: string;
  email?: string;
  password?: string;
  userId?: string;
  pin?: string;
  tenantId?: string;
}): Promise<{ ok: true; url: string } | { ok: false; error: string }> {
  const url = setRuntimeCentralSyncUrl(input.url);
  if (!url) return { ok: false, error: "رابط الخادم المركزي غير صالح" };

  try {
    const loginPath = input.pin && input.userId ? "/api/auth/pin-login" : "/api/auth/login";
    const body =
      input.pin && input.userId
        ? { userId: input.userId, pin: input.pin, tenantId: input.tenantId }
        : { email: input.email, password: input.password, tenantId: input.tenantId };
    const res = await fetch(`${url}${loginPath}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(20_000),
    });
    const json = (await res.json().catch(() => ({}))) as {
      accessToken?: string;
      refreshToken?: string;
      message?: string;
    };
    if (!res.ok || !json.accessToken) {
      return { ok: false, error: json.message || `فشل تسجيل الدخول للمركز (${res.status})` };
    }
    persistHubSession({
      accessToken: json.accessToken,
      refreshToken: json.refreshToken,
    });
    hubReachable = true;
    lastProbeAt = Date.now();
    return { ok: true, url };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : "تعذّر الاتصال بالمركز",
    };
  }
}

export function isHubReachableCached(): boolean | null {
  return hubReachable;
}

export async function probeHubReachable(force = false): Promise<boolean> {
  const hub = getCentralSyncUrl();
  if (!hub) {
    hubReachable = null;
    return true;
  }
  if (!force && Date.now() - lastProbeAt < PROBE_TTL_MS && hubReachable !== null) {
    return hubReachable;
  }
  try {
    const res = await fetch(`${hub}/api/health/live`, {
      method: "GET",
      signal: AbortSignal.timeout(4_000),
    });
    hubReachable = res.ok;
  } catch {
    hubReachable = false;
  }
  lastProbeAt = Date.now();
  return hubReachable;
}

export function markHubUnreachable(): void {
  if (getCentralSyncUrl()) {
    hubReachable = false;
    lastProbeAt = Date.now();
  }
}

export function isServerSideOffline(): boolean {
  if (!getCentralSyncUrl()) return false;
  return hubReachable === false;
}

// ── Settings → «المزامنة السحابية» (admin-only pairing surface) ──────────────

export function getHubSessionInfo(): HubSessionInfo | null {
  const session = loadSession();
  if (!session?.accessToken) return null;
  const { accessToken: _a, refreshToken: _r, ...info } = session;
  void _a;
  void _r;
  return info;
}

/** Forget the URL and the session (disk + memory). */
export function disconnectHub(): void {
  persistHubSession(null);
  setRuntimeCentralSyncUrl(null);
  hubReachable = null;
}

export type HubTestResult = {
  url: string;
  reachable: boolean;
  latencyMs: number | null;
  /** Hub answered /api/setup/status: false = its install gate still refuses logins. */
  setupCompleted: boolean | null;
  error: string | null;
};

/** Ping a hub WITHOUT changing any saved configuration. */
export async function testHubConnection(rawUrl: string): Promise<HubTestResult> {
  const url = trimUrl(rawUrl);
  if (!url) {
    return {
      url: rawUrl,
      reachable: false,
      latencyMs: null,
      setupCompleted: null,
      error: "رابط غير صالح",
    };
  }
  const started = Date.now();
  try {
    const res = await fetch(`${url}/api/health/live`, { signal: AbortSignal.timeout(6_000) });
    const latencyMs = Date.now() - started;
    if (!res.ok) {
      return {
        url,
        reachable: false,
        latencyMs,
        setupCompleted: null,
        error: `الخادم رد بـ ${res.status}`,
      };
    }
    let setupCompleted: boolean | null = null;
    try {
      const s = await fetch(`${url}/api/setup/status`, { signal: AbortSignal.timeout(6_000) });
      if (s.ok) {
        const body = (await s.json()) as { isCompleted?: boolean };
        setupCompleted = typeof body.isCompleted === "boolean" ? body.isCompleted : null;
      }
    } catch {
      /* status is informative only */
    }
    return { url, reachable: true, latencyMs, setupCompleted, error: null };
  } catch (err) {
    return {
      url,
      reachable: false,
      latencyMs: null,
      setupCompleted: null,
      error: err instanceof Error ? err.message : "تعذّر الاتصال",
    };
  }
}

function decodeJwtClaims(token: string): Record<string, unknown> {
  // Hub tokens are signed with the HUB's secret — they cannot be verified here
  // and need not be: they are only read for display; the hub verifies them.
  try {
    const part = token.split(".")[1] ?? "";
    return JSON.parse(Buffer.from(part, "base64url").toString("utf8")) as Record<string, unknown>;
  } catch {
    return {};
  }
}

export type ConnectHubInput = {
  url: string;
  email: string;
  password: string;
  /** The local sync device, registered on the hub under the same id. */
  device: {
    id: string;
    fingerprint: string;
    fingerprintVersion: number;
    platform: string;
    hostname: string | null;
    label: string | null;
  } | null;
};

export type ConnectHubResult =
  | { ok: true; info: HubSessionInfo; hubChanged: boolean; deviceWarning: string | null }
  | { ok: false; error: string; stage: "url" | "reach" | "login" | "role" };

/**
 * Full pairing: verifies the hub, logs in, reads the hub identity + license,
 * registers this device on the hub under its LOCAL id, then replaces the old
 * session. The device step matters: the outbox stamps the local sync-device id
 * on every unit, so a hub that does not know that id refuses every push as
 * SYNC_UNKNOWN_DEVICE.
 */
export async function connectHub(input: ConnectHubInput): Promise<ConnectHubResult> {
  const url = trimUrl(input.url);
  if (!url) return { ok: false, stage: "url", error: "رابط الخادم المركزي غير صالح" };

  const previous = loadSession();
  const test = await testHubConnection(url);
  if (!test.reachable) {
    return { ok: false, stage: "reach", error: test.error ?? "الخادم المركزي لا يستجيب" };
  }
  if (test.setupCompleted === false) {
    return {
      ok: false,
      stage: "reach",
      error: "الخادم المركزي لم يُكمل الإعداد (setup_wizard_state) — لا يقبل تسجيل الدخول بعد",
    };
  }

  let loginRes: Response;
  try {
    loginRes = await fetch(`${url}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: input.email, password: input.password }),
      signal: AbortSignal.timeout(20_000),
    });
  } catch (err) {
    return {
      ok: false,
      stage: "login",
      error: err instanceof Error ? err.message : "تعذّر الاتصال",
    };
  }
  const login = (await loginRes.json().catch(() => ({}))) as {
    accessToken?: string;
    refreshToken?: string;
    message?: string;
    user?: { id?: string; name?: string; email?: string; role?: string };
  };
  if (!loginRes.ok || !login.accessToken) {
    return {
      ok: false,
      stage: "login",
      error: login.message || `فشل تسجيل الدخول للمركز (${loginRes.status})`,
    };
  }
  const role = login.user?.role ?? "";
  if (role !== "admin" && role !== "accountant") {
    return {
      ok: false,
      stage: "role",
      error: "حساب المركز يجب أن يكون مديراً أو محاسباً ليتمكن من دفع العمليات",
    };
  }

  const auth = `Bearer ${login.accessToken}`;
  const claims = decodeJwtClaims(login.accessToken);

  let hubLicenseKey: string | null = null;
  let hubLicenseStatus: string | null = null;
  try {
    const lr = await fetch(`${url}/api/license/status`, {
      headers: { Authorization: auth },
      signal: AbortSignal.timeout(10_000),
    });
    if (lr.ok) {
      const lb = (await lr.json()) as { license?: { key?: string; status?: string } };
      hubLicenseKey = lb.license?.key ?? null;
      hubLicenseStatus = lb.license?.status ?? null;
    }
  } catch {
    /* license display is best-effort */
  }

  let hubDeviceId: string | null = null;
  let deviceWarning: string | null = null;
  if (input.device) {
    try {
      const dr = await fetch(`${url}/api/auth/sync-device`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: auth },
        body: JSON.stringify({
          deviceId: input.device.id,
          deviceFingerprint: input.device.fingerprint,
          deviceFingerprintVersion: input.device.fingerprintVersion,
          platform: input.device.platform,
          hostname: input.device.hostname ?? undefined,
          label: input.device.label ?? input.device.hostname ?? undefined,
        }),
        signal: AbortSignal.timeout(15_000),
      });
      const body = (await dr.json().catch(() => ({}))) as { id?: string; message?: string };
      if (dr.ok && body.id) {
        hubDeviceId = body.id;
        // registerOrTouch falls back to an existing row with the same
        // fingerprint. Pushes carry the LOCAL id, so a different hub id means
        // the hub will still refuse them — say so instead of pretending.
        if (body.id !== input.device.id) {
          deviceWarning =
            "المركز يعرف هذا الجهاز بمعرّف آخر — قد تُرفض المزامنة. ألغِ الجهاز القديم من المركز ثم أعد الربط";
        }
      } else {
        deviceWarning = body.message || `تعذّر تسجيل الجهاز في المركز (${dr.status})`;
      }
    } catch (err) {
      deviceWarning = err instanceof Error ? err.message : "تعذّر تسجيل الجهاز في المركز";
    }
  } else {
    deviceWarning = "لا يوجد جهاز مزامنة محلي مسجّل لهذه الجلسة — سجّل الخروج والدخول ثم أعد الربط";
  }

  const info: HubSessionInfo = {
    hubUrl: url,
    hubTenantId: typeof claims.tenantId === "string" ? claims.tenantId : undefined,
    hubUserId: login.user?.id ?? (typeof claims.sub === "string" ? claims.sub : undefined),
    hubUserEmail: login.user?.email ?? input.email,
    hubUserName: login.user?.name,
    hubUserRole: role,
    hubLicenseKey,
    hubLicenseStatus,
    hubDeviceId,
    pairedAt: new Date().toISOString(),
  };

  // Clean slate: drop the old session before writing the new one.
  persistHubSession(null);
  setRuntimeCentralSyncUrl(url);
  persistHubSession({ accessToken: login.accessToken, refreshToken: login.refreshToken, ...info });
  hubReachable = true;
  lastProbeAt = Date.now();
  localActivityCursor = null;

  const hubChanged =
    !previous ||
    (previous.hubUrl !== undefined && previous.hubUrl !== url) ||
    (previous.hubTenantId !== undefined && previous.hubTenantId !== info.hubTenantId);
  return { ok: true, info, hubChanged, deviceWarning };
}

// ── Cross-device activity feed (presence: «سجّل المحاسب دخوله الآن») ─────────
//
// Logins are not business data and never enter the outbox, so they travel
// through a small ephemeral feed on the hub. In-memory by design: a presence
// toast only matters for a few minutes; a hub restart loses nothing of value.

export type HubActivityEvent = {
  seq: number;
  kind: "login";
  userName: string;
  userRole: string | null;
  deviceLabel: string | null;
  sourceDeviceId: string | null;
  at: string;
};

const ACTIVITY_MAX = 200;
const ACTIVITY_TTL_MS = 15 * 60_000;
const activityByTenant = new Map<string, HubActivityEvent[]>();
let activitySeq = 0;

/** Hub side: record an event reported by a paired device. */
export function recordHubActivity(
  tenantId: string,
  event: Omit<HubActivityEvent, "seq" | "at">,
): HubActivityEvent {
  const row: HubActivityEvent = { ...event, seq: ++activitySeq, at: new Date().toISOString() };
  const list = activityByTenant.get(tenantId) ?? [];
  list.push(row);
  const cutoff = Date.now() - ACTIVITY_TTL_MS;
  while (list.length > ACTIVITY_MAX || (list[0] && Date.parse(list[0].at) < cutoff)) list.shift();
  activityByTenant.set(tenantId, list);
  return row;
}

/** Hub side: events after a cursor. `afterSeq` null → only the last 2 minutes. */
export function listHubActivity(tenantId: string, afterSeq: number | null): HubActivityEvent[] {
  const list = activityByTenant.get(tenantId) ?? [];
  if (afterSeq === null) {
    const recent = Date.now() - 2 * 60_000;
    return list.filter((e) => Date.parse(e.at) >= recent);
  }
  // A hub restart resets the sequence — a cursor above the current max is stale.
  if (afterSeq > activitySeq) return list;
  return list.filter((e) => e.seq > afterSeq);
}

async function hubFetch(pathname: string, init: RequestInit = {}): Promise<Response | null> {
  const hub = getCentralSyncUrl();
  const auth = await resolveHubAuthHeader();
  if (!hub || !auth) return null;
  const doFetch = (authorization: string) =>
    fetch(`${hub}${pathname}`, {
      ...init,
      headers: { "Content-Type": "application/json", Authorization: authorization },
      signal: AbortSignal.timeout(10_000),
    });
  let res = await doFetch(auth);
  if (res.status === 401 && (await refreshHubSession())) {
    const refreshed = await resolveHubAuthHeader();
    if (refreshed) res = await doFetch(refreshed);
  }
  return res;
}

/** Device side: fire-and-forget «user X logged in on device Y». */
export async function announceHubActivity(
  event: Omit<HubActivityEvent, "seq" | "at">,
): Promise<void> {
  try {
    await hubFetch("/api/sync/activity", { method: "POST", body: JSON.stringify(event) });
  } catch (err) {
    logger.debug({ err }, "hub activity announce failed");
  }
}

let localActivityCursor: number | null = null;

/** Device side: new presence events from OTHER devices. */
export async function pullHubActivity(ownDeviceId: string | null): Promise<HubActivityEvent[]> {
  const qs = localActivityCursor === null ? "" : `?afterSeq=${localActivityCursor}`;
  const res = await hubFetch(`/api/sync/activity${qs}`, { method: "GET" });
  if (!res?.ok) return [];
  const body = (await res.json().catch(() => ({}))) as { items?: HubActivityEvent[] };
  const items = body.items ?? [];
  for (const e of items) {
    if (localActivityCursor === null || e.seq > localActivityCursor) localActivityCursor = e.seq;
  }
  return items.filter((e) => !ownDeviceId || e.sourceDeviceId !== ownDeviceId);
}
