import { useSyncExternalStore } from "react";
import { getAccessToken } from "@/infrastructure/auth/TokenProvider";
import { getApiBaseUrl } from "@/lib/api-base-url";
import { adoptSyncDeviceId, getRegisteredSyncDeviceId } from "@/lib/sync-device";

export type SyncRunResult = {
  pushed: number;
  failed: number;
  rejected?: number;
  /** P3a-completion: units the hub parked as dead (device marked synced —
   *  the hub owns them now — but they need operator triage on the hub). */
  hubDead?: number;
  hubDeadOps?: string[];
  skipped: boolean;
  reason?: string;
  pull?: {
    pulled: number;
    applied: number;
    skipped: number;
    failed: number;
  };
  /** P7: null when the pull phase succeeded. A failed pull used to vanish
   *  into zero counters, which reads exactly like "in sync". */
  pullError?: string | null;
  /** P7: null when the block refill succeeded or was skipped (no device). */
  blocksError?: string | null;
  /** Device gate: the hub 403d pushes with SYNC_UNKNOWN_DEVICE — the units
   *  stay pending and the device must register before retrying. */
  deviceGate?: boolean;
  /**
   * Batch 4 / 4B: WHY the hub refused the device (SYNC_UNKNOWN_DEVICE /
   * SYNC_DEVICE_REVOKED / SYNC_DEVICE_NOT_BOUND /
   * SYNC_DEVICE_FINGERPRINT_MISMATCH). Null when the gate did not refuse.
   * Nothing was lost locally: refused units stay pending in the outbox.
   */
  deviceTrust?: { code: string; message: string } | null;
  /** Presence events (another user logged in) turned into notifications. */
  activity?: number;
  /** Bumped by the backend whenever ANY sync cycle (this one or the background
   *  one) changed local data — the signal for every screen to re-read. */
  localDataVersion?: number;
  /**
   * T109 — restore on a synced device. While `paused`, nothing is pushed: the device is taking a new
   * sync identity and pulling the newer data the server holds. `deviceId` is that identity.
   */
  restore?: {
    paused: boolean;
    phase: "register" | "pull" | "done";
    deviceId: string | null;
    pulled: number;
    acknowledged: number;
    error: string | null;
  };
};

/**
 * Any raw sync failure text (outbox error detail, hub reply, network error) →
 * what the user needs to know, in plain Arabic. Internal states such as
 * "hub accepted but not yet applied — retrying" are normal transitions, not errors.
 */
export function describeSyncProblem(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const t = raw.toLowerCase();
  if (/not yet applied|retrying|deferred|waiting|بانتظار|already running|in progress/.test(t)) {
    return "عملية قيد المزامنة — ستُرسل تلقائياً.";
  }
  if (/fetch failed|econn|enotfound|eai_again|timeout|timed out|aborted|network|socket|\b50[234]\b|لا يستجيب|unreachable/.test(t)) {
    return "لا يوجد اتصال بالمركز الآن — العمليات محفوظة على هذا الجهاز وستُرسل تلقائياً عند عودة الاتصال.";
  }
  if (/sync_device_revoked|معطَّل|مُلغى/.test(t)) {
    return "هذا الجهاز معطَّل في المركز — المزامنة متوقفة حتى يعيد المسؤول تفعيله. بياناتك محفوظة على هذا الجهاز.";
  }
  if (/sync_unknown_device|sync_device|غير مسجّل/.test(t)) {
    return "هذا الجهاز غير مسجّل في المركز بعد — أدخل رمز تسجيل الجهاز من صفحة المزامنة السحابية.";
  }
  if (/\b401\b|unauthor|token|session|جلسة/.test(t)) {
    return "انتهت جلسة الاتصال بالمركز — تُجدَّد تلقائياً؛ إذا استمر الأمر أعد ربط الجهاز.";
  }
  if (/conflict|تعارض|\b409\b/.test(t)) {
    return "عملية تحتاج مراجعة: تعارضت مع تعديل من جهاز آخر — افتح «تعارضات المزامنة».";
  }
  // Already a plain Arabic sentence without technical tokens: keep it.
  if (/[\u0600-\u06FF]/.test(raw) && !/failed query|sql|select |insert |update |\bat \w+ \(|\{|\}|_[a-z]+_/i.test(raw)) {
    return raw;
  }
  return "تعذّرت مزامنة عملية — ستُعاد المحاولة تلقائياً.";
}

// ── Run state, shared by the header badge and Settings → المزامنة السحابية ──

export type SyncRunState = {
  running: boolean;
  lastRunAt: string | null;
  lastResult: SyncRunResult | null;
  lastError: string | null;
};

let state: SyncRunState = { running: false, lastRunAt: null, lastResult: null, lastError: null };
const listeners = new Set<() => void>();

function setState(patch: Partial<SyncRunState>) {
  state = { ...state, ...patch };
  listeners.forEach((l) => l());
}

export function useSyncRunState(): SyncRunState {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => state,
    () => state,
  );
}

