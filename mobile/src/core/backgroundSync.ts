// Background sync (NFR-13): one sync run at most every 15 minutes while the app is closed, through expo-background-task.
// Each page of the run goes through the shared serial executor (research R3).
import * as BackgroundTask from "expo-background-task";
import * as TaskManager from "expo-task-manager";
import { getApp } from "./appRuntime";

export const BACKGROUND_SYNC_TASK = "motard-background-sync";
export const BACKGROUND_SYNC_MINUTES = 15;

// Must be defined at module scope so the OS can start the task in a headless JavaScript context.
TaskManager.defineTask(BACKGROUND_SYNC_TASK, async () => {
  try {
    const app = await getApp();
    if (!app.phone) return BackgroundTask.BackgroundTaskResult.Success; // not enrolled yet: nothing to do
    // syncOnce serialises each push/pull page itself (syncCycle.ts); wrapping the whole run in runSerial would
    // queue its own pages behind it and never finish.
    await app.phone.syncOnce({ budgetMs: 20_000 });
    return BackgroundTask.BackgroundTaskResult.Success;
  } catch {
    return BackgroundTask.BackgroundTaskResult.Failed;
  }
});

export async function registerBackgroundSync(): Promise<void> {
  if (await TaskManager.isTaskRegisteredAsync(BACKGROUND_SYNC_TASK)) return;
  await BackgroundTask.registerTaskAsync(BACKGROUND_SYNC_TASK, {
    minimumInterval: BACKGROUND_SYNC_MINUTES,
  });
}

export async function unregisterBackgroundSync(): Promise<void> {
  if (await TaskManager.isTaskRegisteredAsync(BACKGROUND_SYNC_TASK)) {
    await BackgroundTask.unregisterTaskAsync(BACKGROUND_SYNC_TASK);
  }
}
