// The device wiring of wipe.ts.
import * as FileSystem from "expo-file-system/legacy";
import { router } from "expo-router";
import { getApp, resetApp } from "./appRuntime";
import { APP_STATE_FILE } from "./appState";
import { resetSqliteTransactionsForTests } from "@backend/infrastructure/orm/sqlite/transaction";
import { setActiveRuntime } from "./runtime";
import { clearHubFsMemory } from "../platform/hubFs";
import { deleteAllSecrets } from "../platform/secureStore";
import type { WipeDeps } from "./wipe";

export const PDF_CACHE_DIR = "pdf/";

export function deviceWipeDeps(): WipeDeps {
  return {
    async closeAndDeleteDatabase() {
      const app = await getApp();
      resetSqliteTransactionsForTests();
      setActiveRuntime(null);
      app.conn.destroy();
      resetApp();
    },
    async deleteSecrets() {
      clearHubFsMemory();
      await deleteAllSecrets();
    },
    async deleteAppState() {
      await FileSystem.deleteAsync(`${FileSystem.documentDirectory}${APP_STATE_FILE}`, {
        idempotent: true,
      });
    },
    async deleteCachedPdfs() {
      await FileSystem.deleteAsync(`${FileSystem.cacheDirectory}${PDF_CACHE_DIR}`, {
        idempotent: true,
      });
    },
    navigateToEnroll() {
      router.replace("/enroll");
    },
  };
}
