import type { TenantContext, PaginatedResult } from "../../domain/types/index.js";
import type { UserData } from "../../domain/entities/User.js";

export interface UserFilter {
  search?: string;
  role?: string;
  active?: boolean;
  page?: number;
  limit?: number;
}

export interface CreateUserData {
  name: string;
  email: string;
  password: string;
  role: string;
  active?: boolean;
}

export interface IUserRepository {
  findById(id: string, ctx: TenantContext): Promise<UserData | null>;
  findByEmail(email: string, tenantId: string): Promise<UserData | null>;
  list(filter: UserFilter, ctx: TenantContext): Promise<PaginatedResult<UserData>>;
  create(data: CreateUserData, ctx: TenantContext): Promise<UserData>;
  update(id: string, data: Partial<CreateUserData>, ctx: TenantContext): Promise<UserData>;
  delete(id: string, ctx: TenantContext): Promise<void>;
}
