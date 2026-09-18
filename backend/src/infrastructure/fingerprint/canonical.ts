import { createHash } from "node:crypto";
import type { FingerprintInput } from "../../application/ports/IMachineFingerprintProvider.js";

/** DFP-039 canonical fingerprint envelope. Keep field names and ordering stable. */
export const FINGERPRINT_VERSION = 1;

export function canonicalFingerprintPayload(input: FingerprintInput): string {
  const signals: Record<string, string> = {};
  for (const key of Object.keys(input.signals).sort()) signals[key] = input.signals[key]!;
  return JSON.stringify({ platform: input.platform, version: input.version, signals });
}

export function canonicalFingerprintHash(input: FingerprintInput): string {
  return createHash("sha256").update(canonicalFingerprintPayload(input), "utf8").digest("hex");
}
