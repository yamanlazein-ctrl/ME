import { z } from "zod";

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
  pin: z.string().regex(/^\d{4}$/, "الرقم السري يجب أن يكون 4 أرقام"),
  /** Current account password (or existing PIN) required to set/change PIN. */
  currentSecret: z.string().min(1),
  tenantId: z.string().uuid().optional(),
});

export const SyncDeviceRegisterSchema = z.object({
  deviceFingerprint: z.string().min(16).max(128),
  deviceFingerprintVersion: z.number().int().min(1).max(10).optional(),
  platform: z.enum(["windows", "macos", "linux", "android", "ios", "web"]),
  hostname: z.string().trim().min(1).max(120).optional(),
  label: z.string().trim().min(1).max(120).optional(),
});
