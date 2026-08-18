import type { TenantContext, PaginatedResult, UUID } from "../../domain/types/index.js";

export interface IAuthRepository {
  findUserByEmail(
    email: string,
    tenantId?: string,
  ): Promise<{
    id: UUID;
    tenantId: UUID;
    name: string;
    email: string;
    passwordHash: string;
    role: string;
    active: boolean;
  } | null>;

  findUserById(id: string): Promise<{
    id: UUID;
    tenantId: UUID;
    name: string;
    email: string;
    role: string;
    active: boolean;
  } | null>;

  /** Create a user (used by the setup wizard to promote admin credentials). */
  createUser(input: {
    tenantId: UUID;
    name: string;
    email: string;
    passwordHash: string;
    role: string;
  }): Promise<{
    id: UUID;
    tenantId: UUID;
    name: string;
    email: string;
    role: string;
    active: boolean;
  }>;
}
