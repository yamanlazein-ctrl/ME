import { hostname, platform as osPlatform } from "node:os";
import { db } from "../../../infrastructure/orm/drizzle.js";
import { config } from "../../../infrastructure/config/env.js";
import { logger } from "../../../infrastructure/config/logger.js";
import {
  claimNumberBlockInTx,
  defaultBlockSize,
  reclaimNumberBlockTailInTx,
  resolveNumberFormat,
} from "../../../infrastructure/utils/documentNumbers.js";
import type { IDocumentNumberBlockRepository } from "../../ports/IDocumentNumberBlockRepository.js";
import type { IMachineFingerprintProvider } from "../../ports/IMachineFingerprintProvider.js";
import type { UUID } from "../../../domain/types/index.js";
import { BusinessRuleError } from "../../../domain/errors/index.js";
import { syncDevices } from "../../../infrastructure/orm/schemas/sync-device.table.js";
import { and, eq } from "drizzle-orm";

const PRIMARY_ENTITY_TYPES = ["invoice", "invoice_entry"] as const;

export async function claimNumberBlock(input: {
  tenantId: UUID;
  syncDeviceId: UUID;
  entityType: string;
  size?: number;
}) {
  await assertDeviceBelongsToTenant(input.tenantId, input.syncDeviceId);
  const year = new Date().getFullYear();
  return db.transaction(async (tx) => {
    return claimNumberBlockInTx(tx, {
      tenantId: input.tenantId,
      syncDeviceId: input.syncDeviceId,
      entityType: input.entityType,
      size: input.size,
      year,
    });
  });
}

export async function reclaimNumberBlock(input: { tenantId: UUID; blockId: UUID }) {
  return db.transaction(async (tx) => {
    return reclaimNumberBlockTailInTx(tx, input);
  });
}

/**
 * Ensure the device has an active block for each primary entity type.
 * Claims locally when no hub is configured; otherwise asks CENTRAL_SYNC_URL
 * (after registering this machine's fingerprint on the hub).
 */
export async function ensureDeviceNumberBlocks(
  blocks: IDocumentNumberBlockRepository,
  fingerprintProvider: IMachineFingerprintProvider,
  input: {
    tenantId: UUID;
    syncDeviceId: UUID;
    userId: UUID;
    authHeader?: string;
    entityTypes?: string[];
  },
): Promise<{
  ensured: Array<{
    entityType: string;
    startNumber: number;
    endNumber: number;
    source: "local" | "hub" | "existing";
  }>;
  skipped: boolean;
  reason?: string;
}> {
  await assertDeviceBelongsToTenant(input.tenantId, input.syncDeviceId);
  const year = new Date().getFullYear();
  const types = input.entityTypes?.length ? input.entityTypes : [...PRIMARY_ENTITY_TYPES];
  const ensured: Array<{
    entityType: string;
    startNumber: number;
    endNumber: number;
    source: "local" | "hub" | "existing";
  }> = [];

  const hub = config.CENTRAL_SYNC_URL?.replace(/\/+$/, "");
  let hubDeviceId: string | null = null;

  for (const entityType of types) {
    const existing = await blocks.findActive(input.tenantId, input.syncDeviceId, entityType, year);
    if (existing && existing.nextNumber <= existing.endNumber) {
      ensured.push({
        entityType,
        startNumber: existing.startNumber,
        endNumber: existing.endNumber,
        source: "existing",
      });
      continue;
    }

    if (hub && input.authHeader) {
      try {
        if (!hubDeviceId) {
          hubDeviceId = await registerDeviceOnHub(hub, fingerprintProvider, input.authHeader);
        }
        const claimed = await claimBlockFromHub(hub, {
          entityType,
          syncDeviceId: hubDeviceId,
          size: defaultBlockSize(entityType),
          authHeader: input.authHeader,
        });
        const mirrored = await mirrorClaimedBlock(blocks, {
          tenantId: input.tenantId,
          syncDeviceId: input.syncDeviceId,
          entityType: claimed.entityType,
          year: claimed.year,
          prefix: claimed.prefix,
          startNumber: claimed.startNumber,
          endNumber: claimed.endNumber,
        });
        ensured.push({
          entityType: mirrored.entityType,
          startNumber: mirrored.startNumber,
          endNumber: mirrored.endNumber,
          source: "hub",
        });
        continue;
      } catch (err) {
        logger.warn(
          { err, entityType },
          "hub number-block claim failed; falling back to local claim",
        );
      }
    }

    const local = await claimNumberBlock({
      tenantId: input.tenantId,
      syncDeviceId: input.syncDeviceId,
      entityType,
    });
    ensured.push({
      entityType: local.entityType,
      startNumber: local.startNumber,
      endNumber: local.endNumber,
      source: "local",
    });
  }

  return { ensured, skipped: false };
}

