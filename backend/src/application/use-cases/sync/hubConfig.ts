import fs from "node:fs";
import path from "node:path";
import { config } from "../../../infrastructure/config/env.js";
import { logger } from "../../../infrastructure/config/logger.js";

type HubSession = {
  accessToken: string;
  refreshToken?: string;
};

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
