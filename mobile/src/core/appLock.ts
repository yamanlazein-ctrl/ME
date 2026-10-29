// App lock (FR-04, FR-41): on a cold start, and after at least 60 s in the background, the app is covered until the owner
// proves presence with the fingerprint (expo-local-authentication) or, failing that, the PIN. The decision is pure so it can
// be tested with fixed clocks; the cover is also shown while the app is inactive/background so the recent-apps view is blank.
export const LOCK_AFTER_MS = 60_000;

export interface LockInput {
  enabled: boolean;
  /** ISO time of the last foreground moment (app-state.json), null on the first start. */
  lastForegroundAt: string | null;
  now: number;
  coldStart: boolean;
}

export function shouldLock({ enabled, lastForegroundAt, now, coldStart }: LockInput): boolean {
  if (!enabled) return false;
  if (coldStart) return true;
  if (!lastForegroundAt) return true;
  const last = Date.parse(lastForegroundAt);
  if (Number.isNaN(last)) return true;
  return now - last >= LOCK_AFTER_MS;
}

/** The cover hides content while the app is not active (FR-41), whether or not it will ask for authentication. */
export function coverVisible(appState: string, locked: boolean): boolean {
  return locked || appState === "inactive" || appState === "background";
}

export interface BiometricApi {
  hasHardwareAsync(): Promise<boolean>;
  isEnrolledAsync(): Promise<boolean>;
  authenticateAsync(options: {
    promptMessage: string;
    cancelLabel: string;
    disableDeviceFallback: boolean;
  }): Promise<{ success: boolean }>;
}

/** True when the fingerprint/face check passed; false means "ask for the PIN instead". */
export async function authenticateWithBiometrics(api: BiometricApi): Promise<boolean> {
  try {
    if (!(await api.hasHardwareAsync()) || !(await api.isEnrolledAsync())) return false;
    const result = await api.authenticateAsync({
      promptMessage: "افتح التطبيق",
      cancelLabel: "استخدم الرمز السري",
      disableDeviceFallback: true,
    });
    return result.success;
  } catch {
    return false;
  }
}
