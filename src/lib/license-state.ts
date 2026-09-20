import { getDesktopFingerprint, isTauri, detectPlatform } from "@/infrastructure/tauri-bridge";

export type { DevicePlatform } from "@/infrastructure/tauri-bridge";
export { detectPlatform, isTauri } from "@/infrastructure/tauri-bridge";

const KEY_STORAGE = "erp.license.key";
const ACTIVATION_ID_STORAGE = "erp.license.activationId";
const HOSTNAME_STORAGE = "erp.license.hostname";
const TENANT_ID_STORAGE = "erp.install.tenantId";
const FINGERPRINT_VERSION = 1;

// Encryption key derived from device fingerprint via PBKDF2
// This provides defense-in-depth (not strong security — proper Tauri secure store
// is the production solution per Phase 9 desktop transition plan).
async function deriveEncryptionKey(): Promise<CryptoKey> {
  const fingerprint = await getServerFingerprint();
  const enc = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    enc.encode(fingerprint),
    "PBKDF2",
    false,
    ["deriveKey"],
  );
  return crypto.subtle.deriveKey(
    {
      name: "PBKDF2",
      salt: enc.encode("motared-erp-license"),
      iterations: 100000,
      hash: "SHA-256",
    },
    keyMaterial,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

async function encryptValue(value: string): Promise<string> {
  try {
    const key = await deriveEncryptionKey();
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const enc = new TextEncoder();
    const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, enc.encode(value));
    const combined = new Uint8Array(iv.length + ciphertext.byteLength);
    combined.set(iv);
    combined.set(new Uint8Array(ciphertext), iv.length);
    return btoa(String.fromCharCode(...combined));
  } catch {
    // Fallback: store plaintext if crypto fails
    return value;
  }
}

async function decryptValue(encrypted: string): Promise<string> {
  try {
    const combined = Uint8Array.from(atob(encrypted), (c) => c.charCodeAt(0));
    const iv = combined.slice(0, 12);
    const ciphertext = combined.slice(12);
    const key = await deriveEncryptionKey();
    const decrypted = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ciphertext);
    return new TextDecoder().decode(decrypted);
  } catch {
    // Fallback: value might be plaintext (pre-encryption migration)
    return encrypted;
  }
}

function readString(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeString(key: string, value: string | null): void {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    /* ignore */
  }
}

export function getLicenseKey(): string | null {
  const raw = readString(KEY_STORAGE);
  return raw ?? null;
}

export async function setLicenseKey(key: string): Promise<void> {
  const encrypted = await encryptValue(key);
  writeString(KEY_STORAGE, encrypted);
}

export function getActivationId(): string | null {
  const raw = readString(ACTIVATION_ID_STORAGE);
  return raw ?? null;
}

/**
 * The activation id in the clear.
 *
 * `getActivationId()` returns the value as STORED, which is encrypted at rest
 * (AES-GCM keyed off the machine fingerprint). The device-roster endpoint needs
 * the plaintext id as its device-provisioning credential, so it must decrypt —
 * same fallback semantics as `decryptValue` (a pre-encryption plaintext value
 * passes through).
 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function getDecryptedActivationId(): Promise<string | null> {
  const raw = readString(ACTIVATION_ID_STORAGE);
  if (!raw) return null;
  // Current storage is plaintext UUID (roster needs a stable credential).
  if (UUID_RE.test(raw.trim())) return raw.trim();
  // Legacy: AES-GCM blob keyed off browser fingerprint (fragile — screen/UA).
  const value = await decryptValue(raw);
  return value && UUID_RE.test(value) ? value : null;
}

export async function setActivationId(id: string): Promise<void> {
  // Store plaintext — the roster header must survive fingerprint drift.
  // License key remains encrypted at rest below.
  writeString(ACTIVATION_ID_STORAGE, id.trim());
}

export function getStoredHostname(): string | null {
  return readString(HOSTNAME_STORAGE);
}

export function setStoredHostname(name: string): void {
  writeString(HOSTNAME_STORAGE, name);
}

/**
 * Tenant id of THIS install, as created by the Setup Wizard.
 *
 * Deployment model is one install = one customer = one tenant (the backend
 * assumes the same: `/api/setup/status` and the install gate resolve the
 * tenant via `BOOTSTRAP_TENANT_ID ?? findAnyCompleted()`). The login form
 * used to send `VITE_DEFAULT_TENANT_ID` from the build-time `.env`, so a
 * freshly provisioned install — whose wizard created a brand-new tenant —
 * could never log in: the backend requires an explicit tenantId and returned
 * 401 INVALID_CREDENTIALS for the stale one.
 *
 * Written once, right after the wizard's `complete` step succeeds (the only
 * moment the tenant is known to be fully provisioned), and read first by the
 * login form with the env value kept as a backwards-compatible fallback.
 *
 * Deliberately NOT encrypted, unlike the license key and activation id: a
 * tenant id is an identifier rather than a secret, and the login form needs
 * it synchronously (encryption here would force an async read for no gain).
 *
 * Known limitation (open item): this is per-browser/per-device local state,
 * so a SECOND device opening the same install has no value and falls back to
 * the env default. Employees are unaffected (invitation redemption returns
 * the tenant id from the server). A complete fix needs a server-side source
 * — e.g. `/api/setup/status` returning the tenant id, or the host-based
 * resolution left as a TODO in `auth.route.ts` — which is a wider
 * architectural decision.
 */
