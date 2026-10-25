// The device wiring of firstDownload.ts: shared pull, the persisted cursor and the hub's stream head.
import * as FileSystem from "expo-file-system/legacy";
import * as syncUc from "@backend/application/use-cases/sync/syncUseCases";
import {
  getCentralSyncUrl,
  resolveHubAuthHeader,
} from "@backend/application/use-cases/sync/hubConfig";
import { getSyncStateStore } from "@backend/infrastructure/repositories/engineStores";
import type { Phone } from "./phone";
import { runSerial } from "./serialExecutor";
import type { FirstDownloadDeps } from "./firstDownload";

export function deviceFirstDownloadDeps(phone: Phone): FirstDownloadDeps {
  const ctx = phone.context;
  const repos = phone.repos;
  const materializeRepos = {
    invoiceRepo: repos.invoiceRepo,
    voucherRepo: repos.voucherRepo,
    returnRepo: repos.returnRepo,
    orderRepo: repos.orderRepo,
    expenseRepo: repos.expenseRepo,
    auditRepo: repos.auditRepo,
    partyRepo: repos.partyRepo,
    fabricRepo: repos.fabricRepo,
    colorRepo: repos.colorRepo,
    rollRepo: repos.rollRepo,
    ledgerRepo: repos.ledgerRepo,
    statementRepo: repos.statementRepo,
    printJobRepo: repos.printJobRepo,
    cashboxRepo: repos.cashboxRepo,
    settingsRepo: repos.settingsRepo,
    companyRepo: repos.companyRepo,
  };
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
    pullPage() {
      return runSerial(async () => {
        const r = await syncUc.runLocalSyncPull(
          repos.db as never,
          materializeRepos,
          ctx(),
          undefined,
          ctx().syncDeviceId ?? null,
          repos.syncInboxRepo,
        );
        return {
          pulled: r.pulled,
          applied: r.applied,
          failed: r.failed,
          deviceTrust: r.deviceTrust ?? null,
        };
      });
    },
    freeDiskBytes: () => FileSystem.getFreeDiskStorageAsync(),
  };
}
