/** Desktop verify-only activation persistence (license_activations + device_registrations), per engine (S1). */
export interface DesktopActivationInput {
  licenseId: string;
  tenantId: string;
  serverFingerprint: string;
  serverFingerprintVersion: number;
  hostname?: string | null;
  platform?: string | null;
  appVersion?: string | null;
  maxDevices: number;
}

export interface IDesktopActivationStore {
  /** One transaction: activation row, tenant stamp, device seat (bounded by maxDevices), audit event. */
  record(input: DesktopActivationInput): Promise<{ activationId: string }>;
}