/* ── One refresh path for every sync trigger ───────────────────────────── */

let refresher: (() => Promise<void>) | null = null;
let seenDataVersion: number | null = null;

/** Registered once by the app shell: re-reads every list, cache and store on screen. */
export function setDataRefresher(fn: () => Promise<void>): void {
  refresher = fn;
}

/** Re-read the screen without syncing (a caller that already ran the sync). */
export async function refreshScreens(): Promise<void> {
  await refresher?.();
}

/** The «تحديث» button and F5: sync when paired, then always re-read what is on screen. */
export async function refreshAllData(): Promise<SyncRunResult | null> {
  let result: SyncRunResult | null = null;
  let failure: unknown = null;
  try {
    result = await runSyncNow();
  } catch (err) {
    failure = err; // offline or unpaired: the local data is still worth re-reading
  }
  await refresher?.();
  if (failure) throw failure;
  return result;
}

let soonTimer: ReturnType<typeof setTimeout> | null = null;
/** A local write just happened: send it within ~2 s instead of waiting for the next tick. */
export function scheduleSyncSoon(delayMs = 2_000): void {
  if (soonTimer) clearTimeout(soonTimer);
  soonTimer = setTimeout(() => {
    soonTimer = null;
    if (state.running) return scheduleSyncSoon(delayMs);
    void runSyncNow().catch(() => undefined);
  }, delayMs);
}

export async function runSyncNow(): Promise<SyncRunResult | null> {
  const token = getAccessToken();
  if (!token) return null;
  // P7: an overlapping trigger used to return null — indistinguishable from
  // "no session" — so a dropped run looked like no run was needed. Report the
  // concurrency skip explicitly; the caller decides whether to retry.
  if (state.running) {
    return { pushed: 0, failed: 0, skipped: true, reason: "sync already running" };
  }
  setState({ running: true });
  try {
    const res = await fetch(`${getApiBaseUrl()}/api/sync/run`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        ...(getRegisteredSyncDeviceId()
          ? { "X-Sync-Device-Id": getRegisteredSyncDeviceId()! }
          : {}),
      },
    });
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { message?: string };
      throw new Error(body.message || `فشل تشغيل المزامنة (${res.status})`);
    }
    const result = (await res.json()) as SyncRunResult;
    if (result.restore?.deviceId && result.restore.deviceId !== getRegisteredSyncDeviceId()) {
      adoptSyncDeviceId(result.restore.deviceId);
    }
    // Push failures must be as visible as pull failures: the header's
    // «تعذّرت المزامنة السحابية» badge is driven by lastError. Units that do
    // not leave the device used to leave this null — a silent "متصل".
    const pushProblem =
      (result.failed ?? 0) > 0
        ? `${result.failed === 1 ? "عملية واحدة لم تُرسل بعد" : `${result.failed} عمليات لم تُرسل بعد`} — ستُعاد المحاولة تلقائياً.`
        : null;
    setState({
      lastRunAt: new Date().toISOString(),
      lastResult: result,
      lastError: describeSyncProblem(result.pullError) ?? pushProblem,
    });
    // The backend bumps localDataVersion only when a cycle (this one or the background
    // one) really changed local data — whichever trigger ran, the screen re-reads.
    const version = result.localDataVersion;
    if (typeof version === "number") {
      if (seenDataVersion !== null && version !== seenDataVersion) void refresher?.();
      seenDataVersion = version;
    }
    return result;
  } catch (err) {
    setState({
      lastRunAt: new Date().toISOString(),
      lastError: describeSyncProblem(err instanceof Error ? err.message : null) ?? "تعذّرت المزامنة — ستُعاد المحاولة تلقائياً.",
    });
    throw err;
  } finally {
    setState({ running: false });
  }
}

// ── Hub pairing API (admin only — Settings → المزامنة السحابية) ────────────

