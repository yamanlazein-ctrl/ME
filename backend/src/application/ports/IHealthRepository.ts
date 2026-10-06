/** Deep health-check probes, per database engine (specs/001-desktop-sqlite-engine S1). */
export interface IHealthRepository {
  /** Round-trip a trivial query; throws when the database is unreachable. */
  ping(): Promise<void>;
  /** Human-readable database size (e.g. "12 MB"). */
  databaseSize(): Promise<string>;
}
