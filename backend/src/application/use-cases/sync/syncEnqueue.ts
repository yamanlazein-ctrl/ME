import { randomUUID, createHash } from "node:crypto";
import { config } from "../../../infrastructure/config/env.js";
import { getCentralSyncUrl } from "./hubConfig.js";
import type { ISyncOutboxRepository } from "../../ports/ISyncOutboxRepository.js";
import type { TenantContext } from "../../../domain/types/index.js";
import type { CreateVoucherInput } from "../../../domain/entities/Voucher.js";
import type { CreateReturnInput } from "../../../domain/entities/Return.js";
import type { CreateOrderInput } from "../../../domain/entities/Order.js";
import type { CreateExpenseInput } from "../../../domain/entities/Expense.js";
import type { UpdateInvoiceInput } from "../../../domain/entities/Invoice.js";
import type { InvoiceSyncDependencies } from "./syncDependencySnapshots.js";

export function isSyncEnqueueEnabled(): boolean {
  return true;
}

/** Device number blocks are only used when this install participates in sync. */
export function isOfflineNumberingEnabled(): boolean {
  return Boolean(config.DESKTOP_DEPLOY || getCentralSyncUrl());
}

export function syncDeviceIdFromRequest(req: {
  headers: Record<string, string | string[] | undefined>;
  tenantContext?: { syncDeviceId?: string | null };
}): string | null {
  if (req.tenantContext?.syncDeviceId) return req.tenantContext.syncDeviceId;
  const h = req.headers["x-sync-device-id"];
  if (typeof h === "string") return h;
  if (Array.isArray(h)) return h[0] ?? null;
  return null;
}

export function opIdFromRequest(req: {
  headers: Record<string, string | string[] | undefined>;
}): string | undefined {
  const h = req.headers["idempotency-key"];
  if (typeof h === "string") return h;
  if (Array.isArray(h)) return h[0];
  return undefined;
}

/**
 * Stable UUID for synthetic keys (dates, section names, tenant singletons).
 * Same input on any device yields the same UUID. Duplicated in
 * syncUseCases.ts's claim-key helper — kept side by side (not imported)
 * because this module is the dependency leaf of the sync surface.
 */
