const KEY_STORAGE = "erp.license.key";
const ACTIVATION_ID_STORAGE = "erp.license.activationId";
const HOSTNAME_STORAGE = "erp.license.hostname";
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
    { name: "PBKDF2", salt: enc.encode("motared-erp-license"), iterations: 100000, hash: "SHA-256" },
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
    const ciphertext = await crypto.subtle.encrypt(
      { name: "AES-GCM", iv },
      key,
      enc.encode(value),
    );
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
    const decrypted = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv },
      key,
      ciphertext,
    );
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

export async function setActivationId(id: string): Promise<void> {
  const encrypted = await encryptValue(id);
  writeString(ACTIVATION_ID_STORAGE, encrypted);
}

export function getStoredHostname(): string | null {
  return readString(HOSTNAME_STORAGE);
}

export function setStoredHostname(name: string): void {
  writeString(HOSTNAME_STORAGE, name);
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

export async function getServerFingerprint(): Promise<string> {
  const parts = [
    navigator.userAgent || "",
    navigator.language || "",
    String(screen.width || 0),
    String(screen.height || 0),
    String(new Date().getTimezoneOffset()),
  ];
  const raw = parts.join("|");
  const data = new TextEncoder().encode(raw);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  const bytes = Array.from(new Uint8Array(hashBuffer));
  return bytes.map((b) => b.toString(16).padStart(2, "0")).join("");
}
