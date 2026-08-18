import type { TenantContext } from "@/domain/types";

export interface LoginInput {
  email: string;
  password: string;
  tenantId?: string;
}

export interface LoginResult {
  accessToken: string;
  refreshToken?: string;
  user: { id: string; name: string; email: string; role: string };
}

export interface RefreshTokenInput {
  refreshToken: string;
}

export interface RefreshTokenResult {
  accessToken: string;
  refreshToken?: string;
}

export interface IAuthRepository {
  login(input: LoginInput): Promise<LoginResult>;
  refreshToken(input: RefreshTokenInput): Promise<RefreshTokenResult>;
  logout(ctx: TenantContext): Promise<void>;
  getCurrentUser(ctx: TenantContext): Promise<LoginResult["user"]>;
}
