import type { LicenseInfo } from "@/contracts/licenses";

/**
 * Phase 0 — Platform Foundation: license repository port.
 *
 * The implementation choices (in-memory dev mode, real License Server
 * in api mode) are wired in `src/infrastructure/container.ts` via the
 * `selectRepo<T>()` helper. Both implementations MUST satisfy this
 * interface.
 *
 * The in-memory implementation (dev / `VITE_REPO_MODE=inmemory`) issues
 * a self-issued "trial" key on first call so the wizard can be exercised
 * without a running License Server. The API implementation proxies to
 * the License Server over HTTPS in `VITE_REPO_MODE=api` mode.
 */
export interface ILicenseRepository {
  /** Get the current license for this tenant. */
  getCurrent(): Promise<LicenseInfo>;

  /**
   * Activate a license key against the License Server (api mode) or
   * accept a self-issued trial key (inmemory mode).
   * @throws DomainError with code `INVALID_LICENSE` on invalid keys.
   */
  activate(input: { key: string; serverFingerprint: string }): Promise<LicenseInfo>;

  /** Regenerate the license key (admin only). The current key is invalidated. */
  regenerate(): Promise<{ key: string }>;
}
