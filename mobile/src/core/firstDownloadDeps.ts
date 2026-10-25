// The device wiring of firstDownload.ts: shared pull, the persisted cursor and the hub's stream head.
import * as FileSystem from "expo-file-system/legacy";
import {
  getCentralSyncUrl,
  resolveHubAuthHeader,
} from "@backend/application/use-cases/sync/hubConfig";
import { getSyncStateStore } from "@backend/infrastructure/repositories/engineStores";
import type { Phone } from "./phone";
import { pullOnePage } from "./syncCycle";
import type { FirstDownloadDeps } from "./firstDownload";

export function deviceFirstDownloadDeps(phone: Phone): FirstDownloadDeps {
  const ctx = phone.context;
  const repos = phone.repos;
  return {
    async headSeq() {
      const hub = getCentralSyncUrl();
      const auth = await resolveHubAuthHeader();
      if (!hub || !auth) throw new Error("لا توجد جلسة مصادقة للمركز");
      const res = await fetch(`${hub}/api/sync/pull?afterSeq=0&limit=1`, {
        headers: { Authorization: auth, "X-Sync-Device-Id": ctx().syncDeviceId ?? "" },
      });
      if (!res.ok) throw new Error(`pull head failed: ${res.status}`);
      const body = (await res.json()) as { headSeq?: number | null };
      return Number(body.headSeq ?? 0);
    },
    async cursor() {
      const c = await (await getSyncStateStore()).getPullCursor(ctx().tenantId);
      return c.lastPullSeq ?? 0;
    },
    async pullPage() {
      const r = await pullOnePage(repos, ctx());
      return {
        pulled: r.pulled,
        applied: r.applied,
        failed: r.failed,
        deviceTrust: r.deviceTrust ?? null,
      };
    },
    freeDiskBytes: () => FileSystem.getFreeDiskStorageAsync(),
  };
}
