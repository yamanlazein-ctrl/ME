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
};

let running = false;

export async function runSyncNow(): Promise<SyncRunResult | null> {
  const token = getAccessToken();
  if (!token) return null;
  // P7: an overlapping trigger used to return null — indistinguishable from
  // "no session" — so a dropped run looked like no run was needed. Report the
  // concurrency skip explicitly; the caller decides whether to retry.
  if (running) {
    return { pushed: 0, failed: 0, skipped: true, reason: "sync already running" };
  }
  running = true;
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
    return (await res.json()) as SyncRunResult;
  } finally {
    running = false;
  }
}
