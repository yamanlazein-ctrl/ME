import { getAccessToken } from "@/infrastructure/auth/TokenProvider";
import { getApiBaseUrl } from "@/lib/api-base-url";
import { getRegisteredSyncDeviceId } from "@/lib/sync-device";

export type SyncRunResult = {
  pushed: number;
  failed: number;
  rejected?: number;
  skipped: boolean;
  reason?: string;
  pull?: {
    pulled: number;
    applied: number;
    skipped: number;
    failed: number;
  };
};

let running = false;

export async function runSyncNow(): Promise<SyncRunResult | null> {
  const token = getAccessToken();
  if (!token) return null;
  if (running) return null;
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
