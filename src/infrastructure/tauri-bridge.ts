/**
 * Tauri desktop integration — IPC bridge for license validation and fingerprinting.
 * Safe to import in web builds — all functions are guarded by `isTauri()` check.
 */

interface TauriInvoke {
  (cmd: string, args?: Record<string, unknown>): Promise<unknown>;
}

let _invoke: TauriInvoke | null = null;

/** True when the app is running inside the Tauri desktop shell. */
export function isTauri(): boolean {
  if (typeof window === "undefined") return false;
  return "__TAURI_INTERNALS__" in window || "__TAURI__" in window;
}

async function getInvoke(): Promise<TauriInvoke> {
  if (_invoke) return _invoke;
  if (isTauri()) {
    // Dynamic import — only in Tauri desktop context
    const mod = (await Function('return import("@tauri-apps/api/core")')()) as {
      invoke: TauriInvoke;
    };
    _invoke = mod.invoke;
    return _invoke;
  }
  throw new Error("Not running in Tauri desktop");
}

export interface DesktopFingerprint {
  hash: string;
  hostname: string;
  os: string;
}

/** Platform ids accepted by the backend `device_registrations.platform` column. */
export type DevicePlatform = "windows" | "macos" | "linux" | "android" | "ios" | "web";

/**
 * Best-effort platform id for the shell the app runs in.
 *
 * Inside Tauri the OS string reported by the Rust `get_fingerprint` command is
 * authoritative; on the web we fall back to the user agent. Returns `"web"`
 * when nothing more specific can be determined, which is what the backend
 * defaults to anyway.
 */
export function detectPlatform(osHint?: string): DevicePlatform {
  const hay = `${osHint ?? ""} ${
    typeof navigator === "undefined" ? "" : navigator.userAgent
  }`.toLowerCase();
  if (/android/.test(hay)) return "android";
  if (/iphone|ipad|ipod|\bios\b/.test(hay)) return "ios";
  if (/windows|win32|win64/.test(hay)) return "windows";
  if (/macos|mac os|darwin|macintosh/.test(hay)) return "macos";
  if (/linux/.test(hay)) return "linux";
  return isTauri() ? "windows" : "web";
}

export interface DesktopLicenseStatus {
  valid: boolean;
  status: string;
  message: string;
  graceRemainingDays: number | null;
}

/**
 * Collect machine fingerprint from the Tauri Rust backend.
 * Falls back to browser fingerprint on web.
 */
export async function getDesktopFingerprint(): Promise<DesktopFingerprint> {
  if (!isTauri()) {
    const ua = navigator.userAgent;
    const hash = await crypto.subtle
      .digest("SHA-256", new TextEncoder().encode(`${ua}-${screen.width}-${screen.height}`))
      .then((buf) =>
        Array.from(new Uint8Array(buf))
          .map((b) => b.toString(16).padStart(2, "0"))
          .join(""),
      );
    return { hash, hostname: "browser", os: navigator.platform };
  }
  const invoke = await getInvoke();
  return invoke("get_fingerprint") as Promise<DesktopFingerprint>;
}

/**
 * Validate license against the backend API via Tauri IPC.
 */
export async function validateDesktopLicense(
  apiUrl: string,
  licenseKey: string,
  fingerprint: string,
): Promise<DesktopLicenseStatus> {
  if (!isTauri()) {
    return { valid: true, status: "web", message: "وضع المتصفح", graceRemainingDays: null };
  }
  const invoke = await getInvoke();
  return invoke("validate_license", {
    apiUrl,
    licenseKey,
    fingerprint,
  }) as Promise<DesktopLicenseStatus>;
}
