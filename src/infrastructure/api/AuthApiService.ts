import type { BaseHttpClient } from "@/infrastructure/http";
import type {
  LoginRequest,
  LoginResponse,
  RefreshTokenRequest,
  RefreshTokenResponse,
} from "@/contracts/auth";

export class AuthApiService {
  constructor(private client: BaseHttpClient) {}

  async login(input: LoginRequest): Promise<LoginResponse> {
    const res = await this.client.post<LoginResponse>("/api/auth/login", input);
    return res.data;
  }

  async refreshToken(input: RefreshTokenRequest): Promise<RefreshTokenResponse> {
    const res = await this.client.post<RefreshTokenResponse>("/api/auth/refresh", input);
    return res.data;
  }

  async logout(): Promise<void> {
    await this.client.post("/api/auth/logout");
  }

  async getCurrentUser(): Promise<LoginResponse["user"]> {
    const res = await this.client.get<LoginResponse["user"]>("/api/auth/me");
    return res.data;
  }
}
