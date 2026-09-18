import { eq, and, isNull, count } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import {
  db as defaultDb,
  ambientDb,
  withTenantTx,
  type DB,
} from "../orm/drizzle.js";
import { runWithTenantContext, runWithPlatformContext } from "../orm/tenant-context.js";
import { getAmbientTx } from "../orm/ambient-tx.js";
import type { UUID } from "../../domain/types/index.js";
import type {
  IInvitationRepository,
  InvitationRow,
} from "../../application/ports/IInvitationRepository.js";
import { invitationCodes } from "../orm/schemas/invitation-code.table.js";
import { users } from "../orm/schemas/user.table.js";
import { deviceRegistrations } from "../orm/schemas/device-registration.table.js";
import { licenses } from "../orm/schemas/license.table.js";

type Row = typeof invitationCodes.$inferSelect;

function toRow(r: Row): InvitationRow {
  return {
    id: r.id,
    tenantId: r.tenantId,
    licenseId: r.licenseId ?? null,
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

/**
 * Invitation repository.
 *
 * Uses `ambientDb` so every write joins an outer `withTenantTx` when the
 * consume use case opens one (DFP-005 / DFP-006). Without an ambient
 * transaction, statements use the pool as before.
 */
export class PostgresInvitationRepository implements IInvitationRepository {
  constructor(private readonly db: DB = ambientDb(defaultDb) as DB) {}

  /** Run `fn` inside a single tenant-scoped transaction (ambient for this.db). */
  async runInTenantTransaction<T>(tenantId: UUID, fn: () => Promise<T>): Promise<T> {
    return withTenantTx(tenantId, () => fn());
  }

  /**
   * Lock the invitation row for the duration of the ambient transaction.
   * Callers MUST be inside `runInTenantTransaction` / `withTenantTx`.
   */
  async lockByIdForUpdate(id: UUID, tenantId: UUID): Promise<InvitationRow | null> {
    const [row] = await this.db
      .select()
      .from(invitationCodes)
      .where(and(eq(invitationCodes.id, id), eq(invitationCodes.tenantId, tenantId)))
      .for("update")
      .limit(1);
    return row ? toRow(row) : null;
  }

  /**
   * Serialize device/user seat allocation for a license (DFP-006).
   * No-op when licenseId is null.
   */
  async lockLicenseForUpdate(licenseId: UUID): Promise<void> {
    await this.db
      .select({ id: licenses.id })
      .from(licenses)
      .where(eq(licenses.id, licenseId))
      .for("update")
      .limit(1);
  }

  async countUsersInTenant(tenantId: UUID): Promise<number> {
    const [{ c }] = await this.db
      .select({ c: count() })
      .from(users)
      .where(eq(users.tenantId, tenantId));
    return Number(c);
  }

  async countDevicesInTenant(tenantId: UUID): Promise<number> {
    const [{ c }] = await this.db
      .select({ c: count() })
      .from(deviceRegistrations)
      .where(eq(deviceRegistrations.tenantId, tenantId));
    return Number(c);
  }

  async create(input: {
    tenantId: UUID;
    code: string;
    type: "device" | "user";
    expiresAt: Date;
    metadata?: Record<string, unknown>;
    createdBy: UUID;
    /** License the invitation belongs to (see `InvitationRow.licenseId`). */
    licenseId?: UUID | null;
  }): Promise<InvitationRow> {
    const [row] = await this.db
      .insert(invitationCodes)
      .values({
        ...input,
        // Explicit rather than relying on `...input`: the column is nullable,
        // but any invitation created through this path is bound to a real
        // license (or deliberately left null when the tenant has none).
        licenseId: input.licenseId ?? null,
        metadata: input.metadata ?? {},
      })
      .returning();
    if (!row) throw new Error("INVITATION_CREATE_FAILED");
    return toRow(row);
  }

  async findByCode(code: string): Promise<InvitationRow | null> {
    // Pre-auth lookup by code (invitation validate/consume): no JWT exists
    // yet, and the code must be resolvable regardless of which tenant issued
    // it. This is a bootstrap-style platform read — the tenant check happens
    // afterwards when the row's own tenantId drives the subsequent writes.
    return runWithPlatformContext(async () => {
      const [row] = await this.db
        .select()
        .from(invitationCodes)
        .where(eq(invitationCodes.code, code))
        .limit(1);
      return row ? toRow(row) : null;
    });
  }

  async listByTenant(tenantId: UUID): Promise<InvitationRow[]> {
    const rows = await this.db
      .select()
      .from(invitationCodes)
      .where(and(eq(invitationCodes.tenantId, tenantId), isNull(invitationCodes.revokedAt)))
      .orderBy(invitationCodes.createdAt);
    return rows.map(toRow);
  }

  async revoke(id: UUID, tenantId: UUID): Promise<boolean> {
    const rows = await this.db
      .update(invitationCodes)
      .set({ revokedAt: new Date() })
      .where(and(eq(invitationCodes.id, id), eq(invitationCodes.tenantId, tenantId)))
      .returning({ id: invitationCodes.id });
    return rows.length > 0;
  }

  async consume(id: UUID, tenantId: UUID): Promise<InvitationRow> {
    // Called from the pre-auth consume flow — stamp the invitation's own
    // tenant GUC so the UPDATE passes WITH CHECK (category-1 RLS).
    // When an ambient withTenantTx is active, this.db is already on that tx.
    const run = async () => {
      const [row] = await this.db
        .update(invitationCodes)
        .set({ useCount: 1 })
        .where(
          and(
            eq(invitationCodes.id, id),
            eq(invitationCodes.tenantId, tenantId),
            eq(invitationCodes.useCount, 0),
          ),
        )
        .returning();
      if (!row) throw new Error("INVITATION_ALREADY_CONSUMED");
      return toRow(row);
    };
    // Avoid nested withTenantTx savepoint noise when already ambient.
    if (this.inAmbient()) return run();
    return runWithTenantContext({ tenantId }, run);
  }

  private inAmbient(): boolean {
    return getAmbientTx() != null;
  }

  async createUserFromInvitation(
    tenantId: UUID,
    invitationId: UUID,
    name: string,
    email: string,
    role: string,
    passwordHash: string,
  ): Promise<{ id: UUID }> {
    const run = async () => {
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
      void invitationId;
      return u;
    };
    if (this.inAmbient()) return run();
    return runWithTenantContext({ tenantId }, run);
  }

  async setUserPinHash(tenantId: UUID, userId: UUID, pinHash: string): Promise<void> {
    const run = async () => {
      await this.db
        .update(users)
        .set({ pinHash, updatedAt: new Date() })
        .where(eq(users.id, userId));
    };
    if (this.inAmbient()) return run();
    return runWithTenantContext({ tenantId }, run);
  }

  async registerDevice(
    tenantId: UUID,
    licenseId: UUID,
    fingerprint: string,
  ): Promise<{ id: UUID }> {
    const run = async () => {
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
    };
    if (this.inAmbient()) return run();
    return runWithTenantContext({ tenantId }, run);
  }
}
