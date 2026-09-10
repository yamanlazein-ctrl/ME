import type { TenantContext, PaginatedResult, UUID } from "../../domain/types/index.js";

export interface AuthUserRow {
  id: UUID;
  tenantId: UUID;
  name: string;
  email: string;
  passwordHash: string;
  pinHash: string | null;
  role: string;
  active: boolean;
}

export interface IAuthRepository {
  findUserByEmail(email: string, tenantId?: string): Promise<AuthUserRow | null>;

  findUserById(id: string): Promise<{
    id: UUID;
    tenantId: UUID;
    name: string;
    email: string;
    role: string;
    active: boolean;
    pinHash?: string | null;
  } | null>;

  findUserByIdForAuth(id: string, tenantId: string): Promise<AuthUserRow | null>;

  listActiveUsersForTenant(tenantId: string): Promise<
    { id: UUID; name: string; email: string; role: string; hasPin: boolean }[]
  >;

  setPinHash(userId: string, tenantId: string, pinHash: string): Promise<void>;

  /** Create a user (used by the setup wizard to promote admin credentials). */
  createUser(input: {
    tenantId: UUID;
    name: string;
    email: string;
    passwordHash: string;
    role: string;
    pinHash?: string | null;
  }): Promise<{
    id: UUID;
    tenantId: UUID;
    name: string;
    email: string;
    role: string;
    active: boolean;
  }>;
}