export function getInstallTenantId(): string | null {
  const raw = readString(TENANT_ID_STORAGE);
  return raw && raw.trim() !== "" ? raw : null;
}

export function setInstallTenantId(tenantId: string): void {
  const value = tenantId.trim();
  if (value === "") return;
  writeString(TENANT_ID_STORAGE, value);
}

const LAST_EMAIL_STORAGE = "erp.auth.lastEmail";

export function getRememberedEmail(): string | null {
  const raw = readString(LAST_EMAIL_STORAGE);
  return raw && raw.trim() !== "" ? raw : null;
}

export function setRememberedEmail(email: string): void {
  const value = email.trim();
  if (value === "") return;
  writeString(LAST_EMAIL_STORAGE, value);
}

export function clearRememberedEmail(): void {
  writeString(LAST_EMAIL_STORAGE, null);
}

export function isActivated(): boolean {
  return Boolean(getLicenseKey() && getActivationId());
}

export function clearLicense(): void {
  writeString(KEY_STORAGE, null);
  writeString(ACTIVATION_ID_STORAGE, null);
  writeString(HOSTNAME_STORAGE, null);
}

export function getFingerprintVersion(): number {
  return FINGERPRINT_VERSION;
}

/**
 * Device fingerprint used for license binding.
 *
 * Inside the Tauri desktop shell this delegates to the Rust `get_fingerprint`
 * command (real hardware signals: MAC + machine id + CPU), which is the
 * authoritative source. On the plain web build there is no hardware access, so
 * it falls back to the weak browser fingerprint below — good enough to key the
 * local at-rest encryption, but NOT a hardware lock.
 */
export async function getServerFingerprint(): Promise<string> {
  if (isTauri()) {
    try {
      const fp = await getDesktopFingerprint();
      if (fp?.hash) return fp.hash;
    } catch {
      // Tauri IPC unavailable — fall through to the browser fingerprint.
    }
  }
  return getBrowserFingerprint();
}

/**
 * Hardware-bound activation metadata for the backend.
 *
 * `platform` is reported so `device_registrations.platform` records the real
 * shell (windows / android / …) instead of a fixed value, and `hostname`
 * carries the machine name when Tauri can provide it.
 */
export async function getActivationDeviceInfo(): Promise<{
  fingerprint: string;
  platform: ReturnType<typeof detectPlatform>;
  hostname?: string;
}> {
  if (isTauri()) {
    // FIN-13: on desktop the OS fingerprint is the ONLY acceptable identity.
    // Falling back to the weak browser value here would let a seat be claimed
    // (and matched against other devices) on UA + language + timezone alone.
    // Fail closed instead.
    const fp = await getDesktopFingerprint();
    return {
      fingerprint: fp.hash,
      platform: detectPlatform(fp.os),
      hostname: fp.hostname,
    };
  }
  return { fingerprint: await getBrowserFingerprint(), platform: detectPlatform() };
}

/**
 * FIN-13: WEB-ONLY, NON-AUTHORITATIVE.
 *
 * This value keys local at-rest encryption in the browser build, where no OS
 * fingerprint is available. It is deliberately weak (UA + language + timezone
 * offset) and MUST NOT drive any licensing, seat-counting or authorization
 * decision — the desktop build always resolves the Rust `desktop_fingerprint`.
 */
async function getBrowserFingerprint(): Promise<string> {
  // Stable across window resize / monitor changes — screen size used to break
  // AES decrypt of the activation id and blocked the PIN roster.
  const parts = [
    navigator.userAgent || "",
    navigator.language || "",
    String(new Date().getTimezoneOffset()),
  ];
  const raw = parts.join("|");
  const data = new TextEncoder().encode(raw);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  const bytes = Array.from(new Uint8Array(hashBuffer));
  return bytes.map((b) => b.toString(16).padStart(2, "0")).join("");
}
