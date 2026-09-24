import { useSyncExternalStore } from "react";
import { getAccessToken } from "@/infrastructure/auth/TokenProvider";
import { getApiBaseUrl } from "@/lib/api-base-url";
import { getRegisteredSyncDeviceId } from "@/lib/sync-device";

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
};

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
    // Push failures must be as visible as pull failures: the header's
    // «تعذّرت المزامنة السحابية» badge is driven by lastError. Units that do
    // not leave the device used to leave this null — a silent "متصل".
    const pushProblem =
      (result.failed ?? 0) > 0 ? `لم تُرسل ${result.failed} عملية إلى المركز — ستُعاد المحاولة` : null;
    setState({
      lastRunAt: new Date().toISOString(),
      lastResult: result,
      lastError: result.pullError ?? pushProblem,
    });
    return result;
  } catch (err) {
    setState({
      lastRunAt: new Date().toISOString(),
      lastError: err instanceof Error ? err.message : "فشل تشغيل المزامنة",
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

export const hubSync = {
  state: () => hubApi<HubState>("/sync/hub"),
  test: (url?: string) =>
    hubApi<HubTestResult>("/sync/hub/test", { method: "POST", body: JSON.stringify({ url }) }),
  connect: (input: { url: string; email?: string; password?: string }) =>
    hubApi<HubConnectResult>("/sync/hub/connect", {
      method: "POST",
      body: JSON.stringify(input),
    }),
  disconnect: () => hubApi<{ url: null }>("/sync/hub", { method: "DELETE" }),
};
