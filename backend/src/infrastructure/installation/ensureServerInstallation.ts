import { eq } from "drizzle-orm";
import type { DB } from "../orm/drizzle.js";
import { runWithPlatformContext } from "../orm/tenant-context.js";
import { serverInstallations } from "../orm/schemas/server-installation.table.js";

export type EnsureServerInstallationInput = {
  /** Canonical on-disk Installation UUID. */
  installationId: string;
  tenantId: string | null;
  hostname?: string | null;
  os?: string | null;
  osVersion?: string | null;
  appVersion?: string | null;
};

/**
 * Upsert the Installation into `server_installations` so the DB registry
 * matches the on-disk install-id. Idempotent; safe on every activate/boot.
 */
export async function ensureServerInstallation(
  db: DB,
  input: EnsureServerInstallationInput,
): Promise<{ id: string; installationId: string }> {
  return runWithPlatformContext(async () => {
    const installationId = input.installationId.trim();
    if (!installationId) throw new Error("INSTALLATION_ID_REQUIRED");

    const [existing] = await db
      .select()
      .from(serverInstallations)
      .where(eq(serverInstallations.installationId, installationId as never))
      .limit(1);

    if (existing) {
      const [row] = await db
        .update(serverInstallations)
        .set({
          tenantId: (input.tenantId as never) ?? existing.tenantId,
          hostname: input.hostname ?? existing.hostname,
          os: input.os ?? existing.os,
          osVersion: input.osVersion ?? existing.osVersion,
          appVersion: input.appVersion ?? existing.appVersion,
          lastHeartbeatAt: new Date(),
        })
        .where(eq(serverInstallations.id, existing.id))
        .returning();
      return { id: row!.id, installationId: row!.installationId };
    }

    const [row] = await db
      .insert(serverInstallations)
      .values({
        installationId: installationId as never,
        tenantId: (input.tenantId as never) ?? null,
        hostname: input.hostname ?? null,
        os: input.os ?? null,
        osVersion: input.osVersion ?? null,
        appVersion: input.appVersion ?? null,
        lastHeartbeatAt: new Date(),
      })
      .returning();
    if (!row) throw new Error("SERVER_INSTALLATION_INSERT_FAILED");
    return { id: row.id, installationId: row.installationId };
  });
}
