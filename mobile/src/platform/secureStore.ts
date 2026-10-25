// Android Keystore-backed secrets (FR-39, research R2). Keys are prefixed `motard.`; wipe.ts deletes by prefix
// through `listSecretKeys`. expo-secure-store has no listing API, so the key names live in an index entry.
import * as SecureStore from "expo-secure-store";
import { randomBytes } from "./nodeCrypto";

export const KEY_PREFIX = "motard.";
const INDEX_KEY = `${KEY_PREFIX}index`;
const OPTIONS = { requireAuthentication: false } as const;

// expo-secure-store accepts only [A-Za-z0-9._-] in keys.
const safe = (name: string): string => `${KEY_PREFIX}${name.replace(/[^A-Za-z0-9._-]/g, "_")}`;

async function readIndex(): Promise<string[]> {
  const raw = await SecureStore.getItemAsync(INDEX_KEY, OPTIONS);
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((k): k is string => typeof k === "string") : [];
  } catch {
    return [];
  }
}

async function writeIndex(keys: string[]): Promise<void> {
  await SecureStore.setItemAsync(INDEX_KEY, JSON.stringify(keys), OPTIONS);
}

export async function getSecret(name: string): Promise<string | null> {
  return SecureStore.getItemAsync(safe(name), OPTIONS);
}

export async function setSecret(name: string, value: string): Promise<void> {
  const key = safe(name);
  await SecureStore.setItemAsync(key, value, OPTIONS);
  const index = await readIndex();
  if (!index.includes(key)) await writeIndex([...index, key]);
}

export async function deleteSecret(name: string): Promise<void> {
  const key = safe(name);
  await SecureStore.deleteItemAsync(key, OPTIONS);
  const index = await readIndex();
  if (index.includes(key)) await writeIndex(index.filter((k) => k !== key));
}

/** Every secret name currently stored (without the prefix). */
export async function listSecretKeys(): Promise<string[]> {
  return (await readIndex()).map((k) => k.slice(KEY_PREFIX.length));
}

/** Deletes every `motard.` secret and the index (used by wipeDevice). */
export async function deleteAllSecrets(): Promise<void> {
  for (const key of await readIndex()) await SecureStore.deleteItemAsync(key, OPTIONS);
  await SecureStore.deleteItemAsync(INDEX_KEY, OPTIONS);
}

const DB_KEY = "dbKey";

/** The SQLCipher key: 32 random bytes (hex), created on first call and never leaves secure storage. */
export async function getOrCreateDbKey(): Promise<string> {
  const existing = await getSecret(DB_KEY);
  if (existing) return existing;
  const created = randomBytes(32).toString("hex");
  await setSecret(DB_KEY, created);
  return created;
}
