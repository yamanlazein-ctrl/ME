// Process-wide singleton of the phone application: opens the encrypted database, restores the enrolment and builds the
// `Phone` core. The UI and the background task both call `getApp()`; the first caller boots it.
import * as secureStoreModule from "../platform/secureStore";
import { openShimDatabase } from "../platform/sqlite/BetterSqliteShim";
import { installHubFetch } from "./hubHttp";
import {
  applyEnrollmentToHubConfig,
  loadEnrollment,
  toIdentity,
  type StoredEnrollment,
} from "./enrollment";
import { initHubStorage } from "./hubStorage";
import { createPhone, type Phone } from "./phone";
import { openRuntime, type PhoneRuntime } from "./runtime";
import type { ShimDatabase } from "../platform/sqlite/types";
import type { HubSignal } from "./hubHttp";

export interface App {
  conn: ShimDatabase;
  runtime: PhoneRuntime;
  /** Null until the phone is enrolled. */
  phone: Phone | null;
  enrollment: StoredEnrollment | null;
  /** Called after a successful enrolment to build `phone`. */
  attach(enrollment: StoredEnrollment): Phone;
}

const DB_NAME = "motard.db";
let booting: Promise<App> | null = null;
const signalListeners = new Set<(signal: HubSignal) => void>();

export function onHubSignal(listener: (signal: HubSignal) => void): () => void {
  signalListeners.add(listener);
  return () => signalListeners.delete(listener);
}

async function boot(): Promise<App> {
  await initHubStorage();
  const key = await secureStoreModule.getOrCreateDbKey();
  const conn = openShimDatabase({ name: DB_NAME, encryptionKey: key });
  const runtime = openRuntime(conn);
  installHubFetch((signal) => signalListeners.forEach((l) => l(signal)));
  const enrollment = await loadEnrollment();
  const app: App = {
    conn,
    runtime,
    phone: null,
    enrollment,
    attach(next) {
      app.enrollment = next;
      applyEnrollmentToHubConfig(next);
      app.phone = createPhone(runtime, toIdentity(next));
      return app.phone;
    },
  };
  if (enrollment) {
    applyEnrollmentToHubConfig(enrollment);
    app.phone = createPhone(runtime, toIdentity(enrollment));
  }
  return app;
}

export function getApp(): Promise<App> {
  booting ??= boot();
  return booting;
}

/** For wipe/tests: forget the booted instance. */
export function resetApp(): void {
  booting = null;
}
