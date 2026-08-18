import type {
  IAuthRepository,
  LoginInput,
  LoginResult,
  RefreshTokenInput,
  RefreshTokenResult,
} from "@/application/ports/IAuthRepository";
import type { TenantContext } from "@/domain/types";
import type { LoginRequest, RefreshTokenRequest } from "@/contracts/auth";
import { AuthApiService } from "@/infrastructure/api";

export class ApiAuthRepository implements IAuthRepository {
  constructor(private api: AuthApiService) {}

  async login(input: LoginInput): Promise<LoginResult> {
    const req: LoginRequest = {
      email: input.email,
      password: input.password,
      tenantId: input.tenantId,
    };
    const res = await this.api.login(req);
    return { accessToken: res.accessToken, refreshToken: res.refreshToken, user: res.user };
  }

  async refreshToken(input: RefreshTokenInput): Promise<RefreshTokenResult> {
    const req: RefreshTokenRequest = { refreshToken: input.refreshToken };
    const res = await this.api.refreshToken(req);
    return { accessToken: res.accessToken, refreshToken: res.refreshToken };
  }

  async logout(ctx: TenantContext): Promise<void> {
    await this.api.logout();
  }

  async getCurrentUser(ctx: TenantContext): Promise<LoginResult["user"]> {
    return this.api.getCurrentUser();
  }
}
