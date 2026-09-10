import { and, eq } from "drizzle-orm";
import type { DB } from "../orm/drizzle.js";
import { runWithTenantContext } from "../orm/tenant-context.js";
import type {
  IRegisterSyncDeviceInput,
  ISyncDeviceRepository,
} from "../../application/ports/ISyncDeviceRepository.js";
import { syncDevices } from "../orm/schemas/sync-device.table.js";

export class PostgresSyncDeviceRepository implements ISyncDeviceRepository {
  constructor(private readonly db: DB) {}

  async registerOrTouch(input: IRegisterSyncDeviceInput) {
    return runWithTenantContext({ tenantId: input.tenantId }, async () => {
      const existing = await this.db
        .select()
        .from(syncDevices)
        .where(
          and(
            eq(syncDevices.tenantId, input.tenantId),
            eq(syncDevices.deviceFingerprint, input.deviceFingerprint),
          ),
        )
        .limit(1);

      if (existing[0]) {
        const [updated] = await this.db
          .update(syncDevices)
          .set({
            lastSeenByUserId: input.userId,
            deviceFingerprintVersion: input.deviceFingerprintVersion ?? 1,
            platform: input.platform,
            hostname: input.hostname ?? null,
            label: input.label ?? input.hostname ?? null,
            lastSeenAt: new Date(),
            updatedAt: new Date(),
          })
          .where(eq(syncDevices.id, existing[0].id))
          .returning();
        return updated;
      }

      const [created] = await this.db
        .insert(syncDevices)
        .values({
          tenantId: input.tenantId,
          lastSeenByUserId: input.userId,
          deviceFingerprint: input.deviceFingerprint,
          deviceFingerprintVersion: input.deviceFingerprintVersion ?? 1,
          platform: input.platform,
          hostname: input.hostname ?? null,
          label: input.label ?? input.hostname ?? null,
        })
        .returning();
      return created;
    });
  }
}
