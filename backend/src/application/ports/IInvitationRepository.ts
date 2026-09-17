import type { UUID } from "../../domain/types/index.js";

export interface InvitationRow {
  id: UUID;
  tenantId: UUID;
  /**
   * The license this invitation was issued against.
   *
   * Nullable in the database because rows written before migration 0021
   * predate the column, but every invitation the current code creates is
   * stamped with the tenant's license id: redemption has to bind the accepting
   * device to a REAL license, because `device_registrations.license_id` is
   * `NOT NULL REFERENCES licenses(id)`. Without it, a redeemed invitation has
   * nothing to attach the device to and would have to invent a placeholder id
   * (which violates the FK).
   */
  licenseId: UUID | null;
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
    /** License the invitation belongs to (see `InvitationRow.licenseId`). */
    licenseId?: UUID | null;
  }): Promise<InvitationRow>;

  findByCode(code: string): Promise<InvitationRow | null>;

  listByTenant(tenantId: UUID): Promise<InvitationRow[]>;

  revoke(id: UUID, tenantId: UUID): Promise<boolean>;

  consume(id: UUID, tenantId: UUID): Promise<InvitationRow>;
}
