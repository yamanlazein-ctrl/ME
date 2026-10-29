// One sync run on the phone: the same push/pull/number-block steps `runSyncCycle` performs in
// backend/src/presentation/routes/sync.route.ts, calling the same shared sync client functions
// (syncUseCases.ts runLocalSyncPush / runLocalSyncPull, numberBlockUseCases.ts). It never writes outbox rows itself
// (FR-31, FR-33). Each page is its own serial job (research R3), so a user's write can slot in between pages.
import * as syncUc from "@backend/application/use-cases/sync/syncUseCases";
import * as numberBlocksUc from "@backend/application/use-cases/sync/numberBlockUseCases";
import { describePulledUnit } from "@backend/application/use-cases/sync/syncActivity";
import { markHubReachable } from "@backend/application/use-cases/sync/hubConfig";
import { adoptYearStatus } from "@backend/infrastructure/repositories/yearStatusSync";
import { hubProxy } from "@backend/application/use-cases/sync/hubConfig";
import { withTenantTx } from "@backend/infrastructure/orm/engine";
import type { IMachineFingerprintProvider } from "@backend/application/ports/IMachineFingerprintProvider";
import type { TenantContext } from "@backend/domain/types/index";
import type { PhoneRepositories } from "./container";
import { runSerial } from "./serialExecutor";

export type PushResult = Awaited<ReturnType<typeof syncUc.runLocalSyncPush>>;
export type PullResult = Awaited<ReturnType<typeof syncUc.runLocalSyncPull>>;

export interface SyncCycleResult {
  push: PushResult;
  pull: PullResult;
  pullError: string | null;
  blocksError: string | null;
  skipped: boolean;
}

const PUSH_BATCH = 50; // claimBatch size inside runLocalSyncPush (FR-32: batches of 50)
const PAGE = 50; // pull page size inside runLocalSyncPull

/** The phone has no machine fingerprint; the device id is its identity (only legacy hub registration reads this). */
export const phoneFingerprintProvider: IMachineFingerprintProvider = {
  async collect() {
    return { signals: { platform: "android" }, platform: "tauri-mobile", version: 1 };
  },
  async compute() {
    return "phone";
  },
  async getMetadata() {
    return {
      hash: "phone",
      version: 1,
      platform: "tauri-mobile",
      signals: ["platform"],
      confidence: "low",
    };
  },
};

export interface SyncCycleDeps {
  repos: PhoneRepositories;
  context(): TenantContext;
  /** Absolute time budget of one drain, in ms (default 30 s, like the desktop route). */
  budgetMs?: number;
  onProgress?: (progress: { pushed: number; pulled: number }) => void;
}

/** One pull page, as its own serial job; the first download (firstDownloadDeps.ts) runs exactly this. */
export function pullOnePage(repos: PhoneRepositories, ctx: TenantContext): Promise<PullResult> {
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
  const deviceId = ctx.syncDeviceId ?? null;
  return runSerial(() =>
    syncUc.runLocalSyncPull(
      repos.db as never,
      materializeRepos,
      ctx,
      undefined,
      deviceId,
      repos.syncInboxRepo,
      async (unit) => {
        const n = describePulledUnit(unit);
        if (n) await repos.notificationRepo.create(n, ctx);
      },
      undefined,
      {
        requeueSynced: (tenantId) => repos.syncOutboxRepo.requeueSyncedForNewHub(tenantId),
        reassertNumberTips: async () => {
          if (!deviceId) return;
          await numberBlocksUc.reassertNumberTipsOnHub({
            tenantId: ctx.tenantId,
            syncDeviceId: deviceId,
            authHeader: undefined,
          });
        },
      },
    ),
  );
}

