import { hostname, platform as osPlatform } from "node:os";
import { db } from "../../../infrastructure/orm/drizzle.js";
import { logger } from "../../../infrastructure/config/logger.js";
import { getCentralSyncUrl, resolveHubAuthHeader } from "./hubConfig.js";
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
import { documentSequences } from "../../../infrastructure/orm/schemas/document-sequence.table.js";
import { and, eq, sql } from "drizzle-orm";

/**
 * Entity types provisioned automatically whenever a device comes online.
 *
 * `customer`/`supplier` were added after the multi-device acceptance run of
 * 2026-09-10 proved the collision: two offline devices both minted
 * `CUS-<year>-0001` because party codes were never block-allocated, so the
 * second party insert on the hub violated `parties (tenant_id, code)` and the
 * unit was stranded in `received`. Master data is now reserved like documents.
 *
 * `voucher`/`return`/`expense`/`order` complete the set (P4): their
 * repositories consume blocks in-transaction (fail-loud without one), so an
 * unprovisioned device hard-fails offline voucher/return creation instead of
 * minting colliding shared-sequence numbers. Every entry here must have a
 * PREFIX, WIDTH and DEFAULT_BLOCK_SIZE (see documentNumbers.ts).
 */
const PRIMARY_ENTITY_TYPES = [
  "invoice",
  "invoice_entry",
  "customer",
  "supplier",
  "voucher",
  "return",
  "expense",
  "order",
] as const;

export async function claimNumberBlock(input: {
  tenantId: UUID;
  syncDeviceId: UUID;
  entityType: string;
  size?: number;
  /**
   * Highest number the CLAIMING device already issued for this entity (via
   * local shared-sequence fallback before its first block, or on another
   * node whose history the hub never saw). The hub advances its own tip to
   * at least this value BEFORE carving, so the carved range can never overlap
   * numbers already in the wild. Without this, a device that created
   * documents pre-registration collides with its own first hub block
   * (reproduced live: fallback-issued CUS-2026-0001 vs hub-claimed [1..500]).
   */
  knownUsed?: number | null;
}) {
  await assertDeviceBelongsToTenant(input.tenantId, input.syncDeviceId);
  const year = new Date().getFullYear();
  return db.transaction(async (tx) => {
    if (
      typeof input.knownUsed === "number" &&
      Number.isFinite(input.knownUsed) &&
      input.knownUsed > 0
    ) {
      const { prefix } = resolveNumberFormat(input.entityType);
      await tx
        .insert(documentSequences)
        .values({
          tenantId: input.tenantId,
          entityType: input.entityType,
          prefix,
          lastNumber: Math.min(Math.floor(input.knownUsed), 999999),
        })
        .onConflictDoUpdate({
          target: [
            documentSequences.tenantId,
            documentSequences.entityType,
            documentSequences.prefix,
          ],
          set: {
            lastNumber: sql`LEAST(
              GREATEST(${documentSequences.lastNumber}, ${Math.min(Math.floor(input.knownUsed), 999999)}),
              ${documentSequences.lastNumber} + 2000
            )`,
          },
        });
    }
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

  const hub = getCentralSyncUrl();
  const authHeader = await resolveHubAuthHeader(input.authHeader);
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

    if (hub && authHeader) {
      try {
        if (!hubDeviceId) {
          hubDeviceId = await registerDeviceOnHub(hub, fingerprintProvider, authHeader);
        }
        // Tip reconciliation: the hub must carve above anything this device
        // already issued via local fallback (its shared sequence), or the
        // carved range overlaps numbers already in the wild.
        const knownUsed = await readLocalSequenceTip(input.tenantId, entityType);
        const claimed = await claimBlockFromHub(hub, {
          entityType,
          syncDeviceId: hubDeviceId,
          size: defaultBlockSize(entityType),
          authHeader,
          knownUsed,
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
          "hub number-block claim failed; not carving a local overlapping range",
        );
        continue;
      }
    }

    if (hub) {
      logger.warn(
        { entityType },
        "hub configured but block was not claimed from hub — skipping local carve",
      );
      continue;
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
    const row = await blocks.insertClaimed(input);
    // Advance the LOCAL shared-sequence tip past the mirrored range: a later
    // local claim (hub unreachable) carves from the local tip and must not
    // overlap the hub-issued range mirrored here.
    await advanceLocalSequenceTip(input.tenantId, input.entityType, input.endNumber);
    return row;
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

/**
 * Highest number this node issued for the entity via its local
 * shared-sequence fallback (0 when none). Sent to the hub on block claim so
 * the hub carves above it (tip reconciliation).
 */
async function readLocalSequenceTip(tenantId: UUID, entityType: string): Promise<number> {
  try {
    const { prefix } = resolveNumberFormat(entityType);
    const [row] = await db
      .select({ lastNumber: documentSequences.lastNumber })
      .from(documentSequences)
      .where(
        and(
          eq(documentSequences.tenantId, tenantId),
          eq(documentSequences.entityType, entityType),
          eq(documentSequences.prefix, prefix),
        ),
      )
      .limit(1);
    return row?.lastNumber ?? 0;
  } catch {
    return 0;
  }
}

async function advanceLocalSequenceTip(
  tenantId: UUID,
  entityType: string,
  atLeast: number,
): Promise<void> {
  try {
    const { prefix } = resolveNumberFormat(entityType);
    const target = Math.min(Math.floor(atLeast), 999999);
    if (!(target > 0)) return;
    await db
      .insert(documentSequences)
      .values({ tenantId, entityType, prefix, lastNumber: target })
      .onConflictDoUpdate({
        target: [
          documentSequences.tenantId,
          documentSequences.entityType,
          documentSequences.prefix,
        ],
        set: {
          lastNumber: sql`GREATEST(${documentSequences.lastNumber}, ${target})`,
        },
      });
  } catch (err) {
    logger.warn({ err, entityType }, "local sequence tip advance failed (non-fatal)");
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
    knownUsed?: number | null;
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
      ...(typeof input.knownUsed === "number" && input.knownUsed > 0
        ? { knownUsed: Math.floor(input.knownUsed) }
        : null),
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
