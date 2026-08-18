/**
 * Port: Installation ID persistent storage.
 * 
 * Stores a unique identifier for this server installation.
 * Used for machine fingerprinting and license transfer detection.
 * 
 * Production implementation: infrastructure/installation/InstallationIdStorage.ts
 */
export interface IInstallationIdStorage {
  /** Read the existing id, or generate + persist a new one. */
  readOrCreate(): Promise<string>;
  /** Overwrite (used by license transfer flow). */
  write(id: string): Promise<void>;
  /** Read only — returns null if not yet initialised. */
  read(): Promise<string | null>;
}