export type HubSessionInfo = {
  hubUrl?: string;
  hubTenantId?: string;
  hubUserId?: string;
  hubUserEmail?: string;
  hubUserName?: string;
  hubUserRole?: string;
  hubLicenseKey?: string | null;
  hubLicenseStatus?: string | null;
  hubDeviceId?: string | null;
  pairedAt?: string;
};

export type HubState = {
  url: string | null;
  reachable: boolean | null;
  session: HubSessionInfo | null;
  pendingCount: number;
  statusCounts: Record<string, number>;
  lastPullAt: string | null;
  localDeviceId: string | null;
  /** Oldest unit still waiting to leave this device (pending/pushing). */
  oldestPendingAt?: string | null;
  /** Why the last push attempt of a waiting unit failed. */
  lastPushError?: string | null;
  /** The hub account is stored (encrypted) — a URL change needs no password. */
  hasStoredCredentials?: boolean;
};

export type HubTestResult = {
  url: string;
  reachable: boolean;
  latencyMs: number | null;
  setupCompleted: boolean | null;
  error: string | null;
};

export type HubConnectResult = {
  url: string;
  session: HubSessionInfo;
  cursorReset: boolean;
  /** Units already delivered to the previous hub, queued again for this one. */
  requeued?: number;
  deviceWarning: string | null;
};

async function hubApi<T>(path: string, init: RequestInit = {}): Promise<T> {
  const token = getAccessToken();
  const deviceId = getRegisteredSyncDeviceId();
  const res = await fetch(`${getApiBaseUrl()}/api${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(deviceId ? { "X-Sync-Device-Id": deviceId } : {}),
    },
  });
  const body = (await res.json().catch(() => ({}))) as T & { message?: string };
  if (!res.ok) throw new Error(body.message || `فشل الطلب (${res.status})`);
  return body;
}

/** Backend marker for units held behind an earlier one (syncUseCases ORDERED_LANE_WAITING). */
export const ORDERED_WAITING = "بانتظار إرسال عملية سابقة لها";

export type PendingUnit = {
  id: string;
  entityType: string;
  operation: string;
  status: string;
  createdAt: string;
  ref: string | null;
  errorDetail: string | null;
  beforePairing: boolean;
};

export const hubSync = {
  state: () => hubApi<HubState>("/sync/hub"),
  pending: () => hubApi<{ items: PendingUnit[] }>("/sync/pending"),
  test: (url?: string) =>
    hubApi<HubTestResult>("/sync/hub/test", { method: "POST", body: JSON.stringify({ url }) }),
  connect: (input: { url: string; email?: string; password?: string }) =>
    hubApi<HubConnectResult>("/sync/hub/connect", {
      method: "POST",
      body: JSON.stringify(input),
    }),
  disconnect: () => hubApi<{ url: null }>("/sync/hub", { method: "DELETE" }),
  /** Link with the company enrollment code — no hub account on this device. */
  enroll: (input: { url: string; code: string }) =>
    hubApi<HubConnectResult>("/sync/hub/enroll", { method: "POST", body: JSON.stringify(input) }),
  devices: () => hubApi<{ items: HubDevice[] }>("/sync/hub/devices"),
  revokeDevice: (id: string, reason?: string) =>
    hubApi<{ ok: true }>(`/sync/hub/devices/${id}/revoke`, {
      method: "POST",
      body: JSON.stringify(reason ? { reason } : {}),
    }),
  reinstateDevice: (id: string) =>
    hubApi<{ ok: true }>(`/sync/hub/devices/${id}/reinstate`, { method: "POST", body: "{}" }),
  enrollmentCode: () => hubApi<{ current: EnrollmentCode | null }>("/sync/hub/enrollment-code"),
  createEnrollmentCode: (input: { ttlHours?: number; maxUses?: number } = {}) =>
    hubApi<{ current: EnrollmentCode }>("/sync/hub/enrollment-code", {
      method: "POST",
      body: JSON.stringify(input),
    }),
  revokeEnrollmentCode: () =>
    hubApi<{ current: null }>("/sync/hub/enrollment-code", { method: "DELETE" }),
};

export type HubDevice = {
  id: string;
  platform: string;
  hostname: string | null;
  label: string | null;
  lastSeenAt: string;
  createdAt: string;
  revokedAt: string | null;
  revokeReason: string | null;
};

export type EnrollmentCode = { code: string; expiresAt: string; maxUses: number; uses: number };