export async function runPhoneSyncCycle(deps: SyncCycleDeps): Promise<SyncCycleResult> {
  const { repos } = deps;
  const ctx = deps.context();
  const budget = deps.budgetMs ?? 30_000;

  const pushOnce = () =>
    runSerial(() =>
      syncUc.runLocalSyncPush(
        repos.syncOutboxRepo,
        repos.invoiceRepo,
        repos.auditRepo,
        repos.notificationRepo,
        ctx,
        undefined,
        {
          voucherRepo: repos.voucherRepo,
          returnRepo: repos.returnRepo,
          orderRepo: repos.orderRepo,
          expenseRepo: repos.expenseRepo,
          ledgerRepo: repos.ledgerRepo,
          cashboxRepo: repos.cashboxRepo,
        },
      ),
    );

  const handledOf = (r: PushResult) => r.pushed + r.failed + r.rejected + r.hubDead;
  const push = await pushOnce();
  const deadline = Date.now() + budget;
  let last = handledOf(push) >= PUSH_BATCH;
  while (last && !push.deviceGate && push.failed === 0 && Date.now() < deadline) {
    const more = await pushOnce();
    push.pushed += more.pushed;
    push.failed += more.failed;
    push.rejected += more.rejected;
    push.hubDead += more.hubDead;
    push.hubDeadOps.push(...more.hubDeadOps);
    push.deviceGate ||= more.deviceGate;
    push.deviceTrust ??= more.deviceTrust;
    last = handledOf(more) >= PUSH_BATCH;
    deps.onProgress?.({ pushed: push.pushed, pulled: 0 });
  }

  const pullOnce = () => pullOnePage(repos, ctx);

  let pull: PullResult = { pulled: 0, applied: 0, skipped: 0, failed: 0, deviceTrust: null };
  let pullError: string | null = null;
  try {
    pull = await pullOnce();
    const pullDeadline = Date.now() + budget;
    let page = pull;
    while (
      page.pulled >= PAGE &&
      page.applied + page.skipped > 0 &&
      page.failed === 0 &&
      !page.deviceTrust &&
      Date.now() < pullDeadline
    ) {
      page = await pullOnce();
      pull = {
        pulled: pull.pulled + page.pulled,
        applied: pull.applied + page.applied,
        changed: (pull.changed ?? 0) + (page.changed ?? 0),
        skipped: pull.skipped + page.skipped,
        failed: pull.failed + page.failed,
        deviceTrust: pull.deviceTrust ?? page.deviceTrust,
        ...(page.rebased
          ? { rebased: page.rebased }
          : pull.rebased
            ? { rebased: pull.rebased }
            : {}),
      };
      deps.onProgress?.({ pushed: push.pushed, pulled: pull.pulled });
    }
    markHubReachable();
  } catch (err) {
    pullError = err instanceof Error ? err.message : "pull failed";
  }

  const deviceId = ctx.syncDeviceId ?? null;
  let blocksError: string | null = null;
  if (deviceId) {
    try {
      await runSerial(() =>
        numberBlocksUc.ensureDeviceNumberBlocks(
          repos.documentNumberBlockRepo,
          phoneFingerprintProvider,
          {
            tenantId: ctx.tenantId,
            syncDeviceId: deviceId,
            userId: ctx.userId,
            deviceKind: "phone",
          },
        ),
      );
    } catch (err) {
      blocksError = err instanceof Error ? err.message : "number-block ensure failed";
    }
  }

  // A financial year closed on the hub freezes it here too (best effort, every cycle).
  try {
    const years = await hubProxy("GET", "/api/financial-years");
    if (years.status === 200 && Array.isArray(years.body)) {
      for (const y of years.body as Array<{
        year: number;
        status: string;
        closedAt: string | null;
      }>) {
        await runSerial(() =>
          withTenantTx(ctx.tenantId, (tx) =>
            adoptYearStatus(
              tx,
              ctx.tenantId,
              y.year,
              y.status,
              y.closedAt ? new Date(y.closedAt) : null,
            ),
          ),
        );
      }
    }
  } catch {
    // best effort, like the desktop
  }

  const skipped = push.skipped && pull.pulled === 0 && !pullError;
  return { push, pull, pullError, blocksError, skipped };
}