export function uuidFromString(value: string): string {
  const h = createHash("sha256").update(value, "utf8").digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

export async function enqueueSyncUnit(
  outbox: ISyncOutboxRepository,
  input: {
    tenantId: string;
    syncDeviceId: string | null;
    opId?: string;
    entityType: string;
    entityId: string;
    operation: string;
    payload: Record<string, unknown>;
  },
) {
  return outbox.enqueue({
    tenantId: input.tenantId,
    syncDeviceId: input.syncDeviceId && isUuid(input.syncDeviceId) ? input.syncDeviceId : null,
    opId: input.opId && isUuid(input.opId) ? input.opId : randomUUID(),
    entityType: input.entityType,
    entityId: input.entityId,
    operation: input.operation,
    payload: input.payload,
  });
}

/**
 * Enqueue a voucher cancellation (P5 / SYNC-01).
 *
 * Voucher cancel used to call the use-case directly with no outbox unit, so a
 * cancelling device diverged from all peers permanently: payer/payee balances
 * and ledger legs never converged. Mirrors enqueueReturnCancel exactly.
 *
 * `baseVersion` (P0-001/P3b parity with updates): the version the cancelling
 * device held when it cancelled. The hub refuses a cancel whose base no longer
 * matches instead of voiding a document another device edited in the meantime.
 */
export async function enqueueVoucherCancel(
  outbox: ISyncOutboxRepository,
  voucher: { id: string; number?: string },
  ctx: TenantContext,
  syncDeviceId: string | null,
  opId?: string,
  baseVersion?: number | null,
) {
  return enqueueSyncUnit(outbox, {
    tenantId: ctx.tenantId,
    syncDeviceId,
    opId,
    entityType: "voucher",
    entityId: voucher.id,
    operation: "cancel",
    payload: {
      voucherId: voucher.id,
      voucherNumber: voucher.number ?? null,
      baseVersion: baseVersion ?? null,
      actorUserId: ctx.userId,
      actorRole: ctx.userRole,
      actorUserName: ctx.userName,
    },
  });
}

export async function enqueueVoucherCreate(
  outbox: ISyncOutboxRepository,
  voucher: { id: string; kind: string; number: string; partyId: string },
  createInput: CreateVoucherInput,
  ctx: TenantContext,
  syncDeviceId: string | null,
  opId?: string,
  dependencies?: InvoiceSyncDependencies | null,
) {
  return enqueueSyncUnit(outbox, {
    tenantId: ctx.tenantId,
    syncDeviceId,
    opId,
    entityType: "voucher",
    entityId: voucher.id,
    operation: "create",
    payload: {
      voucherId: voucher.id,
      voucherKind: voucher.kind,
      voucherNumber: voucher.number,
      partyId: voucher.partyId,
      createInput,
      dependencies: dependencies ?? null,
      preAllocated: true,
      actorUserId: ctx.userId,
      actorRole: ctx.userRole,
      actorUserName: ctx.userName,
    },
  });
}

/**
 * Enqueue an invoice cancellation.
 *
 * `baseVersion`: the version the cancelling device held (the same value its
 * local cancel was checked against). Carried so the hub can refuse a cancel
 * that would void a NEWER edit made by another device (P3b parity) instead of
 * silently overwriting it — cancel is a financial mutation like any other.
 */
export async function enqueueInvoiceCancel(
  outbox: ISyncOutboxRepository,
  invoice: { id: string; number?: string; type?: string },
  ctx: TenantContext,
  syncDeviceId: string | null,
  opId?: string,
  baseVersion?: number | null,
) {
  return enqueueSyncUnit(outbox, {
    tenantId: ctx.tenantId,
    syncDeviceId,
    opId,
    entityType: "invoice",
    entityId: invoice.id,
    operation: "cancel",
    payload: {
      invoiceId: invoice.id,
      invoiceNumber: invoice.number ?? null,
      invoiceType: invoice.type ?? null,
      baseVersion: baseVersion ?? null,
      actorUserId: ctx.userId,
      actorRole: ctx.userRole,
      actorUserName: ctx.userName,
    },
  });
}

export async function enqueueMasterCreate(
  outbox: ISyncOutboxRepository,
  entityType: "party" | "fabric" | "color" | "roll",
  entityId: string,
  snapshot: Record<string, unknown>,
  ctx: TenantContext,
  syncDeviceId: string | null,
  opId?: string,
) {
  return enqueueSyncUnit(outbox, {
    tenantId: ctx.tenantId,
    syncDeviceId,
    opId,
    entityType,
    entityId,
    operation: "create",
    payload: {
      snapshot,
      actorUserId: ctx.userId,
      actorRole: ctx.userRole,
      actorUserName: ctx.userName,
    },
  });
}

export async function enqueueReturnCreate(
  outbox: ISyncOutboxRepository,
  ret: { id: string; number: string; kind: string; partyId: string },
  createInput: CreateReturnInput,
  ctx: TenantContext,
  syncDeviceId: string | null,
  opId?: string,
  dependencies?: InvoiceSyncDependencies | null,
) {
  return enqueueSyncUnit(outbox, {
    tenantId: ctx.tenantId,
    syncDeviceId,
    opId,
    entityType: "return",
    entityId: ret.id,
    operation: "create",
    payload: {
      returnId: ret.id,
      returnNumber: ret.number,
      returnKind: ret.kind,
      partyId: ret.partyId,
      createInput,
      dependencies: dependencies ?? null,
      rollIds: createInput.lines.map((l) => l.rollId),
      preAllocated: true,
      actorUserId: ctx.userId,
      actorRole: ctx.userRole,
      actorUserName: ctx.userName,
    },
  });
}

export async function enqueueReturnCancel(
  outbox: ISyncOutboxRepository,
  ret: { id: string; number?: string },
  ctx: TenantContext,
  syncDeviceId: string | null,
  opId?: string,
  baseVersion?: number | null,
) {
  return enqueueSyncUnit(outbox, {
    tenantId: ctx.tenantId,
    syncDeviceId,
    opId,
    entityType: "return",
    entityId: ret.id,
    operation: "cancel",
    payload: {
      returnId: ret.id,
      returnNumber: ret.number ?? null,
      baseVersion: baseVersion ?? null,
      actorUserId: ctx.userId,
      actorRole: ctx.userRole,
      actorUserName: ctx.userName,
    },
  });
}

export async function enqueueOrderCreate(
  outbox: ISyncOutboxRepository,
  order: { id: string; code: string },
  createInput: CreateOrderInput,
  ctx: TenantContext,
  syncDeviceId: string | null,
  opId?: string,
  dependencies?: InvoiceSyncDependencies | null,
) {
  return enqueueSyncUnit(outbox, {
    tenantId: ctx.tenantId,
    syncDeviceId,
    opId,
    entityType: "order",
    entityId: order.id,
    operation: "create",
    payload: {
      orderId: order.id,
      orderCode: order.code,
      createInput,
      dependencies: dependencies ?? null,
      preAllocated: true,
      actorUserId: ctx.userId,
      actorRole: ctx.userRole,
      actorUserName: ctx.userName,
    },
  });
}

export async function enqueueOrderCancel(
  outbox: ISyncOutboxRepository,
  order: { id: string; code?: string },
  ctx: TenantContext,
  syncDeviceId: string | null,
  opId?: string,
  baseVersion?: number | null,
) {
  return enqueueSyncUnit(outbox, {
    tenantId: ctx.tenantId,
    syncDeviceId,
    opId,
    entityType: "order",
    entityId: order.id,
    operation: "cancel",
    payload: {
      orderId: order.id,
      orderCode: order.code ?? null,
      baseVersion: baseVersion ?? null,
      actorUserId: ctx.userId,
      actorRole: ctx.userRole,
      actorUserName: ctx.userName,
    },
  });
}

export async function enqueueExpenseCreate(
  outbox: ISyncOutboxRepository,
  expense: { id: string; number: string },
  createInput: CreateExpenseInput,
  ctx: TenantContext,
  syncDeviceId: string | null,
  opId?: string,
  dependencies?: InvoiceSyncDependencies | null,
) {
  return enqueueSyncUnit(outbox, {
    tenantId: ctx.tenantId,
    syncDeviceId,
    opId,
    entityType: "expense",
    entityId: expense.id,
    operation: "create",
    payload: {
      expenseId: expense.id,
      expenseNumber: expense.number,
      createInput,
      dependencies: dependencies ?? null,
      preAllocated: true,
      actorUserId: ctx.userId,
      actorRole: ctx.userRole,
      actorUserName: ctx.userName,
    },
  });
}

export async function enqueueExpenseCancel(
  outbox: ISyncOutboxRepository,
  expense: { id: string; number?: string },
  ctx: TenantContext,
  syncDeviceId: string | null,
  opId?: string,
  baseVersion?: number | null,
) {
  return enqueueSyncUnit(outbox, {
    tenantId: ctx.tenantId,
    syncDeviceId,
    opId,
    entityType: "expense",
    entityId: expense.id,
    operation: "cancel",
    payload: {
      expenseId: expense.id,
      expenseNumber: expense.number ?? null,
      baseVersion: baseVersion ?? null,
      actorUserId: ctx.userId,
      actorRole: ctx.userRole,
      actorUserName: ctx.userName,
    },
  });
}

export async function enqueueInvoiceUpdate(
  outbox: ISyncOutboxRepository,
  invoice: { id: string; number?: string; type?: string },
  updateInput: UpdateInvoiceInput,
  ctx: TenantContext,
  syncDeviceId: string | null,
  opId?: string,
  dependencies?: InvoiceSyncDependencies | null,
  /**
   * Pre-edit invoice `version` read in the same local transaction (P3b). The
   * hub compares it against its own row: a mismatch means another device
   * edited the document first, and blind replay would silently overwrite
   * their edit. NULL = legacy payload without a base (accepted, unchecked).
   */
  baseVersion?: number | null,
) {
  return enqueueSyncUnit(outbox, {
    tenantId: ctx.tenantId,
    syncDeviceId,
    opId,
    entityType: "invoice",
    entityId: invoice.id,
    operation: "update",
    payload: {
      invoiceId: invoice.id,
      invoiceNumber: invoice.number ?? null,
      invoiceType: invoice.type ?? null,
      updateInput,
      dependencies: dependencies ?? null,
      baseVersion: baseVersion ?? null,
      // Guarded: an update that omits `lines` used to throw a TypeError inside
      // the route's catch-all, which silently dropped the update from the
      // outbox — the document changed locally and never reached the hub.
      rollIds: (updateInput.lines ?? []).map((l) => l.rollId),
      actorUserId: ctx.userId,
      actorRole: ctx.userRole,
      actorUserName: ctx.userName,
    },
  });
}

/**
 * SYNC-13 — coverage completion enqueues.
 *
 * Each function mirrors the existing enqueue* pattern: a typed payload the hub
 * replays through the SAME domain use-case the device ran locally. Identity
 * claims (one winner per entity) serialize concurrent edits; stock-affecting
 * types reuse the roll pool.
 */
export async function enqueueMasterUpdate(
  outbox: ISyncOutboxRepository,
  entityType: "party" | "fabric" | "color" | "roll",
  entityId: string,
  updateInput: Record<string, unknown>,
  ctx: TenantContext,
  syncDeviceId: string | null,
  opId?: string,
  /**
   * Pre-edit base read in the same local transaction (P3b pattern for
   * masters). The hub refuses replays whose base no longer matches instead
   * of overwriting a newer edit. Kept OUT of updateInput — the local
   * use-case must never see sync metadata as a column write.
   */
  base?: { version?: number | null; updatedAt?: string | null },
) {
  return enqueueSyncUnit(outbox, {
    tenantId: ctx.tenantId,
    syncDeviceId,
    opId,
    entityType,
    entityId,
    operation: "update",
    payload: {
      entityId,
      updateInput,
      baseVersion: base?.version ?? null,
      baseUpdatedAt: base?.updatedAt ?? null,
      actorUserId: ctx.userId,
      actorRole: ctx.userRole,
      actorUserName: ctx.userName,
    },
  });
}

export async function enqueueMasterDelete(
  outbox: ISyncOutboxRepository,
  entityType: "party" | "fabric" | "color" | "roll",
  entityId: string,
  ctx: TenantContext,
  syncDeviceId: string | null,
  opId?: string,
  /**
   * Base read of the row in the same local transaction as the delete (4D).
   * The hub replays the delete only if the row still matches this base —
   * otherwise a delete issued offline against v2 would win over an edit
   * another device already applied at v3 (the same stale-replay hole the
   * document cancel path closed with `refuseStaleCancelBase`). Kept OUT of
   * any column write; it is pure sync metadata.
   */
  base?: { version?: number | null; updatedAt?: string | null },
) {
  return enqueueSyncUnit(outbox, {
    tenantId: ctx.tenantId,
    syncDeviceId,
    opId,
    entityType,
    entityId,
    operation: "delete",
    payload: {
      entityId,
      baseVersion: base?.version ?? null,
      baseUpdatedAt: base?.updatedAt ?? null,
      actorUserId: ctx.userId,
      actorRole: ctx.userRole,
      actorUserName: ctx.userName,
    },
  });
}

export async function enqueueOrderUpdate(
  outbox: ISyncOutboxRepository,
  order: { id: string; code?: string },
  updateInput: Record<string, unknown>,
  fulfillInvoiceId: string | null,
  ctx: TenantContext,
  syncDeviceId: string | null,
  opId?: string,
  base?: { version?: number | null },
) {
  return enqueueSyncUnit(outbox, {
    tenantId: ctx.tenantId,
    syncDeviceId,
    opId,
    entityType: "order",
    entityId: order.id,
    operation: "update",
    payload: {
      orderId: order.id,
      orderCode: order.code ?? null,
      updateInput,
      fulfillInvoiceId,
      baseVersion: base?.version ?? null,
      actorUserId: ctx.userId,
      actorRole: ctx.userRole,
      actorUserName: ctx.userName,
    },
  });
}

export async function enqueueLedgerCreate(
  outbox: ISyncOutboxRepository,
  entryIds: string[],
  entries: Array<Record<string, unknown>>,
  ctx: TenantContext,
  syncDeviceId: string | null,
  opId?: string,
) {
  return enqueueSyncUnit(outbox, {
    tenantId: ctx.tenantId,
    syncDeviceId,
    opId,
    entityType: "ledger",
    entityId: entryIds[0] ?? `batch-${Date.now()}`,
    operation: "create",
    payload: {
      entryIds,
      entries,
      actorUserId: ctx.userId,
      actorRole: ctx.userRole,
      actorUserName: ctx.userName,
    },
  });
}

export async function enqueueLedgerCancel(
  outbox: ISyncOutboxRepository,
  referenceType: string,
  referenceId: string,
  ctx: TenantContext,
  syncDeviceId: string | null,
  opId?: string,
) {
  return enqueueSyncUnit(outbox, {
    tenantId: ctx.tenantId,
    syncDeviceId,
    opId,
    entityType: "ledger",
    entityId: referenceId,
    operation: "cancel",
    payload: {
      referenceType,
      referenceId,
      actorUserId: ctx.userId,
      actorRole: ctx.userRole,
      actorUserName: ctx.userName,
    },
  });
}

export async function enqueueSettlement(
  outbox: ISyncOutboxRepository,
  party: { id: string; kind: string },
  input: Record<string, unknown>,
  settlementRef: { referenceType: string; referenceId: string } | null,
  ctx: TenantContext,
  syncDeviceId: string | null,
  opId?: string,
  /**
   * Frozen settlement legs captured right after the local settle (same tx).
   * The hub replays these EXACT rows id-keyed — it must NOT recompute from
   * its own balance, which may legitimately differ from the origin device's
   * balance at settle time (recompute would post different amounts per
   * device and fork the ledger).
   */
  frozenEntries?: Array<Record<string, unknown>>,
) {
  return enqueueSyncUnit(outbox, {
    tenantId: ctx.tenantId,
    syncDeviceId,
    opId,
    entityType: "settlement",
    entityId: party.id,
    operation: "create",
    payload: {
      partyId: party.id,
      partyKind: party.kind,
      settleInput: input,
      settlementRef,
      frozenEntries: frozenEntries ?? null,
      actorUserId: ctx.userId,
      actorRole: ctx.userRole,
      actorUserName: ctx.userName,
    },
  });
}

export async function enqueueCashboxOpening(
  outbox: ISyncOutboxRepository,
  input: Record<string, unknown>,
  ctx: TenantContext,
  syncDeviceId: string | null,
  opId?: string,
) {
  return enqueueSyncUnit(outbox, {
    tenantId: ctx.tenantId,
    syncDeviceId,
    opId,
    entityType: "cashbox",
    entityId: ctx.tenantId,
    operation: "opening",
    payload: {
      openingInput: input,
      actorUserId: ctx.userId,
      actorRole: ctx.userRole,
      actorUserName: ctx.userName,
    },
  });
}

export async function enqueueCashboxMovement(
  outbox: ISyncOutboxRepository,
  movement: { id: string },
  input: Record<string, unknown>,
  ctx: TenantContext,
  syncDeviceId: string | null,
  opId?: string,
) {
  return enqueueSyncUnit(outbox, {
    tenantId: ctx.tenantId,
    syncDeviceId,
    opId,
    entityType: "cashbox",
    entityId: movement.id,
    operation: "movement",
    payload: {
      movementId: movement.id,
      movementInput: input,
      actorUserId: ctx.userId,
      actorRole: ctx.userRole,
      actorUserName: ctx.userName,
    },
  });
}

export async function enqueueCashboxMovementCancel(
  outbox: ISyncOutboxRepository,
  movementId: string,
  ctx: TenantContext,
  syncDeviceId: string | null,
  opId?: string,
) {
  return enqueueSyncUnit(outbox, {
    tenantId: ctx.tenantId,
    syncDeviceId,
    opId,
    entityType: "cashbox",
    entityId: movementId,
    operation: "movement-cancel",
    payload: {
      movementId,
      actorUserId: ctx.userId,
      actorRole: ctx.userRole,
      actorUserName: ctx.userName,
    },
  });
}

export async function enqueueCashboxClose(
  outbox: ISyncOutboxRepository,
  date: string,
  input: Record<string, unknown>,
  ctx: TenantContext,
  syncDeviceId: string | null,
  opId?: string,
) {
  return enqueueSyncUnit(outbox, {
    tenantId: ctx.tenantId,
    syncDeviceId,
    opId,
    entityType: "cashbox",
    // entity_id is UUID-typed: a stable synthetic UUID for the date. The
    // human-readable date stays in payload.closeDate.
    entityId: uuidFromString(`cashbox-close:${date}`),
    operation: "close",
    payload: {
      closeDate: date,
      closeInput: input,
      actorUserId: ctx.userId,
      actorRole: ctx.userRole,
      actorUserName: ctx.userName,
    },
  });
}

export async function enqueueSettingsUpdate(
  outbox: ISyncOutboxRepository,
  section: string,
  data: Record<string, unknown>,
  updatedAt: string,
  ctx: TenantContext,
  syncDeviceId: string | null,
  opId?: string,
) {
  return enqueueSyncUnit(outbox, {
    tenantId: ctx.tenantId,
    syncDeviceId,
    opId,
    entityType: "settings",
    // entity_id is UUID-typed: a stable synthetic UUID for the section. The
    // human-readable section stays in payload.section.
    entityId: uuidFromString(`settings:${section}`),
    operation: "update",
    payload: {
      section,
      settingsData: data,
      updatedAt,
      actorUserId: ctx.userId,
      actorRole: ctx.userRole,
      actorUserName: ctx.userName,
    },
  });
}

export async function enqueueUserMutation(
  outbox: ISyncOutboxRepository,
  snapshot: {
    id: string;
    tenantId: string;
    name: string;
    email: string;
    role: string;
    active: boolean;
    passwordHash: string;
    pinHash: string | null;
    updatedAt: string;
  },
  operation: "create" | "update" | "deactivate" | "set-pin",
  ctx: TenantContext,
  syncDeviceId: string | null,
  opId?: string,
) {
  return enqueueSyncUnit(outbox, {
    tenantId: ctx.tenantId,
    syncDeviceId,
    opId,
    entityType: "user",
    entityId: snapshot.id,
    operation,
    payload: {
      snapshot,
      actorUserId: ctx.userId,
      actorRole: ctx.userRole,
      actorUserName: ctx.userName,
    },
  });
}

export async function enqueueCompanyUpdate(
  outbox: ISyncOutboxRepository,
  data: Record<string, unknown>,
  updatedAt: string,
  ctx: TenantContext,
  syncDeviceId: string | null,
  opId?: string,
) {
  return enqueueSyncUnit(outbox, {
    tenantId: ctx.tenantId,
    syncDeviceId,
    opId,
    entityType: "company",
    entityId: ctx.tenantId,
    operation: "update",
    payload: {
      companyData: data,
      updatedAt,
      actorUserId: ctx.userId,
      actorRole: ctx.userRole,
      actorUserName: ctx.userName,
    },
  });
}
