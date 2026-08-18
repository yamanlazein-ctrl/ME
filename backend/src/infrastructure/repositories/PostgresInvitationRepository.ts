import { eq, and, isNull } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { db as defaultDb, withTenantTx, type DB } from "../orm/drizzle.js";
import type { UUID } from "../../domain/types/index.js";
import type {
  IInvitationRepository,
  InvitationRow,
} from "../../application/ports/IInvitationRepository.js";
import { invitationCodes } from "../orm/schemas/invitation-code.table.js";
import { users } from "../orm/schemas/user.table.js";
import { deviceRegistrations } from "../orm/schemas/device-registration.table.js";

type Row = typeof invitationCodes.$inferSelect;

function toRow(r: Row): InvitationRow {
  return {
    id: r.id,
    tenantId: r.tenantId,
    code: r.code,
    type: r.type as "device" | "user",
    expiresAt: r.expiresAt,
    revokedAt: r.revokedAt,
    useCount: r.useCount,
    metadata: (r.metadata as Record<string, unknown>) ?? {},
    createdBy: r.createdBy,
    createdAt: r.createdAt,
  };
}

export class PostgresInvitationRepository implements IInvitationRepository {
  constructor(private readonly db: DB = defaultDb) {}

  async create(input: {
    tenantId: UUID;
    code: string;
    type: "device" | "user";
    expiresAt: Date;
    metadata?: Record<string, unknown>;
    createdBy: UUID;
  }): Promise<InvitationRow> {
    const [row] = await this.db
      .insert(invitationCodes)
      .values({ ...input, metadata: input.metadata ?? {} })
      .returning();
    if (!row) throw new Error("INVITATION_CREATE_FAILED");
    return toRow(row);
  }

  async findByCode(code: string): Promise<InvitationRow | null> {
    const [row] = await this.db
      .select()
      .from(invitationCodes)
      .where(eq(invitationCodes.code, code))
      .limit(1);
    return row ? toRow(row) : null;
  }

  async listByTenant(tenantId: UUID): Promise<InvitationRow[]> {
    const rows = await this.db
      .select()
      .from(invitationCodes)
      .where(
        and(
          eq(invitationCodes.tenantId, tenantId),
          isNull(invitationCodes.revokedAt),
        ),
      )
      .orderBy(invitationCodes.createdAt);
    return rows.map(toRow);
  }

  async revoke(id: UUID): Promise<void> {
    await this.db
      .update(invitationCodes)
      .set({ revokedAt: new Date() })
      .where(eq(invitationCodes.id, id));
  }

  async consume(id: UUID): Promise<InvitationRow> {
    const [row] = await this.db
      .update(invitationCodes)
      .set({ useCount: 1 })
      .where(eq(invitationCodes.id, id))
      .returning();
    if (!row) throw new Error("INVITATION_CONSUME_FAILED");
    return toRow(row);
  }

  async createUserFromInvitation(
    tenantId: UUID,
    invitationId: UUID,
    name: string,
    email: string,
    role: string,
    passwordHash: string,
  ): Promise<{ id: UUID }> {
    const [u] = await this.db
      .insert(users)
      .values({
        tenantId,
        name,
        email,
        role,
        passwordHash,
        active: true,
      })
      .returning({ id: users.id });
    if (!u) throw new Error("USER_CREATE_FAILED");
    return u;
  }

  async registerDevice(
    tenantId: UUID,
    licenseId: UUID,
    fingerprint: string,
  ): Promise<{ id: UUID }> {
    const [d] = await this.db
      .insert(deviceRegistrations)
      .values({
        licenseId,
        tenantId,
        deviceId: randomUUID(),
        deviceFingerprint: fingerprint,
        deviceFingerprintVersion: 1,
        platform: "web",
        lastSeenAt: new Date(),
      })
      .returning({ id: deviceRegistrations.id });
    if (!d) throw new Error("DEVICE_REGISTER_FAILED");
    return d;
  }
}
