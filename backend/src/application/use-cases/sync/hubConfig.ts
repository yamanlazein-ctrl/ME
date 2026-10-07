import fs from "node:fs";
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
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
  /** Local tenant/user the background sync runs as when nobody is logged in. */
  localTenantId?: string;
  localUserId?: string;
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
  // hub.json lost but the pairing was never removed: the stored credentials
  // still name the hub.
  return readHubUrlFile() ?? loadHubCredentials()?.url ?? null;
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
  let session = loadSession();
  if (!session?.accessToken && (await reloginWithStoredCredentials())) session = loadSession();
  if (session?.accessToken) return `Bearer ${session.accessToken}`;
  return localAuthHeader;
}

// ── Stored hub credentials ──────────────────────────────────────────────────
// The pairing (URL + email + password) stays until the operator presses
// «فصل». Tokens expire, a hub can restart with a new signing secret, a session
// file can be lost — none of that may silently unpair the device and leave it
// "connected" without syncing. The password is kept only encrypted
// (AES-256-GCM, key derived from this install's APP_MASTER_KEY) and is used
// solely to sign in to the hub again when the session cannot be refreshed.
// Two shapes: a device credential (enrollment code / converted pairing — the
// hub account never leaves the hub), or the legacy account of older pairings.
type StoredCredentials = {
  url: string;
  email?: string;
  password?: string;
  tenantId?: string;
  deviceId?: string;
  deviceSecret?: string;
};

function credentialsPath(): string | null {
  const explicit = process.env.HUB_CREDENTIALS_PATH?.trim();
  if (explicit) return explicit;
  const session = sessionPath();
  return session ? path.join(path.dirname(session), "hub-credentials.dat") : null;
}

function credentialsKey(): Buffer {
  return createHash("sha256").update(`hub-credentials:${config.APP_MASTER_KEY}`).digest();
}

export function saveHubCredentials(creds: StoredCredentials | null): void {
  const file = credentialsPath();
  if (!file) return;
  try {
    if (!creds) {
      if (fs.existsSync(file)) fs.unlinkSync(file);
      return;
    }
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", credentialsKey(), iv);
    const ct = Buffer.concat([cipher.update(JSON.stringify(creds), "utf8"), cipher.final()]);
    const blob = { v: 1, iv: iv.toString("base64"), tag: cipher.getAuthTag().toString("base64"), ct: ct.toString("base64") };
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(blob), { encoding: "utf8", mode: 0o600 });
  } catch (err) {
    logger.warn({ err }, "failed to persist hub credentials");
  }
}

export function loadHubCredentials(): StoredCredentials | null {
  const file = credentialsPath();
  if (!file || !fs.existsSync(file)) return null;
  try {
    const blob = JSON.parse(fs.readFileSync(file, "utf8")) as { iv: string; tag: string; ct: string };
    const decipher = createDecipheriv("aes-256-gcm", credentialsKey(), Buffer.from(blob.iv, "base64"));
    decipher.setAuthTag(Buffer.from(blob.tag, "base64"));
    const plain = Buffer.concat([decipher.update(Buffer.from(blob.ct, "base64")), decipher.final()]);
    const parsed = JSON.parse(plain.toString("utf8")) as StoredCredentials;
    const usable = (parsed.email && parsed.password) || (parsed.tenantId && parsed.deviceId && parsed.deviceSecret);
    return parsed.url && usable ? parsed : null;
  } catch (err) {
    logger.warn({ err }, "stored hub credentials unreadable");
    return null;
  }
}

/**
 * Account for «حفظ وربط». Typed values win; blanks fall back to the stored
 * account, so changing only the hub URL needs no password. A stored password
 * is never paired with a DIFFERENT typed email.
 */
export function resolveConnectCredentials(input: { email?: string; password?: string }): {
  email: string | undefined;
  password: string | undefined;
} {
  const stored = loadHubCredentials();
  const email = input.email ?? stored?.email;
  const password =
    input.password ?? (stored && (!input.email || input.email === stored.email) ? stored.password : undefined);
  return { email, password };
}

