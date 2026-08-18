import type { UUID } from "../../domain/types/index.js";

export interface InvitationRow {
  id: UUID;
  tenantId: UUID;
  code: string;
  type: "device" | "user";
  expiresAt: Date;
  revokedAt: Date | null;
  useCount: number;
  metadata: Record<string, unknown>;
  createdBy: UUID;
  createdAt: Date;
}

export interface IInvitationRepository {
  create(input: {
    tenantId: UUID;
    code: string;
    type: "device" | "user";
    expiresAt: Date;
    metadata?: Record<string, unknown>;
    createdBy: UUID;
  }): Promise<InvitationRow>;

  findByCode(code: string): Promise<InvitationRow | null>;

  listByTenant(tenantId: UUID): Promise<InvitationRow[]>;

  revoke(id: UUID): Promise<void>;

  consume(id: UUID): Promise<InvitationRow>;
}
