import { z } from "zod";
import { isWeakPin } from "../../domain/value-objects/pinStrength.js";

export const LoginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
  tenantId: z.string().uuid().optional(),
});

export const RefreshTokenSchema = z.object({
  refreshToken: z.string().min(1),
});

export const DeviceRosterSchema = z.object({
  tenantId: z.string().uuid(),
});

export const PinLoginSchema = z.object({
  userId: z.string().uuid(),
  pin: z.string().regex(/^\d{4}$/, "الرقم السري يجب أن يكون 4 أرقام"),
  tenantId: z.string().uuid().optional(),
});

export const SetPinSchema = z.object({
  userId: z.string().uuid(),
  // F08 (Phase 1 audit): reject the handful of PINs an attacker tries
  // first (0000, 1111, ..., 1234, 4321, ...) at the point a user CHOOSES a
  // PIN. Enforced server-side, not just in the UI, since the pin-login
  // endpoint has no other rate-limited weak-secret defense beyond this.
  pin: z
    .string()
    .regex(/^\d{4}$/, "الرقم السري يجب أن يكون 4 أرقام")
    .refine((pin) => !isWeakPin(pin), {
      message: "هذا الرقم السري ضعيف جداً (مثل 0000 أو 1234) — يرجى اختيار رقم أصعب تخمينه",
    }),
  /**
   * Legacy optional field. Lost-PIN recovery and first claim require device
   * provisioning proof instead — the lost secret must never be required.
   */
  currentSecret: z.string().min(1).optional(),
  tenantId: z.string().uuid().optional(),
});

export const SyncDeviceRegisterSchema = z.object({
  deviceFingerprint: z.string().min(16).max(128),
  deviceFingerprintVersion: z.number().int().min(1).max(10).optional(),
  platform: z.enum(["windows", "macos", "linux", "android", "ios", "web"]),
  hostname: z.string().trim().min(1).max(120).optional(),
  label: z.string().trim().min(1).max(120).optional(),
  /**
   * Device-gate binding: the UUID this device will assert as X-Sync-Device-Id
   * / syncDeviceId in pushes. When provided, the registry row uses it as its
   * id, so the hub's registered-device gate recognizes the device's pushes.
   * When omitted, the registry mints an id (legacy fingerprint-only flow).
   */
  deviceId: z.string().uuid().optional(),
});