/** Sign in to the hub again with the stored credentials (keeps pairing metadata). */
async function reloginWithStoredCredentials(): Promise<boolean> {
  const creds = loadHubCredentials();
  if (!creds) return false;
  try {
    const res = creds.deviceSecret
      ? await fetch(`${creds.url}/api/sync/device-token`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ tenantId: creds.tenantId, deviceId: creds.deviceId, secret: creds.deviceSecret }),
          signal: AbortSignal.timeout(20_000),
        })
      : await fetch(`${creds.url}/api/auth/login`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ email: creds.email, password: creds.password }),
          signal: AbortSignal.timeout(20_000),
        });
    const body = (await res.json().catch(() => ({}))) as { accessToken?: string; refreshToken?: string };
    if (!res.ok || !body.accessToken) {
      logger.warn({ status: res.status }, "hub re-login with stored credentials refused");
      return false;
    }
    const previous = loadSession();
    persistHubSession({
      ...(previous ?? {}),
      ...(creds.deviceId ? { hubDeviceId: creds.deviceId, hubTenantId: creds.tenantId } : {}),
      accessToken: body.accessToken,
      refreshToken: body.refreshToken,
    });
    if (!getCentralSyncUrl()) setRuntimeCentralSyncUrl(creds.url);
    hubReachable = true;
    lastProbeAt = Date.now();
    logger.info("hub session re-established from stored credentials");
    return true;
  } catch (err) {
    logger.warn({ err }, "hub re-login failed");
    return false;
  }
}

export async function refreshHubSession(): Promise<boolean> {
  if (await refreshWithToken()) return true;
  return reloginWithStoredCredentials();
}

async function refreshWithToken(): Promise<boolean> {
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

// ── Settings → «المزامنة السحابية» (admin-only pairing surface) ──────────────

export function getHubSessionInfo(): HubSessionInfo | null {
  const session = loadSession();
  if (!session?.accessToken) {
    // Still paired: the next sync re-establishes the session from the
    // stored credentials. Never show "not connected" for that.
    const creds = loadHubCredentials();
    return creds ? { hubUrl: creds.url, hubUserEmail: creds.email } : null;
  }
  const { accessToken: _a, refreshToken: _r, ...info } = session;
  void _a;
  void _r;
  return info;
}

/** Forget the URL, the session and the stored credentials (disk + memory). */
export function disconnectHub(): void {
  persistHubSession(null);
  saveHubCredentials(null);
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
  /** Local tenant/user the background sync acts as (saved with the session). */
  local?: { tenantId: string; userId: string };
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

type HubDeviceRegistration = NonNullable<ConnectHubInput["device"]>;

/** POST /api/auth/sync-device on the hub: registers (or touches) a sync device under its local id. */
async function postHubDeviceRegistration(
  url: string,
  auth: string,
  device: HubDeviceRegistration,
): Promise<{ ok: true; id: string } | { ok: false; status: number; code: string | null; error: string }> {
  try {
    const dr = await fetch(`${url}/api/auth/sync-device`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: auth },
      body: JSON.stringify({
        deviceId: device.id,
        deviceFingerprint: device.fingerprint,
        deviceFingerprintVersion: device.fingerprintVersion,
        platform: device.platform,
        hostname: device.hostname ?? undefined,
        label: device.label ?? device.hostname ?? undefined,
      }),
      signal: AbortSignal.timeout(15_000),
    });
    const body = (await dr.json().catch(() => ({}))) as { id?: string; code?: string; message?: string };
    if (dr.ok && body.id) return { ok: true, id: body.id };
    return { ok: false, status: dr.status, code: body.code ?? null, error: body.message || `تعذّر تسجيل الجهاز في المركز (${dr.status})` };
  } catch (err) {
    return { ok: false, status: 0, code: null, error: err instanceof Error ? err.message : "تعذّر تسجيل الجهاز في المركز" };
  }
}

/**
 * Register a sync device on the paired hub with the current hub session (restore on a synced
 * device, T109). On success the session records it as this device's hub identity.
 */
