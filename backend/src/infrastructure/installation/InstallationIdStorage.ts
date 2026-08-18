import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";

/**
 * Phase 0 sub-batch 0D — installation-id persistent storage.
 *
 * Per PLATFORM_FOUNDATION_NOTES.md §4 in the validation report: MAC-only
 * fingerprinting is unstable across container restarts. The plan calls
 * for a per-install UUID stored on disk so the fingerprint stays
 * stable across container restarts, host reboots, and process
 * restarts.
 *
 * Conventions:
 *  - Linux:   `/var/lib/erp/install-id`
 *  - macOS:   `/Library/Application Support/ERP/install-id`
 *  - Windows: `%ProgramData%\ERP\install-id`
 *
 * For Phase 0 we resolve to an OS-appropriate default. Tests and
 * dev environments can override via `InstallationIdStorage(customDir)`.
 */
export interface IInstallationIdStorage {
  /** Read the existing id, or generate + persist a new one. */
  readOrCreate(): Promise<string>;
  /** Overwrite (used by license transfer flow). */
  write(id: string): Promise<void>;
  /** Read only — returns null if not yet initialised. */
  read(): Promise<string | null>;
}

const DEFAULT_PATHS: Partial<Record<NodeJS.Platform, string>> = {
  linux: "/var/lib/erp/install-id",
  darwin: "/Library/Application Support/ERP/install-id",
  win32: join(process.env.ProgramData ?? "C:\\ProgramData", "ERP", "install-id"),
};

export class InstallationIdStorage implements IInstallationIdStorage {
  private readonly filePath: string;

  constructor(filePath?: string) {
    this.filePath = filePath ?? DEFAULT_PATHS[process.platform] ?? "/var/lib/erp/install-id";
  }

  async read(): Promise<string | null> {
    try {
      const raw = await readFile(this.filePath, "utf8");
      const id = raw.trim();
      return id.length > 0 ? id : null;
    } catch (err: unknown) {
      if (isENOENT(err)) return null;
      throw err;
    }
  }

  async write(id: string): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    await writeFile(this.filePath, id, "utf8");
  }

  async readOrCreate(): Promise<string> {
    const existing = await this.read();
    if (existing) return existing;
    const id = randomUUID();
    await this.write(id);
    return id;
  }
}

function isENOENT(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code: unknown }).code === "ENOENT"
  );
}
