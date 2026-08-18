import { ILicenseProvider } from "../../application/ports/ILicenseProvider.js";
import type {
  ActivationRequest,
  ActivationResult,
  DeviceInfo,
  HeartbeatResult,
} from "../../application/ports/ILicenseProvider.js";

/**
 * Phase 0 sub-batch 0E — vendor adapter stubs.
 *
 * Per the plan §5: vendor adapters are placeholders. The default
 * customer install uses `SelfHostedLicenseProvider`; vendor use is
 * opt-in but unimplemented at Phase 0. These classes throw a
 * clearly-tagged `NOT_IMPLEMENTED` error so the UI can surface a
 * "vendor integration coming soon" message instead of a 500.
 */
export class KeygenLicenseProvider implements ILicenseProvider {
  async activate(): Promise<ActivationResult> {
    throw new Error("NOT_IMPLEMENTED: Keygen.sh adapter is a Phase 5 deliverable");
  }
  async refresh(): Promise<HeartbeatResult> {
    throw new Error("NOT_IMPLEMENTED");
  }
  async deactivate(): Promise<void> {
    throw new Error("NOT_IMPLEMENTED");
  }
  async listDevices(): Promise<DeviceInfo[]> {
    throw new Error("NOT_IMPLEMENTED");
  }
  async revokeDevice(): Promise<void> {
    throw new Error("NOT_IMPLEMENTED");
  }
}

export class CryptlexLicenseProvider implements ILicenseProvider {
  async activate(): Promise<ActivationResult> {
    throw new Error("NOT_IMPLEMENTED: Cryptlex adapter is a Phase 5 deliverable");
  }
  async refresh(): Promise<HeartbeatResult> {
    throw new Error("NOT_IMPLEMENTED");
  }
  async deactivate(): Promise<void> {
    throw new Error("NOT_IMPLEMENTED");
  }
  async listDevices(): Promise<DeviceInfo[]> {
    throw new Error("NOT_IMPLEMENTED");
  }
  async revokeDevice(): Promise<void> {
    throw new Error("NOT_IMPLEMENTED");
  }
}