export async function registerDeviceOnHub(
  device: HubDeviceRegistration,
  localAuthHeader?: string,
): Promise<{ ok: true; id: string } | { ok: false; status: number; code: string | null; error: string }> {
  const url = getCentralSyncUrl();
  if (!url) return { ok: false, status: 0, code: null, error: "CENTRAL_SYNC_URL غير مضبوط" };
  let auth = await resolveHubAuthHeader(localAuthHeader);
  if (!auth) return { ok: false, status: 0, code: null, error: "لا توجد جلسة مصادقة للمركز" };
  let reg = await postHubDeviceRegistration(url, auth, device);
  if (!reg.ok && reg.status === 401 && (await refreshHubSession())) {
    auth = (await resolveHubAuthHeader(localAuthHeader)) ?? auth;
    reg = await postHubDeviceRegistration(url, auth, device);
  }
  if (reg.ok) {
    const session = loadSession();
    if (session?.accessToken) persistHubSession({ ...session, hubDeviceId: reg.id });
  }
  return reg;
}

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

  const { key: hubLicenseKey, status: hubLicenseStatus } = await fetchHubLicense(url, auth);

  let hubDeviceId: string | null = null;
  let deviceWarning: string | null = null;
  if (input.device) {
    const reg = await postHubDeviceRegistration(url, auth, input.device);
    if (reg.ok) {
      hubDeviceId = reg.id;
      // registerOrTouch falls back to an existing row with the same
      // fingerprint. Pushes carry the LOCAL id, so a different hub id means
      // the hub will still refuse them — say so instead of pretending.
      if (reg.id !== input.device.id) {
        deviceWarning =
          "المركز يعرف هذا الجهاز بمعرّف آخر — قد تُرفض المزامنة. ألغِ الجهاز القديم من المركز ثم أعد الربط";
      }
    } else {
      deviceWarning = reg.error;
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

  // Convert the account pairing into a device credential, so the hub password
  // is not kept on this device. Hubs without the endpoint keep the old way.
  const deviceSecret =
    hubDeviceId && hubDeviceId === input.device?.id && info.hubTenantId
      ? await mintHubDeviceCredential(url, auth, hubDeviceId)
      : null;

  // Clean slate: drop the old session before writing the new one.
  persistHubSession(null);
  setRuntimeCentralSyncUrl(url);
  persistHubSession({
    accessToken: login.accessToken,
    refreshToken: login.refreshToken,
    ...info,
    localTenantId: input.local?.tenantId,
    localUserId: input.local?.userId,
  });
  // Kept (encrypted) until «فصل»: expired tokens / a restarted hub re-login silently.
  saveHubCredentials(
    deviceSecret && hubDeviceId
      ? { url, tenantId: info.hubTenantId, deviceId: hubDeviceId, deviceSecret }
      : { url, email: input.email, password: input.password },
  );
  hubReachable = true;
  lastProbeAt = Date.now();
  localActivityCursor = null;

  const hubChanged =
    !previous ||
    (previous.hubUrl !== undefined && previous.hubUrl !== url) ||
    (previous.hubTenantId !== undefined && previous.hubTenantId !== info.hubTenantId);
  return { ok: true, info, hubChanged, deviceWarning };
}

async function fetchHubLicense(url: string, auth: string): Promise<{ key: string | null; status: string | null }> {
  try {
    const lr = await fetch(`${url}/api/license/status`, {
      headers: { Authorization: auth },
      signal: AbortSignal.timeout(10_000),
    });
    if (lr.ok) {
      const lb = (await lr.json()) as { license?: { key?: string; status?: string } };
      return { key: lb.license?.key ?? null, status: lb.license?.status ?? null };
    }
  } catch {
    /* license display is best-effort */
  }
  return { key: null, status: null };
}

/** Ask the hub for this (already bound) device's own credential. Null when the hub cannot. */
async function mintHubDeviceCredential(url: string, auth: string, deviceId: string): Promise<string | null> {
  try {
    const res = await fetch(`${url}/api/sync/devices/self/credential`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: auth, "X-Sync-Device-Id": deviceId },
      body: JSON.stringify({ deviceId }),
      signal: AbortSignal.timeout(15_000),
    });
    const body = (await res.json().catch(() => ({}))) as { deviceSecret?: string };
    return res.ok && body.deviceSecret ? body.deviceSecret : null;
  } catch {
    return null;
  }
}

export type EnrollHubInput = {
  url: string;
  code: string;
  device: NonNullable<ConnectHubInput["device"]>;
  local: { tenantId: string; userId: string };
};

/**
 * Enrollment with a company code (no hub account on this device): the hub
 * registers this device under its LOCAL id and returns its own credential,
 * which replaces any earlier pairing. Saved until «فصل».
 */
