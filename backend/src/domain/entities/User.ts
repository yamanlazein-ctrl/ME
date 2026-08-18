import type { UUID, Role } from "../types/index.js";

export interface UserData {
  id: UUID;
  tenantId: UUID;
  name: string;
  email: string;
  role: Role;
  active: boolean;
  createdAt: string;
}
