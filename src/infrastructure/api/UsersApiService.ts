import type { BaseHttpClient } from "@/infrastructure/http";

export type UserRole = "admin" | "accountant" | "warehouse" | "viewer";

/** A tenant user as `GET /api/users` returns it (the `users` table the login reads). */
export interface TenantUserDTO {
  id: string;
  name: string;
  email: string;
  role: UserRole;
  active: boolean;
  createdAt: string;
}

type Page = { data: TenantUserDTO[]; meta?: { hasNext?: boolean } };

export type UserDraft = Pick<TenantUserDTO, "name" | "email" | "role" | "active">;

/** Only the fields that changed — the API validates `email` as an address, so an untouched one is not resent. */
export function changedUserFields(draft: UserDraft, original: TenantUserDTO): Partial<UserDraft> {
  const patch: Partial<UserDraft> = {};
  if (draft.name.trim() !== original.name) patch.name = draft.name.trim();
  if (draft.email.trim() !== original.email) patch.email = draft.email.trim();
  if (draft.role !== original.role) patch.role = draft.role;
  if (draft.active !== original.active) patch.active = draft.active;
  return patch;
}

/**
 * hermes F-015: the real user endpoints (backend user.route.ts). Accounts are CREATED by accepting an
 * invitation (InvitationManager); this edits and deactivates them.
 */
export class UsersApiService {
  constructor(private client: BaseHttpClient) {}

  /** Every user of the tenant (the route caps a page at 100). */
  async list(): Promise<TenantUserDTO[]> {
    const all: TenantUserDTO[] = [];
    for (let page = 0; ; page++) {
      const res = await this.client.get<Page>("/api/users", {
        params: { page: String(page), limit: "100" },
      });
      all.push(...(res.data.data ?? []));
      if (!res.data.meta?.hasNext) return all;
    }
  }

  async update(id: string, patch: Partial<UserDraft>): Promise<void> {
    await this.client.patch(`/api/users/${id}`, patch);
  }

  /** Soft delete: the backend deactivates the account (`DELETE /api/users/:id`). */
  async deactivate(id: string): Promise<void> {
    await this.client.delete(`/api/users/${id}`);
  }
}
