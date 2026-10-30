// Spike S2 on the device: runs the deterministic routine (src/core/spikeS2.ts) on a FRESH encrypted database and offers the
// decrypted copy for comparison with specs/002-mobile-app/evidence/s2-reference.db (scripts/compare-db.mjs).
import * as FileSystem from "expo-file-system/legacy";
import * as Sharing from "expo-sharing";
import { getApp, resetApp } from "../core/appRuntime";
import { buildPhoneRepositories } from "../core/container";
import { closeRuntime, openRuntime } from "../core/runtime";
import { runS2 } from "../core/spikeS2";
import { openShimDatabase } from "../platform/sqlite/BetterSqliteShim";
import { getOrCreateDbKey } from "../platform/secureStore";

export interface S2Outcome {
  lines: string[];
  exportUri: string | null;
}

/** The app's own database is closed for the run (the shared transaction layer holds one connection); restart the app afterwards. */
export async function runS2OnDevice(): Promise<S2Outcome> {
  const app = await getApp();
  closeRuntime(app.runtime);
  resetApp();
  const name = `spike-s2-${Date.now()}.db`;
  const conn = openShimDatabase({ name, encryptionKey: await getOrCreateDbKey() });
  const runtime = openRuntime(conn);
  const result = await runS2(conn, buildPhoneRepositories());
  const plain = `${FileSystem.cacheDirectory}s2-phone.db`;
  const plainPath = plain.replace(/^file:\/\//, "");
  await FileSystem.deleteAsync(plain, { idempotent: true });
  conn.exec(`ATTACH DATABASE '${plainPath}' AS plaintext KEY ''`);
  conn.exec("SELECT sqlcipher_export('plaintext')");
  conn.exec("DETACH DATABASE plaintext");
  closeRuntime(runtime);
  return {
    lines: [
      `S2: receipt ${result.receiptNumber}, sale ${result.invoiceNumber}, total ${result.invoiceTotal}`,
      "S2: أعد تشغيل التطبيق بعد هذا الاختبار (Restart the app after this test)",
    ],
    exportUri: plain,
  };
}

export async function shareS2Export(uri: string): Promise<void> {
  await Sharing.shareAsync(uri, {
    mimeType: "application/octet-stream",
    dialogTitle: "s2-phone.db",
  });
}