async function mirrorClaimedBlock(
  blocks: IDocumentNumberBlockRepository,
  input: {
    tenantId: UUID;
    syncDeviceId: UUID;
    entityType: string;
    year: number;
    prefix: string;
    startNumber: number;
    endNumber: number;
  },
) {
  try {
    return await blocks.insertClaimed(input);
  } catch (err) {
    const existing = await blocks.findActive(
      input.tenantId,
      input.syncDeviceId,
      input.entityType,
      input.year,
    );
    if (existing) return existing;
    throw err;
  }
}

async function registerDeviceOnHub(
  hub: string,
  fingerprintProvider: IMachineFingerprintProvider,
  authHeader: string,
): Promise<string> {
  const collected = await fingerprintProvider.collect();
  const meta = await fingerprintProvider.getMetadata(collected);
  const platform =
    osPlatform() === "win32"
      ? "windows"
      : osPlatform() === "darwin"
        ? "macos"
        : osPlatform() === "linux"
          ? "linux"
          : "web";
  const res = await fetch(`${hub}/api/auth/sync-device`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: authHeader,
    },
    body: JSON.stringify({
      deviceFingerprint: meta.hash,
      deviceFingerprintVersion: meta.version,
      platform,
      hostname: hostname() || undefined,
      label: hostname() || undefined,
    }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`hub sync-device ${res.status}: ${text.slice(0, 200)}`);
  }
  const body = (await res.json()) as { id: string };
  return body.id;
}

async function claimBlockFromHub(
  hub: string,
  input: {
    entityType: string;
    syncDeviceId: string;
    size: number;
    authHeader?: string;
  },
): Promise<{
  entityType: string;
  year: number;
  prefix: string;
  startNumber: number;
  endNumber: number;
}> {
  const res = await fetch(`${hub}/api/sync/number-blocks/claim`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(input.authHeader ? { Authorization: input.authHeader } : {}),
      "X-Sync-Device-Id": input.syncDeviceId,
    },
    body: JSON.stringify({
      syncDeviceId: input.syncDeviceId,
      entityType: input.entityType,
      size: input.size,
    }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`hub claim ${res.status}: ${text.slice(0, 200)}`);
  }
  const body = (await res.json()) as {
    entityType: string;
    year: number;
    prefix: string;
    startNumber: number;
    endNumber: number;
  };
  return body;
}

async function assertDeviceBelongsToTenant(tenantId: string, syncDeviceId: string): Promise<void> {
  const [row] = await db
    .select({ id: syncDevices.id })
    .from(syncDevices)
    .where(and(eq(syncDevices.id, syncDeviceId), eq(syncDevices.tenantId, tenantId)))
    .limit(1);
  if (!row) {
    throw new BusinessRuleError("جهاز المزامنة غير مسجّل على هذا المستأجر");
  }
}

export function describeBlockFormat(entityType: string) {
  return { ...resolveNumberFormat(entityType), defaultSize: defaultBlockSize(entityType) };
}
