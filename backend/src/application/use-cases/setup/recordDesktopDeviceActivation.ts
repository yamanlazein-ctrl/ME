import { isBindingFingerprint } from "../../../domain/licensing/installationIdentity.js";
import { getDesktopActivationStore } from "../../../infrastructure/repositories/engineStores.js";
import type { DesktopActivationInput } from "../../ports/IDesktopActivationStore.js";

/**
 * Desktop verify-only activation must still mint a real `license_activations`
 * row and a `device_registrations` row. Returning the license id as
 * `activationId` left roster proof path #2 permanently broken (findActivationById
 * never matched), and without a device row path #3 failed too — clients then
 * cleared local markers and bounced back to the activation screen.
 *
 * No re-signing: the baked offline token already lives in secrets.
 */
export async function recordDesktopDeviceActivation(input: DesktopActivationInput): Promise<{ activationId: string }> {
  // Phase 3: web / browser fingerprints cannot claim a device seat.
  if (!isBindingFingerprint(input.serverFingerprint)) {
    throw new Error("WEB_FINGERPRINT_NON_BINDING");
  }
  return (await getDesktopActivationStore()).record(input);
}