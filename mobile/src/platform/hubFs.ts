// `node:fs` for ONE importer: backend/src/application/use-cases/sync/hubConfig.ts, which keeps the hub session,
// hub URL and the (encrypted) device credential in small files. On the phone those "files" live in a map that is
// written through to Android Keystore-backed secure storage (key prefix `motard.fs.`); reads are synchronous
// because hubConfig reads synchronously, so `hydrateHubFs()` loads the map before the sync loop starts.
import { deleteSecret, getSecret, setSecret } from "./secureStore";

const files = new Map<string, string>();
const keyOf = (p: string) => `fs.${p.replace(/[^A-Za-z0-9._-]/g, "_")}`;

export async function hydrateHubFs(paths: string[]): Promise<void> {
  for (const p of paths) {
    const value = await getSecret(keyOf(p));
    if (value !== null) files.set(p, value);
  }
}

export function clearHubFsMemory(): void {
  files.clear();
}

function enoent(p: string): Error {
  return Object.assign(new Error(`ENOENT: no such file, open '${p}'`), { code: "ENOENT" });
}

export function readFileSync(p: string): string {
  const value = files.get(p);
  if (value === undefined) throw enoent(p);
  return value;
}

export function writeFileSync(p: string, data: string): void {
  files.set(p, data);
  void setSecret(keyOf(p), data);
}

export function existsSync(p: string): boolean {
  return files.has(p);
}

export function unlinkSync(p: string): void {
  if (!files.delete(p)) throw enoent(p);
  void deleteSecret(keyOf(p));
}

export function mkdirSync(): void {
  // Directories do not exist in the map.
}

export default { readFileSync, writeFileSync, existsSync, unlinkSync, mkdirSync };