export async function enrollHub(input: EnrollHubInput): Promise<ConnectHubResult> {
  const url = trimUrl(input.url);
  if (!url) return { ok: false, stage: "url", error: "رابط الخادم المركزي غير صالح" };
  const previous = loadSession();
  const test = await testHubConnection(url);
  if (!test.reachable) return { ok: false, stage: "reach", error: test.error ?? "الخادم المركزي لا يستجيب" };

  let res: Response;
  try {
    res = await fetch(`${url}/api/sync/enroll`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        code: input.code,
        device: {
          id: input.device.id,
          fingerprint: input.device.fingerprint,
          fingerprintVersion: input.device.fingerprintVersion,
          platform: input.device.platform,
          hostname: input.device.hostname ?? undefined,
          label: input.device.label ?? input.device.hostname ?? undefined,
        },
      }),
      signal: AbortSignal.timeout(20_000),
    });
  } catch (err) {
    return { ok: false, stage: "reach", error: err instanceof Error ? err.message : "تعذّر الاتصال" };
  }
  const body = (await res.json().catch(() => ({}))) as {
    message?: string;
    tenantId?: string;
    deviceId?: string;
    deviceSecret?: string;
    accessToken?: string;
    refreshToken?: string;
    user?: { id?: string; name?: string; role?: string };
  };
  if (!res.ok || !body.accessToken || !body.deviceSecret || !body.deviceId || !body.tenantId) {
    return { ok: false, stage: "login", error: body.message || `رفض المركز التسجيل (${res.status})` };
  }

  const license = await fetchHubLicense(url, `Bearer ${body.accessToken}`);
  const info: HubSessionInfo = {
    hubUrl: url,
    hubTenantId: body.tenantId,
    hubUserId: body.user?.id,
    hubUserName: body.user?.name,
    hubUserRole: body.user?.role,
    hubLicenseKey: license.key,
    hubLicenseStatus: license.status,
    hubDeviceId: body.deviceId,
    pairedAt: new Date().toISOString(),
    localTenantId: input.local.tenantId,
    localUserId: input.local.userId,
  };
  persistHubSession(null);
  setRuntimeCentralSyncUrl(url);
  persistHubSession({ accessToken: body.accessToken, refreshToken: body.refreshToken, ...info });
  saveHubCredentials({ url, tenantId: body.tenantId, deviceId: body.deviceId, deviceSecret: body.deviceSecret });
  hubReachable = true;
  lastProbeAt = Date.now();
  localActivityCursor = null;

  const hubChanged =
    !previous ||
    (previous.hubUrl !== undefined && previous.hubUrl !== url) ||
    (previous.hubTenantId !== undefined && previous.hubTenantId !== info.hubTenantId);
  return { ok: true, info, hubChanged, deviceWarning: null };
}

/** Remember which local tenant/user to sync as (pairings made before this was saved). */
export function rememberLocalSyncIdentity(tenantId: string, userId: string): void {
  const session = loadSession();
  if (!session?.accessToken || (session.localTenantId === tenantId && session.localUserId)) return;
  persistHubSession({ ...session, localTenantId: tenantId, localUserId: userId });
}

/** Who the background sync runs as, or null when this device is not set up for it yet. */
export function backgroundSyncIdentity(): { tenantId: string; userId: string; deviceId: string } | null {
  if (!getCentralSyncUrl()) return null;
  const session = loadSession();
  const deviceId = session?.hubDeviceId ?? loadHubCredentials()?.deviceId;
  if (!session?.localTenantId || !session.localUserId || !deviceId) return null;
  return { tenantId: session.localTenantId, userId: session.localUserId, deviceId };
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

/** Device side: forward an admin action to the paired hub with this device's hub session. */
export async function hubProxy(
  method: "GET" | "POST" | "DELETE",
  pathname: string,
  body?: unknown,
): Promise<{ status: number; body: unknown }> {
  const res = await hubFetch(pathname, {
    method,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }).catch(() => undefined);
  if (res === undefined) return { status: 503, body: { code: "HUB_UNREACHABLE", message: "المركز لا يستجيب الآن — حاول لاحقاً" } };
  if (!res) return { status: 409, body: { code: "HUB_NOT_PAIRED", message: "هذا الجهاز غير مربوط بالمركز" } };
  return { status: res.status, body: await res.json().catch(() => ({})) };
}
