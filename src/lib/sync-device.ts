import { detectPlatform, getDesktopFingerprint } from "@/infrastructure/tauri-bridge";
import { getAccessToken } from "@/infrastructure/auth/TokenProvider";
import { getApiBaseUrl } from "@/lib/api-base-url";

const SYNC_DEVICE_ID_KEY = "erp.sync.deviceId";

export function getRegisteredSyncDeviceId(): string | null {
  try {
    return localStorage.getItem(SYNC_DEVICE_ID_KEY);
  } catch {
    return null;
  }
}

export async function registerCurrentSyncDevice(label?: string): Promise<string | null> {
  const token = getAccessToken();
  if (!token) return null;

  const fp = await getDesktopFingerprint();
  const res = await fetch(`${getApiBaseUrl()}/api/auth/sync-device`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      deviceFingerprint: fp.hash,
      deviceFingerprintVersion: 1,
      platform: detectPlatform(fp.os),
      hostname: fp.hostname || undefined,
      label: label?.trim() || fp.hostname || undefined,
    }),
  });

  if (!res.ok) {
    const data = (await res.json().catch(() => ({}))) as { message?: string };
    throw new Error(data.message || `فشل تسجيل جهاز المزامنة (${res.status})`);
  }

  const data = (await res.json()) as { id: string };
  try {
    localStorage.setItem(SYNC_DEVICE_ID_KEY, data.id);
  } catch {
    // ignore storage failure
  }

  // Best-effort: reserve invoice number blocks for offline final numbering.
  try {
    await fetch(`${getApiBaseUrl()}/api/sync/number-blocks/ensure`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
        "X-Sync-Device-Id": data.id,
      },
      body: JSON.stringify({ syncDeviceId: data.id }),
    });
  } catch {
    // Blocks can be ensured later on sync/run.
  }

  return data.id;
}
