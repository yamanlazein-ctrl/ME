/**
 * Canonical Installation identity helpers.
 *
 * Sources that historically diverged:
 *   - on-disk UUID (`InstallationIdStorage` / ProgramData install-id)
 *   - desktop DPAPI `device-binding.dat` (Tauri boot gate — separate secret)
 *   - `server_installations.installation_id` (DB registry — was unused)
 *   - device fingerprint `${hostHash}::${installationId}` on activations
 *
 * Control Plane rule: the **Installation** id is the on-disk UUID. The
 * device fingerprint embeds it after `::` so seats and sync trust can
 * round-trip without inventing a second id. DPAPI binding remains a
 * local integrity gate and must not be rewritten here.
 */

export const INSTALLATION_FINGERPRINT_SEPARATOR = "::";

/** Build the stable device fingerprint used on activations / device seats. */
export function composeDeviceFingerprint(hostHash: string, installationId: string): string {
  const hash = hostHash.trim();
  const install = installationId.trim();
  if (!hash) throw new Error("HOST_HASH_REQUIRED");
  if (!install) throw new Error("INSTALLATION_ID_REQUIRED");
  // Avoid double-suffix if a caller already passed a composed value as hash.
  if (hash.includes(INSTALLATION_FINGERPRINT_SEPARATOR)) return hash;
  return `${hash}${INSTALLATION_FINGERPRINT_SEPARATOR}${install}`;
}

export function parseDeviceFingerprint(fingerprint: string): {
  hostHash: string;
  installationId: string | null;
} {
  const raw = fingerprint.trim();
  const idx = raw.indexOf(INSTALLATION_FINGERPRINT_SEPARATOR);
  if (idx <= 0) return { hostHash: raw, installationId: null };
  return {
    hostHash: raw.slice(0, idx),
    installationId: raw.slice(idx + INSTALLATION_FINGERPRINT_SEPARATOR.length) || null,
  };
}

/**
 * True when two fingerprints refer to the same install/device seat.
 * Accepts bare host hash, bare installation id suffix, or full composed form.
 */
export function fingerprintsMatch(a: string, b: string): boolean {
  if (a === b) return true;
  const pa = parseDeviceFingerprint(a);
  const pb = parseDeviceFingerprint(b);
  if (pa.hostHash && pa.hostHash === pb.hostHash) return true;
  if (
    pa.installationId &&
    pb.installationId &&
    pa.installationId === pb.installationId
  ) {
    return true;
  }
  // Legacy: one side bare hash, other composed.
  if (pa.hostHash === b || pb.hostHash === a) return true;
  return false;
}
