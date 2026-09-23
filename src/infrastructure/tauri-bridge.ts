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

type TauriGlobals = {
  __TAURI_INTERNALS__?: { invoke?: TauriInvoke };
  __TAURI__?: { core?: { invoke?: TauriInvoke } };
};

/**
 * The IPC function Tauri injects into every webview it controls.
 *
 * NEVER `import("@tauri-apps/api/core")` at runtime: the desktop window loads this app from the
 * embedded SSR server as a plain web page, so a bare package specifier has nothing to resolve it
 * (no bundler, no import map) and throws "Failed to resolve module specifier" — which silently
 * broke activation, hub linking, factory reset, archiving and updates in the shipped app.
 */
async function getInvoke(): Promise<TauriInvoke> {
  if (_invoke) return _invoke;
  if (!isTauri()) throw new Error("Not running in Tauri desktop");
  const w = window as unknown as TauriGlobals;
  const internals = w.__TAURI_INTERNALS__;
  const fn = internals?.invoke ?? w.__TAURI__?.core?.invoke;
  if (typeof fn !== "function") {
    throw new Error("قناة Tauri IPC غير متاحة في هذه النافذة");
  }
  _invoke = (cmd, args) => fn.call(internals ?? w.__TAURI__?.core, cmd, args);
  return _invoke;
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

/** Document types for the Desktop/<company> archive (Issue 12). */
export type ArchiveDocType = "sale" | "entry" | "print_send" | "print_receive" | "statement";

export interface ArchiveDocumentResult {
  path: string;
  format: string;
}

/**
 * Create Desktop archive folders (idempotent). No-op outside Tauri.
 * `companyName` names the root folder (`Desktop/<companyName>/...`); when
 * omitted/empty the Rust side falls back to a fixed brand name so this never
 * fails just because settings haven't loaded yet.
 */
export async function ensureDocumentFolders(companyName?: string): Promise<string | null> {
  if (!isTauri()) return null;
  const invoke = await getInvoke();
  return (await invoke("ensure_document_folders", { companyName })) as string;
}

export async function getHubUrl(): Promise<string> {
  if (!isTauri()) return "";
  const invoke = await getInvoke();
  return ((await invoke("get_hub_url")) as string) ?? "";
}

export async function setHubUrl(url: string): Promise<string> {
  if (!isTauri()) return url.trim().replace(/\/+$/, "");
  const invoke = await getInvoke();
  return ((await invoke("set_hub_url", { url })) as string) ?? "";
}

export async function requestFactoryReset(): Promise<void> {
  if (!isTauri()) {
    throw new Error("إعادة الضبط المصنعي متاحة في تطبيق سطح المكتب فقط");
  }
  const invoke = await getInvoke();
  await invoke("request_factory_reset");
}

/** Archive a printed/saved document into the Desktop folder tree. */
export async function archiveDocumentPdf(
  docType: ArchiveDocType,
  fileStem: string,
  html: string,
  companyName?: string,
): Promise<ArchiveDocumentResult | null> {
  if (!isTauri()) return null;
  const invoke = await getInvoke();
  return (await invoke("archive_document_pdf", {
    docType,
    fileStem,
    html,
    companyName,
  })) as ArchiveDocumentResult;
}

/** Desktop shell semver (`CARGO_PKG_VERSION`). Falls back for web builds. */
export async function getDesktopAppVersion(fallback = "1.0.0"): Promise<string> {
  if (!isTauri()) return fallback;
  const invoke = await getInvoke();
  const v = (await invoke("get_app_version")) as string;
  return (v && String(v).trim()) || fallback;
}

export type DesktopUpdateCheckResult = {
  available: boolean;
  version?: string | null;
  body?: string | null;
  date?: string | null;
};

/** CDN/latest.json probe — only after license update gate allows it. */
export async function checkDesktopUpdate(): Promise<DesktopUpdateCheckResult> {
  if (!isTauri()) {
    throw new Error("التحقق من التحديثات متاح في تطبيق سطح المكتب فقط");
  }
  const invoke = await getInvoke();
  return (await invoke("check_desktop_update")) as DesktopUpdateCheckResult;
}

/** Download + install from CDN endpoint configured in tauri.conf.json. */
export async function installDesktopUpdate(): Promise<void> {
  if (!isTauri()) {
    throw new Error("تثبيت التحديث متاح في تطبيق سطح المكتب فقط");
  }
  const invoke = await getInvoke();
  await invoke("install_desktop_update");
}
