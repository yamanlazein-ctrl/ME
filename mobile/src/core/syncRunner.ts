// Runs the sync loop for the enrolled phone and keeps what the UI shows about it: status, rejected documents, notifications.
// App-lifecycle events feed the loop (foreground/background via AppState, network regain via NetInfo), hub answers arrive as
// signals from the fetch wrapper (hubHttp.ts), and a revoked device wipes itself (FR-40).
import { AppState } from "react-native";
import NetInfo from "@react-native-community/netinfo";
import { onHubSignal, type App } from "./appRuntime";
import { planNotifications, sendNotices } from "./notify";
import { createSyncLoop, type SyncLoop, type SyncLoopEvent } from "./syncLoop";
import { listLowStockFabrics, listRejectedDocuments, type RejectedDocument } from "./syncQueries";
import { deviceWipeDeps } from "./wipeDeps";
import { wipeDevice } from "./wipe";

export interface SyncStatus {
  running: boolean;
  lastRunAt: string | null;
  lastError: string | null;
  halted: SyncLoop["halted"];
  clockSkewMs: number | null;
  rejected: RejectedDocument[];
  /** Documents the hub parked as dead; they need the desktop (no requeue on the phone). */
  hubDeadOps: string[];
}

const initial: SyncStatus = {
  running: false,
  lastRunAt: null,
  lastError: null,
  halted: null,
  clockSkewMs: null,
  rejected: [],
  hubDeadOps: [],
};

let status: SyncStatus = initial;
const listeners = new Set<(s: SyncStatus) => void>();

export function getSyncStatus(): SyncStatus {
  return status;
}

export function subscribeSyncStatus(listener: (s: SyncStatus) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function patch(next: Partial<SyncStatus>) {
  status = { ...status, ...next };
  listeners.forEach((l) => l(status));
}

let current: { loop: SyncLoop; stop(): void } | null = null;

/** The loop of the running app, for the "write" hook (`notifyLocalWrite`). */
export function notifyLocalWrite(): void {
  current?.loop.notifyWrite();
}

export function startSyncRunner(app: App): { loop: SyncLoop; stop(): void } {
  if (current) return current;
  const phone = app.phone;
  if (!phone) throw new Error("startSyncRunner needs an enrolled phone");
  const announcedRejected = new Set<string>();
  const announcedLowStock = new Set<string>();

  const handle = async (event: SyncLoopEvent) => {
    if (event.type === "cycle") {
      const rejected = await listRejectedDocuments(phone);
      const fresh = rejected.filter((r) => !announcedRejected.has(r.opId));
      fresh.forEach((r) => announcedRejected.add(r.opId));
      const lowNow = await listLowStockFabrics(phone);
      await sendNotices(
        planNotifications({
          newRejected: fresh.map((r) => r.number ?? r.entityType),
          lowStockNow: lowNow,
          alreadyAnnouncedLowStock: announcedLowStock,
          pulledChanges: (event.result.pull.changed ?? event.result.pull.applied) > 0,
        }),
      );
      lowNow.forEach((n) => announcedLowStock.add(n));
      patch({
        running: false,
        lastRunAt: new Date().toISOString(),
        lastError: event.result.pullError,
        rejected,
        hubDeadOps: [...status.hubDeadOps, ...event.result.push.hubDeadOps],
      });
    } else if (event.type === "error") {
      patch({ running: false, lastError: event.message });
    } else if (event.type === "clockSkew") {
      patch({ clockSkewMs: event.skewMs });
    } else if (
      event.type === "versionMismatch" ||
      event.type === "revoked" ||
      event.type === "unknownDevice"
    ) {
      patch({ halted: event.type === "unknownDevice" ? status.halted : event.type });
      await sendNotices(
        planNotifications({
          newRejected: [],
          stopped: event.type,
          lowStockNow: [],
          alreadyAnnouncedLowStock: announcedLowStock,
          pulledChanges: false,
        }),
      );
      if (event.type === "revoked") await wipeDevice(deviceWipeDeps());
    }
  };

  const loop = createSyncLoop({
    run: async () => {
      patch({ running: true });
      return phone.syncOnce();
    },
    emit: (event) => void handle(event),
  });

  const unsubscribeSignal = onHubSignal((signal) => loop.signal(signal));
  const appStateSub = AppState.addEventListener("change", (state) => {
    if (state === "active") loop.onForeground();
    else loop.onBackground();
  });
  let wasOnline = true;
  const unsubscribeNet = NetInfo.addEventListener((s) => {
    const online = s.isConnected !== false;
    if (online && !wasOnline) loop.onNetworkRegain();
    wasOnline = online;
  });

  loop.start();
  current = {
    loop,
    stop() {
      loop.stop();
      unsubscribeSignal();
      appStateSub.remove();
      unsubscribeNet();
      current = null;
      status = initial;
    },
  };
  return current;
}
