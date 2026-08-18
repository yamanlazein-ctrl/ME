/**
 * Phase 0 sub-batch 0D — machine fingerprint provider port.
 *
 * Per AD-4: each platform (Node, Tauri desktop, Tauri mobile, Web PWA)
 * returns a deterministic SHA-256 of its most stable available signals.
 * The fingerprint includes a `confidence` field so callers can decide
 * whether to use it (e.g. license activation requires `>= medium`).
 *
 * `collect` returns the raw signals. `compute` derives a deterministic
 * hash. `getMetadata` returns a human-readable description and the
 * platform identifier. The default Node implementation lives in
 * `infrastructure/fingerprint/NodeFingerprintProvider.ts`.
 */
export interface FingerprintInput {
  signals: Record<string, string>;
  platform: "node" | "tauri-desktop" | "tauri-mobile" | "web";
  version: number; // algorithm version; bump when signals change
}

export interface FingerprintMetadata {
  hash: string; // hex SHA-256
  version: number;
  platform: FingerprintInput["platform"];
  signals: string[]; // the signal keys that contributed (for diagnostics)
  confidence: "low" | "medium" | "high";
}

export interface IMachineFingerprintProvider {
  collect(): Promise<FingerprintInput>;
  compute(input: FingerprintInput): Promise<string>; // hex SHA-256
  getMetadata(input: FingerprintInput): Promise<FingerprintMetadata>;
}
