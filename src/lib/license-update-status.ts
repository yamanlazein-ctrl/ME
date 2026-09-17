/**
 * Desktop / web helper: ask the local ERP whether Tauri updater may run.
 * Vendor owns updatePolicy; publishing latest.json stays on the CDN.
 */
import { getApiBaseUrl } from "@/lib/api-base-url";

export type UpdateGateResponse = {
  currentVersion: string;
  updatesAllowed: boolean;
  belowMinimum: boolean;
  mayCheckForUpdates: boolean;
  forceUpgrade: boolean;
  reason: string;
  policy: {
    channel: string;
    allow_updates: boolean;
    minimum_version: string;
  };
  updaterEndpointHint?: string;
};

export async function fetchUpdateStatus(
  accessToken: string,
  currentVersion: string,
  channel?: "stable" | "beta" | "none",
): Promise<UpdateGateResponse> {
  // Same pattern as Api* services: base is origin (or "") and path includes /api.
  const base = getApiBaseUrl().replace(/\/+$/, "");
  const q = new URLSearchParams({ currentVersion });
  if (channel) q.set("channel", channel);
  const res = await fetch(`${base}/api/license/updates/status?${q}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { message?: string };
    throw new Error(body.message || `update-status ${res.status}`);
  }
  return res.json() as Promise<UpdateGateResponse>;
}
