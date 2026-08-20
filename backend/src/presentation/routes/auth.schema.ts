import { z } from "zod";

export const LoginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
  tenantId: z.string().uuid(),
});

export const RefreshTokenSchema = z.object({
  refreshToken: z.string().min(1),
});
