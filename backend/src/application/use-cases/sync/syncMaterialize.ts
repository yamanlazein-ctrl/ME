import { pool } from "../../../infrastructure/orm/drizzle.js";
import type { DB } from "../../../infrastructure/orm/drizzle.js";
import { logger } from "../../../infrastructure/config/logger.js";
import { recordSyncConflict } from "./syncConflicts.js";
import type { IInvoiceRepository } from "../../ports/IInvoiceRepository.js";
import type { IVoucherRepository } from "../../ports/IVoucherRepository.js";
import type { IReturnRepository } from "../../ports/IReturnRepository.js";
import type { IOrderRepository } from "../../ports/IOrderRepository.js";
import type { IExpenseRepository } from "../../ports/IExpenseRepository.js";
import type { IAuditRepository } from "../../ports/IAuditRepository.js";
import type { IPartyRepository } from "../../ports/IPartyRepository.js";
import type { IFabricRepository } from "../../ports/IFabricRepository.js";
import type { IColorRepository } from "../../ports/IColorRepository.js";
import type { IRollRepository } from "../../ports/IRollRepository.js";
import type { ILedgerRepository } from "../../ports/ILedgerRepository.js";
import type { IStatementRepository } from "../../ports/IStatementRepository.js";
import type { ICashboxRepository } from "../../ports/ICashboxRepository.js";
import type { ISettingsRepository } from "../../ports/ISettingsRepository.js";
import type { ICompanyRepository } from "../../ports/ICompanyRepository.js";
import type { TenantContext } from "../../../domain/types/index.js";
import type {
  CreateInvoiceInput,
  InvoiceData,
  UpdateInvoiceInput,
} from "../../../domain/entities/Invoice.js";
import type { CreateVoucherInput } from "../../../domain/entities/Voucher.js";
import type { CreateReturnInput } from "../../../domain/entities/Return.js";
import type { CreateOrderInput } from "../../../domain/entities/Order.js";
import type { CreateExpenseInput } from "../../../domain/entities/Expense.js";
import {
  cancelInvoiceUseCase,
  createInvoiceUseCase,
  updateInvoiceUseCase,
} from "../invoices/invoiceUseCases.js";
import { updatePartyUseCase, cancelPartyUseCase } from "../parties/partyUseCases.js";
import { updateFabricUseCase, deleteFabricUseCase } from "../inventory/fabricUseCases.js";
import { updateColorUseCase, deleteColorUseCase } from "../inventory/colorUseCases.js";
import { updateRollUseCase, deleteRollUseCase } from "../inventory/rollUseCases.js";
import { updateOrderUseCase, fulfillOrderUseCase } from "../orders/orderUseCases.js";
import { writeLedgerUseCase, cancelLedgerByReferenceUseCase } from "../ledger/ledgerUseCases.js";
import {
  setOpeningBalanceUseCase,
  addManualMovementUseCase,
  deleteManualMovementUseCase,
  closeDayUseCase,
} from "../cashbox/cashboxUseCases.js";
import { updateSettingsUseCase } from "../settings/settingsUseCases.js";
import { cancelVoucherUseCase, createVoucherUseCase } from "../vouchers/voucherUseCases.js";
import { cancelReturnUseCase, createReturnUseCase } from "../returns/returnUseCases.js";
import { cancelOrderUseCase, createOrderUseCase } from "../orders/orderUseCases.js";
import { cancelExpenseUseCase, createExpenseUseCase } from "../expenses/expenseUseCases.js";
import {
  ensureInvoiceSyncDependencies,
  parseDependenciesPayload,
  type InvoiceSyncDependencies,
  type SyncPartySnapshot,
  type SyncFabricSnapshot,
  type SyncColorSnapshot,
  type SyncRollSnapshot,
} from "./syncDependencySnapshots.js";

export type SyncMaterializeRepos = {
  invoiceRepo: IInvoiceRepository;
  voucherRepo: IVoucherRepository;
  returnRepo: IReturnRepository;
  orderRepo: IOrderRepository;
  expenseRepo: IExpenseRepository;
  auditRepo: IAuditRepository;
  // SYNC-13 coverage completion: masters, ledger, settlement, cashbox,
  // settings/company replay through the same domain use-cases.
  partyRepo: IPartyRepository;
  fabricRepo: IFabricRepository;
  colorRepo: IColorRepository;
  rollRepo: IRollRepository;
  ledgerRepo: ILedgerRepository;
  statementRepo: IStatementRepository;
  cashboxRepo: ICashboxRepository;
  settingsRepo: ISettingsRepository;
  companyRepo: ICompanyRepository;
};

export type MaterializeResult = {
  /**
   * created | exists  — applied (idempotent: `exists` means a previous run
   *                     already produced this entity).
   * failed            — RETRYABLE. A dependency has not arrived yet (typically
   *                     an update/cancel whose create is still queued), so the
   *                     unit must be retried rather than discarded.
   * invalid           — PERMANENT. The payload is malformed or the
   *                     entity/operation is not supported. Retrying can never
   *                     help, so it is parked for an operator instead of being
   *                     silently marked as applied.
   */
  status: "created" | "exists" | "failed" | "invalid";
  error?: string;
};

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

/**
 * Replay identity for use-case re-execution on the hub (or a pulling peer).
 *
 * P6 (SYNC-06): this is ALWAYS the authenticated receiver — never the
 * wire-supplied actor. The payload's `actorUserId`/`actorRole` describe a user
 * on the ORIGINATING device. User roster hashes now sync, but replay still
 * uses the authenticated receiver so `created_by` is FK-safe and a forged
 * actorRole cannot escalate. Origin provenance lives in the inbox row.
 *
 * Concretely: userId/userRole/userName all come from `ctx`. Besides closing
 * the escalation, this is FK-safe (`created_by`/`cancelled_by` always
 * reference a user that exists on THIS node).
 */
function replayCtxFromPayload(payload: Record<string, unknown>, ctx: TenantContext): TenantContext {
  void payload;
  return {
    ...ctx,
    userId: ctx.userId,
    userName: ctx.userName,
    userRole: ctx.userRole,
    syncDeviceId: null,
  };
}

/**
 * Mutation provenance for tombstone recording. The origin device/op come from
 * the INBOX row (the authenticated receiver's durable record), never from the
 * wire payload — a payload-supplied device id is not authority (P6/SYNC-06).
 */
export type SyncMaterializeMeta = {
  opId?: string;
  syncDeviceId?: string | null;
  /** Pull of a unit the hub already applied — rebase local state to hub truth. */
  hubCanonical?: boolean;
};

/**
 * Tombstone enforcement (plan §10 / 0058_sync_tombstones.sql).
 *
 * `sync_tombstones` records master rows (fabric/color/roll, and party for
 * consistency) whose DELETE has materialized. Nothing may silently bring such
 * a row back: a STALE offline create replay, or an invoice/return whose
 * dependency snapshot names a deleted fabric, would otherwise resurrect it on
 * the hub after a long offline window — the exact "resurrected deleted data"
 * convergence failure the sync design forbids.
 *
 * Deliberately NOT a naive "a create clears the tombstone" rule: a tombstone
 * is never removed by a replay. A legitimate intentional re-creation is a NEW
 * row with a new lifecycle; it reaches the hub through the regular create
 * path and must be reconciled explicitly (visible + operator-flagged) rather
 * than silently judged. Blocked recreations surface as retryable `failed`
 * units that become `dead` (visible in /sync/inbox) after the attempt budget —
 * never a silent `created` that reports a row that was not written.
 */
async function tombstoneExists(
  tenantId: string,
  entityType: string,
  entityId: string,
): Promise<boolean> {
  try {
    const r = await pool.query(
      `SELECT 1 FROM sync_tombstones
        WHERE tenant_id = $1 AND entity_type = $2 AND entity_id = $3
        LIMIT 1`,
      [tenantId, entityType, entityId],
    );
    return (r.rowCount ?? 0) > 0;
  } catch (err) {
    // Fail closed: a lookup error must not allow recreating a deleted master.
    logger.error({ err, entityType, entityId }, "sync tombstone lookup failed — blocking recreate");
    throw err;
  }
}

/**
 * Insert a tombstone for a materialized master DELETE. Idempotent on the
 * (tenant, entity_type, entity_id) unique index; a replayed delete of an
 * already-tombstoned row is a no-op. `deletion_seq` is a per-tenant monotonic
 * counter used for causal ordering provenance (not a documented guarantee —
 * collisions across concurrent writers are harmless because the seq is never
 * used as a key).
 */
async function recordTombstone(
  tenantId: string,
  entityType: string,
  entityId: string,
  opId: string | null,
  deletedByDeviceId: string | null,
): Promise<void> {
  await pool.query(
    `INSERT INTO sync_tombstones
        (id, tenant_id, entity_type, entity_id, op_id, deleted_by_device_id, deletion_seq)
      SELECT gen_random_uuid(), $1, $2, $3, $4, $5, COALESCE(MAX(deletion_seq), 0) + 1
        FROM sync_tombstones
       WHERE tenant_id = $1
     ON CONFLICT (tenant_id, entity_type, entity_id) DO NOTHING`,
    [tenantId, entityType, entityId, opId ?? "", deletedByDeviceId],
  );
}

/**
 * Record a stale-base optimistic-concurrency conflict (plan §4/§11). A unit
 * whose base version is older than the hub row is a genuine concurrent-edit
 * loss — not a transient dependency — so it enters the conflict ledger with
 * both versions and the loser's full local intent. Idempotent per op_id; the
 * apply path resolves it if the unit later converges. Requires the op's
 * provenance (meta.opId) from the inbox row.
 */
async function recordStaleConflict(
  meta: SyncMaterializeMeta | undefined,
  payload: Record<string, unknown>,
  entityType: string,
  entityId: string,
  operation: "update" | "cancel",
  baseVersion: number | null,
  serverVersion: number | null,
  tenantId: string,
): Promise<void> {
  if (!meta?.opId) return;
  await recordSyncConflict({
    tenantId,
    opId: meta.opId,
    entityType,
    entityId,
    operation,
    baseVersion,
    serverVersion,
    localIntent: payload,
  });
}

async function ensureDeps(
  database: DB,
  payload: Record<string, unknown>,
  ctx: TenantContext,
): Promise<MaterializeResult | null> {
  const deps = parseDependenciesPayload(payload);
  if (!deps) return null;
  try {
    await ensureInvoiceSyncDependencies(database, deps, ctx);
    return null;
  } catch (err) {
    return {
      status: "failed",
      error: err instanceof Error ? err.message : "فشل تجهيز البيانات المرتبطة",
    };
  }
}

export async function materializeSyncUnit(
  database: DB,
  repos: SyncMaterializeRepos,
  unit: {
    entityType: string;
    operation: string;
    payload: Record<string, unknown>;
  },
  ctx: TenantContext,
  meta?: SyncMaterializeMeta,
): Promise<MaterializeResult> {
  const { entityType, operation, payload } = unit;

  if (entityType === "invoice" && operation === "create") {
    return materializeInvoiceCreate(database, repos, payload, ctx);
  }
  if (entityType === "invoice" && operation === "update") {
    return materializeInvoiceUpdate(database, repos, payload, ctx, meta);
  }
  if (entityType === "invoice" && operation === "cancel") {
    return materializeInvoiceCancel(repos, payload, ctx, meta);
  }
  if (entityType === "voucher" && operation === "create") {
    return materializeVoucherCreate(database, repos, payload, ctx);
  }
  if (entityType === "voucher" && operation === "cancel") {
    return materializeVoucherCancel(repos, payload, ctx, meta);
  }
  if (entityType === "return" && operation === "create") {
    return materializeReturnCreate(database, repos, payload, ctx);
  }
  if (entityType === "return" && operation === "cancel") {
    return materializeReturnCancel(repos, payload, ctx, meta);
  }
  if (entityType === "order" && operation === "create") {
    return materializeOrderCreate(database, repos, payload, ctx);
  }
  if (entityType === "order" && operation === "cancel") {
    return materializeOrderCancel(repos, payload, ctx, meta);
  }
  if (entityType === "expense" && operation === "create") {
    return materializeExpenseCreate(database, repos, payload, ctx);
  }
  if (entityType === "expense" && operation === "cancel") {
    return materializeExpenseCancel(repos, payload, ctx, meta);
  }
  if (
    (entityType === "party" ||
      entityType === "fabric" ||
      entityType === "color" ||
      entityType === "roll") &&
    operation === "create"
  ) {
    return materializeMasterCreate(database, entityType, payload, ctx);
  }
  // SYNC-13 coverage completion: master updates/deletes, order updates,
  // direct ledger writes, settlements, cashbox, settings/company snapshots.
  if (
    (entityType === "party" ||
      entityType === "fabric" ||
      entityType === "color" ||
      entityType === "roll") &&
    (operation === "update" || operation === "delete")
  ) {
    return materializeMasterMutation(database, repos, entityType, operation, payload, ctx, meta);
  }
  if (entityType === "order" && operation === "update") {
    return materializeOrderUpdate(repos, payload, ctx, meta);
  }
  if (entityType === "ledger" && operation === "create") {
    return materializeLedgerCreate(repos, payload, ctx);
  }
  if (entityType === "ledger" && operation === "cancel") {
    return materializeLedgerCancel(repos, payload, ctx);
  }
  if (entityType === "settlement" && operation === "create") {
    return materializeSettlement(repos, payload, ctx);
  }
  if (entityType === "cashbox") {
    return materializeCashbox(repos, operation, payload, ctx);
  }
  if ((entityType === "settings" || entityType === "company") && operation === "update") {
    return materializeAdminSnapshot(repos, entityType, payload, ctx);
  }
  if (entityType === "user" && operation === "create") {
    return materializeUser(payload, ctx);
  }
  if (entityType === "user" && operation === "update") {
    return materializeUser(payload, ctx);
  }
  if (entityType === "user" && operation === "deactivate") {
    return materializeUser(payload, ctx);
  }
  if (entityType === "user" && operation === "set-pin") {
    return materializeUser(payload, ctx);
  }
  return { status: "invalid", error: `unsupported sync unit ${entityType}/${operation}` };
}

/**
 * Stale-base guard shared by every document CANCEL replay (invoice, voucher,
 * return, order, expense).
 *
 * Cancels used to be replayed blindly: the origin device stamped no base
 * version, so the hub fell back to `existing.version` and voided whatever row
 * it held. A cancel issued offline against v2 therefore silently voided v3 —
 * a financial edit another device had already applied.
 *
 * Units without `baseVersion` are refused (visible conflict) — never applied
 * as last-write-wins against whatever the hub currently holds.
 */
async function refuseStaleCancelBase(
  meta: SyncMaterializeMeta | undefined,
  payload: Record<string, unknown>,
  entityType: string,
  entityId: string,
  serverVersion: number | null,
  tenantId: string,
  documentLabel: string,
): Promise<MaterializeResult | null> {
  if (meta?.hubCanonical) return null;
  const baseVersion =
    typeof payload.baseVersion === "number" && Number.isFinite(payload.baseVersion)
      ? payload.baseVersion
      : null;
  if (baseVersion === null) {
    await recordStaleConflict(
      meta,
      payload,
      entityType,
      entityId,
      "cancel",
      null,
      serverVersion,
      tenantId,
    );
    return {
      status: "failed",
      error:
        `تعارض إلغاء ${documentLabel}: الوحدة بلا رقم إصدار أساسي` +
        (serverVersion !== null ? ` والمركز على v${serverVersion}` : "") +
        ` — راجع النسخة الفائزة ثم أعد الإلغاء إن بقي صحيحاً.`,
    };
  }
  if (serverVersion === null || serverVersion === baseVersion) return null;
  await recordStaleConflict(
    meta,
    payload,
    entityType,
    entityId,
    "cancel",
    baseVersion,
    serverVersion,
    tenantId,
  );
  return {
    status: "failed",
    error:
      `تعارض إلغاء ${documentLabel}: القاعدة v${baseVersion} والمركز v${serverVersion} — ` +
      `عُدِّل المستند على جهاز آخر بعد نسختك. راجع النسخة الفائزة ثم أعد الإلغاء إن بقي صحيحاً.`,
  };
}

async function materializeInvoiceCreate(
  database: DB,
  repos: SyncMaterializeRepos,
  payload: Record<string, unknown>,
  ctx: TenantContext,
): Promise<MaterializeResult> {
  const invoiceId =
    typeof payload.invoiceId === "string" && isUuid(payload.invoiceId) ? payload.invoiceId : null;
  const invoiceNumber = typeof payload.invoiceNumber === "string" ? payload.invoiceNumber : null;
  const invoiceType = typeof payload.invoiceType === "string" ? payload.invoiceType : null;

  if (invoiceId) {
    const existing = await repos.invoiceRepo.findById(invoiceId, ctx);
    if (existing) return { status: "exists" };
  }
  if (invoiceNumber && invoiceType) {
    const byNumber = await repos.invoiceRepo.findByNumber(invoiceNumber, invoiceType, ctx);
    if (byNumber) return { status: "exists" };
  }

  const createInput = payload.createInput;
  if (!createInput || typeof createInput !== "object") {
    return { status: "invalid", error: "missing createInput in sync payload" };
  }
  // A create replay must carry measurable line data. Never materialize a
  // malformed/partial payload as a zero-line invoice: that would make the hub
  // appear successful while losing stock and financial effects.
  const inputLines = (createInput as { lines?: unknown }).lines;
  if (!Array.isArray(inputLines) || inputLines.length === 0) {
    return { status: "invalid", error: "sync invoice create has no invoice lines" };
  }
  for (const line of inputLines) {
    if (!line || typeof line !== "object") {
      return { status: "invalid", error: "sync invoice line is malformed" };
    }
    const quantityKg = Number((line as { quantityKg?: unknown }).quantityKg);
    if (!Number.isFinite(quantityKg) || quantityKg <= 0) {
      return { status: "invalid", error: "sync invoice line quantity must be positive" };
    }
  }

  const depErr = await ensureDeps(database, payload, ctx);
  if (depErr) return depErr;

  const created = await createInvoiceUseCase(
    repos.invoiceRepo,
    repos.auditRepo,
    {
      ...(createInput as CreateInvoiceInput),
      preAllocatedNumber: invoiceNumber ?? undefined,
      preAllocatedId: invoiceId ?? undefined,
    },
    replayCtxFromPayload(payload, ctx),
  );
  if (!created.ok) return { status: "failed", error: created.error };
  return { status: "created" };
}

/**
 * Field-level diff between an update intent and the hub row (P3b).
 *
 * Serves two decisions in materializeInvoiceUpdate: an EMPTY diff means the
 * hub already reflects this exact edit (duplicate delivery → `exists`), while
 * a non-empty diff on a stale base names precisely what the operator must
 * rebase (retryable `failed`, never a silent overwrite). Lines compare as
 * normalized projections — hub rows carry ids/audit fields the intent lacks,
 * so raw JSON comparison would never converge.
 */
export function diffUpdateInput(update: UpdateInvoiceInput, hub: InvoiceData): string[] {
  const differing: string[] = [];
  if (update.date !== hub.date) differing.push("date");
  const project = (ls: Array<Record<string, unknown>> | undefined) =>
    (ls ?? [])
      .map((l) => ({
        fabricId: l.fabricId,
        colorId: l.colorId,
        rollId: l.rollId,
        quantityKg: Number(l.quantityKg),
        pieces: Number(l.pieces ?? 1),
        pricePerKg: Number(l.pricePerKg),
        discountAmount: Number(l.discountAmount ?? 0),
        note: (l.note as string | undefined) ?? null,
      }))
      .sort((a, b) => String(a.rollId).localeCompare(String(b.rollId)));
  if (
    JSON.stringify(project(update.lines as unknown as Array<Record<string, unknown>>)) !==
    JSON.stringify(project(hub.lines as unknown as Array<Record<string, unknown>>))
  ) {
    differing.push("lines");
  }
  for (const key of ["discount", "tax", "shipping"] as const) {
    if (update[key] !== undefined && Number(update[key]) !== Number(hub[key])) {
      differing.push(key);
    }
  }
  if (update.notes !== undefined && (update.notes ?? null) !== (hub.notes ?? null)) {
    differing.push("notes");
  }
  if (
    update.exchangeRate !== undefined &&
    update.exchangeRate !== null &&
    Number(update.exchangeRate) !== Number(hub.exchangeRate)
  ) {
    differing.push("exchangeRate");
  }
  return differing;
}

async function materializeInvoiceUpdate(
  database: DB,
  repos: SyncMaterializeRepos,
  payload: Record<string, unknown>,
  ctx: TenantContext,
  meta?: SyncMaterializeMeta,
): Promise<MaterializeResult> {
  const invoiceId =
    typeof payload.invoiceId === "string" && isUuid(payload.invoiceId) ? payload.invoiceId : null;
  if (!invoiceId) return { status: "invalid", error: "missing invoiceId" };

  const existing = await repos.invoiceRepo.findById(invoiceId, ctx);
  if (!existing) return { status: "failed", error: "الفاتورة غير موجودة للتعديل" };
  if (existing.status === "cancelled") {
    return { status: "failed", error: "لا يمكن تعديل فاتورة ملغاة" };
  }

  const updateInput = payload.updateInput;
  if (!updateInput || typeof updateInput !== "object") {
    return { status: "invalid", error: "missing updateInput" };
  }

  // P3b: idempotent duplicate delivery converges first — a unit whose edit is
  // already fully reflected in the hub row is `exists`, not a conflict.
  const differing = diffUpdateInput(updateInput as UpdateInvoiceInput, existing);
  if (differing.length === 0) return { status: "exists" };

  // P3b: stale-base rejection. The unit carries the pre-edit version its
  // device saw; a hub row on a newer version means another device edited
  // first, and replay would silently overwrite their edit. Retryable `failed`
  // (never `invalid`/dead on first sight) with the exact field list so the
  // operator can rebase.
  // Legacy payloads without baseVersion must NOT fall through to
  // expectedVersion=existing.version (that was a silent overwrite).
  const baseVersion =
    typeof payload.baseVersion === "number" && Number.isFinite(payload.baseVersion)
      ? payload.baseVersion
      : null;
  if (baseVersion === null && !meta?.hubCanonical) {
    await recordStaleConflict(
      meta,
      payload,
      "invoice",
      invoiceId,
      "update",
      null,
      existing.version,
      ctx.tenantId,
    );
    return {
      status: "failed",
      error:
        `تعارض تعديل: الوحدة بلا رقم إصدار أساسي والمركز على v${existing.version} — ` +
        `راجع وأعد الإدخال. الحقول المختلفة: ${differing.join(",")}`,
    };
  }
  if (baseVersion !== null && existing.version !== baseVersion && !meta?.hubCanonical) {
    await recordStaleConflict(
      meta,
      payload,
      "invoice",
      invoiceId,
      "update",
      baseVersion,
      existing.version,
      ctx.tenantId,
    );
    return {
      status: "failed",
      error:
        `تعارض تعديل: القاعدة v${baseVersion} والمركز v${existing.version} — ` +
        `راجع وأعد الإدخال. الحقول المختلفة: ${differing.join(",")}`,
    };
  }

  const depErr = await ensureDeps(database, payload, ctx);
  if (depErr) return depErr;

  const expectedVersion = meta?.hubCanonical ? existing.version : (baseVersion as number);

  const updated = await updateInvoiceUseCase(
    repos.invoiceRepo,
    repos.auditRepo,
    invoiceId,
    updateInput as UpdateInvoiceInput,
    replayCtxFromPayload(payload, ctx),
    expectedVersion,
  );
  if (!updated.ok) return { status: "failed", error: updated.error };
  return { status: "created" };
}

async function materializeInvoiceCancel(
  repos: SyncMaterializeRepos,
  payload: Record<string, unknown>,
  ctx: TenantContext,
  meta?: SyncMaterializeMeta,
): Promise<MaterializeResult> {
  const invoiceId =
    typeof payload.invoiceId === "string" && isUuid(payload.invoiceId) ? payload.invoiceId : null;
  if (!invoiceId) return { status: "invalid", error: "missing invoiceId" };

  const existing = await repos.invoiceRepo.findById(invoiceId, ctx);
  if (!existing) return { status: "failed", error: "الفاتورة غير موجودة للإلغاء" };
  if (existing.status === "cancelled") return { status: "exists" };

  const stale = await refuseStaleCancelBase(
    meta,
    payload,
    "invoice",
    invoiceId,
    existing.version,
    ctx.tenantId,
    "الفاتورة",
  );
  if (stale) return stale;

  // P0-001: expectedVersion is REQUIRED - refuseStaleCancelBase already rejected
  // missing baseVersion; hubCanonical may still omit it and use hub version.
  const expectedVersion =
    typeof payload.baseVersion === "number" ? payload.baseVersion : existing.version;

  const replay = replayCtxFromPayload(payload, ctx);
  const result = await cancelInvoiceUseCase(
    repos.invoiceRepo,
    repos.auditRepo,
    invoiceId,
    replay.userId,
    replay,
    expectedVersion,
  );
  if (!result.ok) return { status: "failed", error: result.error };
  return { status: "created" };
}

async function materializeVoucherCreate(
  database: DB,
  repos: SyncMaterializeRepos,
  payload: Record<string, unknown>,
  ctx: TenantContext,
): Promise<MaterializeResult> {
  const voucherId =
    typeof payload.voucherId === "string" && isUuid(payload.voucherId) ? payload.voucherId : null;
  const voucherNumber = typeof payload.voucherNumber === "string" ? payload.voucherNumber : null;

  if (voucherId) {
    const existing = await repos.voucherRepo.findById(voucherId, ctx);
    if (existing) return { status: "exists" };
  }

  const createInput = payload.createInput;
  if (!createInput || typeof createInput !== "object") {
    return { status: "invalid", error: "missing createInput in voucher payload" };
  }

  const depErr = await ensureDeps(database, payload, ctx);
  if (depErr) return depErr;

  const created = await createVoucherUseCase(
    repos.voucherRepo,
    repos.auditRepo,
    {
      ...(createInput as CreateVoucherInput),
      preAllocatedNumber: voucherNumber ?? undefined,
      preAllocatedId: voucherId ?? undefined,
    },
    replayCtxFromPayload(payload, ctx),
  );
  if (!created.ok) return { status: "failed", error: created.error };
  return { status: "created" };
}

async function materializeVoucherCancel(
  repos: SyncMaterializeRepos,
  payload: Record<string, unknown>,
  ctx: TenantContext,
  meta?: SyncMaterializeMeta,
): Promise<MaterializeResult> {
  const voucherId =
    typeof payload.voucherId === "string" && isUuid(payload.voucherId) ? payload.voucherId : null;
  if (!voucherId) return { status: "invalid", error: "missing voucherId" };

  const existing = await repos.voucherRepo.findById(voucherId, ctx);
  if (!existing) return { status: "failed", error: "السند غير موجود للإلغاء" };
  if (existing.status === "cancelled") return { status: "exists" };

  const stale = await refuseStaleCancelBase(
    meta,
    payload,
    "voucher",
    voucherId,
    existing.version,
    ctx.tenantId,
    "السند",
  );
  if (stale) return stale;

  // P0-001: expectedVersion is REQUIRED - refuseStaleCancelBase already rejected
  // missing baseVersion; hubCanonical may still omit it and use hub version.
  const expectedVersion =
    typeof payload.baseVersion === "number" ? payload.baseVersion : existing.version;

  const replay = replayCtxFromPayload(payload, ctx);
  const result = await cancelVoucherUseCase(
    repos.voucherRepo,
    repos.auditRepo,
    voucherId,
    replay.userId,
    replay,
    expectedVersion,
  );
  if (!result.ok) return { status: "failed", error: result.error };
  return { status: "created" };
}

async function materializeReturnCreate(
  database: DB,
  repos: SyncMaterializeRepos,
  payload: Record<string, unknown>,
  ctx: TenantContext,
): Promise<MaterializeResult> {
  const returnId =
    typeof payload.returnId === "string" && isUuid(payload.returnId) ? payload.returnId : null;
  if (returnId) {
    const existing = await repos.returnRepo.findById(returnId, ctx);
    if (existing) return { status: "exists" };
  }

  const createInput = payload.createInput;
  if (!createInput || typeof createInput !== "object") {
    return { status: "invalid", error: "missing createInput in return payload" };
  }

  // Linked returns must WAIT for the original invoice before any dependency
  // work. The return's dependency snapshot reconstructs PRE-return roll stock
  // (= post-sale values) — if this replay runs before the invoice unit has
  // applied, ensureDeps commits that snapshot as a fresh roll row and the
  // subsequent createReturnUseCase fails on the original_invoice_id FK,
  // rolling back its own transaction but NOT the dep insert (separate
  // transaction in ensureInvoiceSyncDependencies). The orphaned roll then
  // becomes the base for the invoice's sale replay — the hub permanently
  // forks its stock (reproduced live by verify-offline-runtime-drill.mjs:
  // hub roll 29kg vs 41kg on both devices, sale movement balanceAfter=26
  // from a 38kg base). Retryable `failed`: the unit stays `received` until
  // the invoice lands, then applies against the correct base.
  const originalInvoiceId =
    typeof (createInput as Record<string, unknown>).originalInvoiceId === "string"
      ? ((createInput as Record<string, unknown>).originalInvoiceId as string)
      : null;
  if (originalInvoiceId && isUuid(originalInvoiceId)) {
    const original = await repos.invoiceRepo.findById(originalInvoiceId, ctx);
    if (!original) {
      return {
        status: "failed",
        error: "الفاتورة الأصلية لم تُطبَّق بعد — سيُعاد تطبيق المرتجع بعد وصولها",
      };
    }
  }

  const depErr = await ensureDeps(database, payload, ctx);
  if (depErr) return depErr;

  const returnNumber = typeof payload.returnNumber === "string" ? payload.returnNumber : null;

  const created = await createReturnUseCase(
    repos.returnRepo,
    repos.auditRepo,
    {
      ...(createInput as CreateReturnInput),
      preAllocatedNumber: returnNumber ?? undefined,
      preAllocatedId: returnId ?? undefined,
    },
    replayCtxFromPayload(payload, ctx),
  );
  if (!created.ok) return { status: "failed", error: created.error };
  return { status: "created" };
}

async function materializeReturnCancel(
  repos: SyncMaterializeRepos,
  payload: Record<string, unknown>,
  ctx: TenantContext,
  meta?: SyncMaterializeMeta,
): Promise<MaterializeResult> {
  const returnId =
    typeof payload.returnId === "string" && isUuid(payload.returnId) ? payload.returnId : null;
  if (!returnId) return { status: "invalid", error: "missing returnId" };

  const existing = await repos.returnRepo.findById(returnId, ctx);
  if (!existing) return { status: "failed", error: "المرتجع غير موجود للإلغاء" };
  if (existing.status === "cancelled") return { status: "exists" };

  const stale = await refuseStaleCancelBase(
    meta,
    payload,
    "return",
    returnId,
    existing.version,
    ctx.tenantId,
    "المرتجع",
  );
  if (stale) return stale;

  // P0-001: expectedVersion is REQUIRED - refuseStaleCancelBase already rejected
  // missing baseVersion; hubCanonical may still omit it and use hub version.
  const expectedVersion =
    typeof payload.baseVersion === "number" ? payload.baseVersion : existing.version;

  const replay = replayCtxFromPayload(payload, ctx);
  const result = await cancelReturnUseCase(
    repos.returnRepo,
    repos.auditRepo,
    returnId,
    replay.userId,
    replay,
    expectedVersion,
  );
  if (!result.ok) return { status: "failed", error: result.error };
  return { status: "created" };
}

async function materializeOrderCreate(
  database: DB,
  repos: SyncMaterializeRepos,
  payload: Record<string, unknown>,
  ctx: TenantContext,
): Promise<MaterializeResult> {
  const orderId =
    typeof payload.orderId === "string" && isUuid(payload.orderId) ? payload.orderId : null;
  const orderCode = typeof payload.orderCode === "string" ? payload.orderCode : null;

  if (orderId) {
    const existing = await repos.orderRepo.findById(orderId, ctx);
    if (existing) return { status: "exists" };
  }
  if (orderCode) {
    const byCode = await repos.orderRepo.findByCode(orderCode, ctx);
    if (byCode) return { status: "exists" };
  }

  const createInput = payload.createInput;
  if (!createInput || typeof createInput !== "object" || !orderCode) {
    return { status: "invalid", error: "missing createInput/orderCode" };
  }

  const depErr = await ensureDeps(database, payload, ctx);
  if (depErr) return depErr;

  const created = await createOrderUseCase(
    repos.orderRepo,
    {
      ...(createInput as CreateOrderInput),
      preAllocatedId: orderId ?? undefined,
    },
    orderCode,
    replayCtxFromPayload(payload, ctx),
  );
  if (!created.ok) return { status: "failed", error: created.error };
  return { status: "created" };
}

async function materializeOrderCancel(
  repos: SyncMaterializeRepos,
  payload: Record<string, unknown>,
  ctx: TenantContext,
  meta?: SyncMaterializeMeta,
): Promise<MaterializeResult> {
  const orderId =
    typeof payload.orderId === "string" && isUuid(payload.orderId) ? payload.orderId : null;
  if (!orderId) return { status: "invalid", error: "missing orderId" };

  const existing = await repos.orderRepo.findById(orderId, ctx);
  if (!existing) return { status: "failed", error: "الطلبية غير موجودة للإلغاء" };
  if (existing.status === "cancelled") return { status: "exists" };

  const stale = await refuseStaleCancelBase(
    meta,
    payload,
    "order",
    orderId,
    existing.version,
    ctx.tenantId,
    "الطلبية",
  );
  if (stale) return stale;

  // P0-001: expectedVersion is REQUIRED - refuseStaleCancelBase already rejected
  // missing baseVersion; hubCanonical may still omit it and use hub version.
  const expectedVersion =
    typeof payload.baseVersion === "number" ? payload.baseVersion : existing.version;

  const result = await cancelOrderUseCase(
    repos.orderRepo,
    orderId,
    replayCtxFromPayload(payload, ctx),
    expectedVersion,
  );
  if (!result.ok) return { status: "failed", error: result.error };
  return { status: "created" };
}

async function materializeExpenseCreate(
  database: DB,
  repos: SyncMaterializeRepos,
  payload: Record<string, unknown>,
  ctx: TenantContext,
): Promise<MaterializeResult> {
  const expenseId =
    typeof payload.expenseId === "string" && isUuid(payload.expenseId) ? payload.expenseId : null;
  const expenseNumber = typeof payload.expenseNumber === "string" ? payload.expenseNumber : null;

  if (expenseId) {
    const existing = await repos.expenseRepo.findById(expenseId, ctx);
    if (existing) return { status: "exists" };
  }

  const createInput = payload.createInput;
  if (!createInput || typeof createInput !== "object" || !expenseNumber) {
    return { status: "invalid", error: "missing createInput/expenseNumber" };
  }

  // Uniform with every other create path (P1-step-2): expenses carry no
  // foreign keys today so this is a no-op, but the call guarantees a future
  // dependency cannot silently bypass ordering.
  const depErr = await ensureDeps(database, payload, ctx);
  if (depErr) return depErr;

  const created = await createExpenseUseCase(
    repos.expenseRepo,
    repos.auditRepo,
    {
      ...(createInput as CreateExpenseInput),
      preAllocatedId: expenseId ?? undefined,
    },
    expenseNumber,
    replayCtxFromPayload(payload, ctx),
  );
  if (!created.ok) return { status: "failed", error: created.error };
  return { status: "created" };
}

async function materializeExpenseCancel(
  repos: SyncMaterializeRepos,
  payload: Record<string, unknown>,
  ctx: TenantContext,
  meta?: SyncMaterializeMeta,
): Promise<MaterializeResult> {
  const expenseId =
    typeof payload.expenseId === "string" && isUuid(payload.expenseId) ? payload.expenseId : null;
  if (!expenseId) return { status: "invalid", error: "missing expenseId" };

  const existing = await repos.expenseRepo.findById(expenseId, ctx);
  if (!existing) return { status: "failed", error: "المصروف غير موجود للإلغاء" };
  if (existing.status === "cancelled") return { status: "exists" };

  const stale = await refuseStaleCancelBase(
    meta,
    payload,
    "expense",
    expenseId,
    existing.version,
    ctx.tenantId,
    "المصروف",
  );
  if (stale) return stale;

  // P0-001: expectedVersion is REQUIRED - refuseStaleCancelBase already rejected
  // missing baseVersion; hubCanonical may still omit it and use hub version.
  const expectedVersion =
    typeof payload.baseVersion === "number" ? payload.baseVersion : existing.version;

  const replay = replayCtxFromPayload(payload, ctx);
  const result = await cancelExpenseUseCase(
    repos.expenseRepo,
    repos.auditRepo,
    expenseId,
    replay.userId,
    replay,
    expectedVersion,
  );
  if (!result.ok) return { status: "failed", error: result.error };
  return { status: "created" };
}

/**
 * Structural check for a master-data snapshot.
 *
 * A payload that cannot possibly describe a row is PERMANENTLY unappliable, so
 * it must be reported as `invalid` — not `failed`. The distinction is not
 * cosmetic: a `failed` unit is retryable, and the pull stream holds its cursor
 * at the first retryable unit to preserve hub ordering. One structurally
 * broken unit therefore blocked EVERY later operation on that device forever
 * (reproduced live 2026-09-10: device A's cursor froze at seq 8 while 5 valid
 * units sat behind it, so `B-Retry-1/2` never reached device A).
 *
 * Returns an error string when the snapshot cannot be applied, or null.
 */
function validateMasterSnapshot(
  entityType: "party" | "fabric" | "color" | "roll",
  snap: Record<string, unknown>,
): string | null {
  const id = snap.id;
  if (typeof id !== "string" || !isUuid(id)) {
    return `${entityType} snapshot has no valid id`;
  }
  const name = typeof snap.name === "string" ? snap.name.trim() : "";
  if (entityType === "party") {
    if (!name) return "party snapshot has no name";
    if (snap.kind !== "customer" && snap.kind !== "supplier") {
      return "party snapshot has no valid kind";
    }
    return null;
  }
  if (entityType === "fabric") {
    return name ? null : "fabric snapshot has no name";
  }
  if (entityType === "color") {
    if (typeof snap.fabricId !== "string" || !isUuid(snap.fabricId)) {
      return "color snapshot has no valid fabricId";
    }
    return name ? null : "color snapshot has no name";
  }
  // roll
  if (typeof snap.colorId !== "string" || !isUuid(snap.colorId)) {
    return "roll snapshot has no valid colorId";
  }
  if (snap.rollNo === undefined || snap.rollNo === null || String(snap.rollNo).trim() === "") {
    return "roll snapshot has no rollNo";
  }
  return null;
}

async function materializeMasterCreate(
  database: DB,
  entityType: "party" | "fabric" | "color" | "roll",
  payload: Record<string, unknown>,
  ctx: TenantContext,
): Promise<MaterializeResult> {
  const snapshot = payload.snapshot;
  if (!snapshot || typeof snapshot !== "object") {
    return { status: "invalid", error: "missing snapshot" };
  }
  const snap = snapshot as Record<string, unknown>;

  const structural = validateMasterSnapshot(entityType, snap);
  if (structural) return { status: "invalid", error: structural };

  // §10: a deleted master must not be silently resurrected by a STALE create
  // replay. If a tombstone guards this (tenant, type, id), the intended row
  // was deleted and this create is an old offline intent — refuse it visibly
  // (retryable `failed` → `dead` after the attempt budget) instead of writing
  // a row the hub already deleted. A legitimate new re-creation is a NEW row
  // with a different id / explicit operator reconciliation; nothing here
  // auto-clears the tombstone.
  const id = typeof snap.id === "string" ? snap.id : "";
  if (id && (await tombstoneExists(ctx.tenantId, entityType, id))) {
    return {
      status: "failed",
      error: "تعذّر إعادة إنشاء سجل محذوف (منع الاسترجاع) — أكمل إعادة الإنشاء يدوياً",
    };
  }

  const deps: InvoiceSyncDependencies = {
    parties: [],
    fabrics: [],
    colors: [],
    rolls: [],
  };

  if (entityType === "party") {
    deps.parties = [snap as unknown as SyncPartySnapshot];
  } else if (entityType === "fabric") {
    deps.fabrics = [snap as unknown as SyncFabricSnapshot];
  } else if (entityType === "color") {
    deps.colors = [snap as unknown as SyncColorSnapshot];
  } else {
    deps.rolls = [snap as unknown as SyncRollSnapshot];
  }

  try {
    await ensureInvoiceSyncDependencies(database, deps, ctx);
    return { status: "created" };
  } catch (err) {
    return {
      status: "failed",
      error: err instanceof Error ? err.message : "فشل مزامنة السجل الأساسي",
    };
  }
}
/* ------------------------------------------------------------------ */
/* SYNC-13 coverage completion branches                                */
/*                                                                     */
/* Every branch replays the SAME domain use-case the device ran        */
/* locally, with three convergent outcomes: `exists` (hub already      */
/* reflects the intent — duplicate delivery), `created` (applied now), */
/* `failed` (retryable: base row or dependency not yet applied).       */
/* Nothing here overwrites a newer hub edit blindly: the identity      */
/* claim serializes concurrent editors, and the base-version /         */
/* base-timestamp check below catches the applied-winner case the      */
/* claim admits (applied holders are excluded from outstanding).       */
/* ------------------------------------------------------------------ */

type MasterKind = "party" | "fabric" | "color" | "roll";

async function findMasterHubRow(
  repos: SyncMaterializeRepos,
  entityType: MasterKind,
  entityId: string,
  ctx: TenantContext,
): Promise<Record<string, unknown> | null> {
  switch (entityType) {
    case "party":
      return (await repos.partyRepo.findById(entityId, ctx)) as unknown as Record<
        string,
        unknown
      > | null;
    case "fabric":
      return (await repos.fabricRepo.findById(entityId, ctx)) as unknown as Record<
        string,
        unknown
      > | null;
    case "color":
      return (await repos.colorRepo.findById(entityId, ctx)) as unknown as Record<
        string,
        unknown
      > | null;
    case "roll":
      return (await repos.rollRepo.findById(entityId, ctx)) as unknown as Record<
        string,
        unknown
      > | null;
  }
}

/** Shallow field equality: every intent field already equals the hub row. */
function intentAlreadyApplied(
  updateInput: Record<string, unknown>,
  hub: Record<string, unknown>,
): boolean {
  return Object.entries(updateInput).every(([k, v]) => {
    if (v === undefined) return true;
    try {
      return JSON.stringify(hub[k] ?? null) === JSON.stringify(v ?? null);
    } catch {
      return false;
    }
  });
}

async function materializeMasterMutation(
  database: DB,
  repos: SyncMaterializeRepos,
  entityType: MasterKind,
  operation: "update" | "delete",
  payload: Record<string, unknown>,
  ctx: TenantContext,
  meta?: SyncMaterializeMeta,
): Promise<MaterializeResult> {
  const entityId =
    typeof payload.entityId === "string" && isUuid(payload.entityId) ? payload.entityId : null;
  if (!entityId) return { status: "invalid", error: "missing entityId" };

  const hub = await findMasterHubRow(repos, entityType, entityId, ctx);
  if (!hub) {
    if (operation !== "delete") {
      return { status: "failed", error: "base row missing, create not yet applied" };
    }
    // Idempotent retry: the row is already gone. Re-assert the tombstone so a
    // stale create can never resurrect it even if a previous run crashed
    // between the delete and the tombstone write. ON CONFLICT makes it a no-op
    // when the tombstone already exists.
    try {
      await recordTombstone(
        ctx.tenantId,
        entityType,
        entityId,
        meta?.opId ?? null,
        meta?.syncDeviceId ?? null,
      );
    } catch (err) {
      logger.warn({ err, entityType, entityId }, "sync tombstone re-assert failed");
    }
    return { status: "exists" };
  }

  const rctx = replayCtxFromPayload(payload, ctx);
  if (operation === "delete") {
    // 4D — stale-base guard for master deletes (party / fabric / color / roll).
    //
    // A delete used to be replayed blindly against whatever the hub held: the
    // unit carried no base, and the domain delete was called with the hub's
    // CURRENT version, so the check inside the use-case always passed. A delete
    // issued offline against v2 therefore destroyed a v3 edit another device had
    // already applied — a blind last-write-wins kill of master data, which is
    // the same asymmetry `refuseStaleCancelBase` closes for document cancels.
    //
    // The distinction the requirement asks for (requirement 10):
    //  * STALE OLD MUTATION — the base no longer matches the hub row: refused,
    //    recorded in `sync_conflicts` as a "delete" decision for the operator,
    //    and retryable (`failed`) so nothing is lost locally.
    //  * LEGITIMATE INTENTIONAL RECREATION — a NEW row with a NEW id. That path
    //    is a create, and the tombstone for the deleted id (written below, on
    //    the applied path only) keeps a REPLAYED create of the OLD id from
    //    resurrecting the deleted row.
    //  * A unit without a base (payload enqueued by a build older than this
    //    guard) stays unchecked, exactly like the update path — refusing it
    //    would strand already-queued work.
    const baseVersion =
      typeof payload.baseVersion === "number" && Number.isFinite(payload.baseVersion)
        ? payload.baseVersion
        : null;
    const baseUpdatedAt = typeof payload.baseUpdatedAt === "string" ? payload.baseUpdatedAt : null;
    const hubVersion = typeof hub.version === "number" ? hub.version : null;
    if (
      !meta?.hubCanonical &&
      baseVersion !== null &&
      hubVersion !== null &&
      hubVersion !== baseVersion
    ) {
      await recordStaleConflict(
        meta,
        payload,
        entityType,
        entityId,
        "cancel",
        baseVersion,
        hubVersion,
        ctx.tenantId,
      );
      return {
        status: "failed",
        error:
          `تعارض حذف ${entityType}: القاعدة v${baseVersion} والمركز v${hubVersion} — ` +
          `عُدِّل السجل على جهاز آخر بعد نسختك. راجع النسخة الفائزة ثم أعد الحذف إن بقي صحيحاً.`,
      };
    }
    if (
      !meta?.hubCanonical &&
      baseVersion === null &&
      baseUpdatedAt !== null &&
      typeof hub.updatedAt === "string" &&
      hub.updatedAt !== baseUpdatedAt
    ) {
      await recordStaleConflict(
        meta,
        payload,
        entityType,
        entityId,
        "cancel",
        null,
        hubVersion,
        ctx.tenantId,
      );
      return {
        status: "failed",
        error: `تعارض حذف ${entityType}: تغيّر السجل على المركز بعد نسختك — راجع النسخة الفائزة أولاً.`,
      };
    }
    try {
      if (entityType === "party") {
        // P0-001: expectedVersion is REQUIRED; it is now the CALLER's base (not
        // the hub's current version, which made the guard vacuous).
        const expectedVersionParty =
          baseVersion ?? (await repos.partyRepo.findById(entityId, ctx))?.version ?? 1;
        await cancelPartyUseCase(repos.partyRepo, entityId, rctx.userId, rctx, expectedVersionParty);
      } else if (entityType === "fabric") {
        await deleteFabricUseCase(repos.fabricRepo, entityId, rctx);
      } else if (entityType === "color") {
        await deleteColorUseCase(repos.colorRepo, entityId, rctx);
      } else {
        await deleteRollUseCase(repos.rollRepo, entityId, rctx);
      }
    } catch (err) {
      return {
        status: "failed",
        error: err instanceof Error ? err.message : "master delete failed",
      };
    }
    // Delete applied — record the tombstone so any stale create / dependency
    // snapshot replaying later is refused instead of resurrecting the row.
    // If the tombstone write fails we report `failed` so the retry re-asserts
    // it (the idempotent `!hub` path above). This keeps delete + tombstone
    // causally durable despite the absence of a single wrapping transaction.
    try {
      await recordTombstone(
        ctx.tenantId,
        entityType,
        entityId,
        meta?.opId ?? null,
        meta?.syncDeviceId ?? null,
      );
    } catch (err) {
      logger.error({ err, entityType, entityId }, "recordTombstone failed — delete retried");
      return {
        status: "failed",
        error: err instanceof Error ? err.message : "tombstone record failed after delete",
      };
    }
    return { status: "created" };
  }

  const updateInput =
    payload.updateInput && typeof payload.updateInput === "object"
      ? (payload.updateInput as Record<string, unknown>)
      : null;
  if (!updateInput) return { status: "invalid", error: "missing updateInput" };

  const baseVersion =
    typeof payload.baseVersion === "number" && Number.isFinite(payload.baseVersion)
      ? payload.baseVersion
      : null;
  const baseUpdatedAt = typeof payload.baseUpdatedAt === "string" ? payload.baseUpdatedAt : null;
  if (
    !meta?.hubCanonical &&
    baseVersion === null &&
    baseUpdatedAt === null
  ) {
    await recordStaleConflict(
      meta,
      payload,
      entityType,
      entityId,
      "update",
      null,
      typeof hub.version === "number" ? hub.version : null,
      ctx.tenantId,
    );
    return { status: "failed", error: "stale base: missing baseVersion — rebase the edit" };
  }
  if (
    !meta?.hubCanonical &&
    baseVersion !== null &&
    typeof hub.version === "number" &&
    hub.version !== baseVersion
  ) {
    await recordStaleConflict(
      meta,
      payload,
      entityType,
      entityId,
      "update",
      baseVersion,
      typeof hub.version === "number" ? hub.version : null,
      ctx.tenantId,
    );
    return { status: "failed", error: "stale base: hub row is newer, rebase the edit" };
  }
  if (
    !meta?.hubCanonical &&
    baseVersion === null &&
    baseUpdatedAt !== null &&
    typeof hub.updatedAt === "string" &&
    hub.updatedAt !== baseUpdatedAt
  ) {
    await recordStaleConflict(
      meta,
      payload,
      entityType,
      entityId,
      "update",
      null,
      typeof hub.version === "number" ? hub.version : null,
      ctx.tenantId,
    );
    return { status: "failed", error: "stale base: hub row changed, rebase the edit" };
  }

  if (intentAlreadyApplied(updateInput, hub)) return { status: "exists" };

  try {
    if (entityType === "party") {
      // P0-001: expectedVersion is REQUIRED - use baseVersion from payload
      const expectedVersionParty = meta?.hubCanonical
        ? (hub.version as number)
        : typeof payload.baseVersion === "number"
          ? payload.baseVersion
          : (hub.version as number);
      const r = await updatePartyUseCase(repos.partyRepo, entityId, updateInput as never, rctx, expectedVersionParty);
      if (!r.ok) return { status: "failed", error: r.error };
    } else if (entityType === "fabric") {
      // P0-001: expectedVersion is REQUIRED - use baseVersion from payload
      const expectedVersionFabric = meta?.hubCanonical
        ? (hub.version as number)
        : typeof payload.baseVersion === "number"
          ? payload.baseVersion
          : (hub.version as number);
      const r = await updateFabricUseCase(repos.fabricRepo, entityId, updateInput as never, rctx, expectedVersionFabric);
      if (!r.ok) return { status: "failed", error: r.error };
    } else if (entityType === "color") {
      // P0-001: expectedVersion is REQUIRED - use baseVersion from payload
      const expectedVersionColor = meta?.hubCanonical
        ? (hub.version as number)
        : typeof payload.baseVersion === "number"
          ? payload.baseVersion
          : (hub.version as number);
      const r = await updateColorUseCase(repos.colorRepo, entityId, updateInput as never, rctx, expectedVersionColor);
      if (!r.ok) return { status: "failed", error: r.error };
    } else {
      const r = await updateRollUseCase(repos.rollRepo, entityId, updateInput as never, rctx);
      if (!r.ok) return { status: "failed", error: r.error };
    }
    return { status: "created" };
  } catch (err) {
    return { status: "failed", error: err instanceof Error ? err.message : "master update failed" };
  }
}

async function materializeOrderUpdate(
  repos: SyncMaterializeRepos,
  payload: Record<string, unknown>,
  ctx: TenantContext,
  meta?: SyncMaterializeMeta,
): Promise<MaterializeResult> {
  const orderId =
    typeof payload.orderId === "string" && isUuid(payload.orderId) ? payload.orderId : null;
  if (!orderId) return { status: "invalid", error: "missing orderId" };
  const hub = await repos.orderRepo.findById(orderId, ctx);
  if (!hub) return { status: "failed", error: "base order not on hub yet" };

  const rctx = replayCtxFromPayload(payload, ctx);
  const fulfillInvoiceId =
    typeof payload.fulfillInvoiceId === "string" && isUuid(payload.fulfillInvoiceId)
      ? payload.fulfillInvoiceId
      : null;
  try {
    if (fulfillInvoiceId) {
      const hubRow = hub as unknown as Record<string, unknown>;
      if (hubRow.status === "fulfilled") return { status: "exists" };
      const r = await fulfillOrderUseCase(repos.orderRepo, orderId, fulfillInvoiceId, rctx);
      if (!r.ok) return { status: "failed", error: r.error };
      return { status: "created" };
    }
    const updateInput =
      payload.updateInput && typeof payload.updateInput === "object"
        ? (payload.updateInput as Record<string, unknown>)
        : null;
    if (!updateInput) return { status: "invalid", error: "missing updateInput" };
    const baseVersion =
      typeof payload.baseVersion === "number" && Number.isFinite(payload.baseVersion)
        ? payload.baseVersion
        : null;
    const hubRow = hub as unknown as Record<string, unknown>;
    if (!meta?.hubCanonical && baseVersion === null) {
      await recordStaleConflict(
        meta,
        payload,
        "order",
        orderId,
        "update",
        null,
        typeof hubRow.version === "number" ? hubRow.version : null,
        ctx.tenantId,
      );
      return {
        status: "failed",
        error: "تعارض تعديل الطلب: الوحدة بلا رقم إصدار أساسي — راجع وأعد الإدخال",
      };
    }
    if (
      !meta?.hubCanonical &&
      baseVersion !== null &&
      typeof hubRow.version === "number" &&
      hubRow.version !== baseVersion
    ) {
      await recordStaleConflict(
        meta,
        payload,
        "order",
        orderId,
        "update",
        baseVersion,
        typeof hubRow.version === "number" ? hubRow.version : null,
        ctx.tenantId,
      );
      return { status: "failed", error: "stale base: hub order is newer, rebase the edit" };
    }
    if (intentAlreadyApplied(updateInput, hubRow)) return { status: "exists" };
    // P0-001: expectedVersion is REQUIRED - use baseVersion from payload
    const expectedVersionOrder = meta?.hubCanonical
      ? (hubRow.version as number)
      : typeof payload.baseVersion === "number"
        ? payload.baseVersion
        : (hubRow.version as number);
    const r = await updateOrderUseCase(repos.orderRepo, orderId, updateInput as never, rctx, expectedVersionOrder);
    if (!r.ok) return { status: "failed", error: r.error };
    return { status: "created" };
  } catch (err) {
    return { status: "failed", error: err instanceof Error ? err.message : "order update failed" };
  }
}

async function materializeLedgerCreate(
  repos: SyncMaterializeRepos,
  payload: Record<string, unknown>,
  ctx: TenantContext,
): Promise<MaterializeResult> {
  const entryIds = Array.isArray(payload.entryIds)
    ? payload.entryIds.filter((id): id is string => typeof id === "string" && isUuid(id))
    : [];
  const entries = Array.isArray(payload.entries)
    ? (payload.entries as Array<Record<string, unknown>>)
    : [];
  if (entryIds.length === 0 || entries.length === 0 || entryIds.length !== entries.length) {
    return { status: "invalid", error: "entries/entryIds mismatch" };
  }
  let allExist = true;
  for (const id of entryIds) {
    const found = await repos.ledgerRepo.findById(id, ctx);
    if (!found) {
      allExist = false;
      break;
    }
  }
  if (allExist) return { status: "exists" };
  const rctx = replayCtxFromPayload(payload, ctx);
  const r = await writeLedgerUseCase(
    repos.ledgerRepo,
    entries.map((e, i) => ({ ...(e as object), id: entryIds[i] }) as never),
    rctx,
  );
  if (!r.ok) return { status: "failed", error: r.error };
  return { status: "created" };
}

async function materializeLedgerCancel(
  repos: SyncMaterializeRepos,
  payload: Record<string, unknown>,
  ctx: TenantContext,
): Promise<MaterializeResult> {
  const referenceType = typeof payload.referenceType === "string" ? payload.referenceType : null;
  const referenceId =
    typeof payload.referenceId === "string" && isUuid(payload.referenceId)
      ? payload.referenceId
      : null;
  if (!referenceType || !referenceId) return { status: "invalid", error: "missing reference" };
  const rctx = replayCtxFromPayload(payload, ctx);
  const r = await cancelLedgerByReferenceUseCase(
    repos.ledgerRepo,
    referenceType,
    referenceId,
    rctx.userId,
    rctx,
  );
  if (r.ok) return { status: "created" };
  if ((r as { code?: string }).code === "ALREADY_CANCELLED") return { status: "exists" };
  return { status: "failed", error: r.error };
}

async function materializeSettlement(
  repos: SyncMaterializeRepos,
  payload: Record<string, unknown>,
  ctx: TenantContext,
): Promise<MaterializeResult> {
  const partyId =
    typeof payload.partyId === "string" && isUuid(payload.partyId) ? payload.partyId : null;
  const settleInput =
    payload.settleInput && typeof payload.settleInput === "object"
      ? (payload.settleInput as Record<string, unknown>)
      : null;
  if (!partyId || !settleInput) return { status: "invalid", error: "missing party/settleInput" };
  const rctx = replayCtxFromPayload(payload, ctx);
  // Frozen-leg replay (preferred): the origin device captured its exact
  // settlement rows. Insert them id-keyed — never recompute from hub balance.
  const frozen = Array.isArray(payload.frozenEntries)
    ? (payload.frozenEntries as Array<Record<string, unknown>>)
    : [];
  if (frozen.length > 0) {
    const ids = frozen.map((e) => (typeof e.id === "string" ? e.id : null));
    if (ids.some((id) => !id || !isUuid(id))) {
      return { status: "invalid", error: "frozen settlement legs lack ids" };
    }
    let allExist = true;
    for (const id of ids as string[]) {
      if (!(await repos.ledgerRepo.findById(id, rctx))) {
        allExist = false;
        break;
      }
    }
    if (allExist) return { status: "exists" };
    const r = await writeLedgerUseCase(repos.ledgerRepo, frozen as never, rctx);
    if (!r.ok) return { status: "failed", error: r.error };
    return { status: "created" };
  }
  // Legacy fallback (no frozen legs): recompute. Converges only when hub
  // balance matches the origin balance; a zero balance means already settled.
  try {
    await repos.statementRepo.settle(partyId, settleInput as never, rctx);
    return { status: "created" };
  } catch (err) {
    if (err instanceof Error && /لا يحتاج تسوية|الرصيد صفر/.test(err.message)) {
      return { status: "exists" };
    }
    return { status: "failed", error: err instanceof Error ? err.message : "settlement failed" };
  }
}

async function materializeCashbox(
  repos: SyncMaterializeRepos,
  operation: string,
  payload: Record<string, unknown>,
  ctx: TenantContext,
): Promise<MaterializeResult> {
  const rctx = replayCtxFromPayload(payload, ctx);
  try {
    if (operation === "opening") {
      const state = await repos.cashboxRepo.getState(rctx);
      if (state && (state as { openingDate?: string }).openingDate) return { status: "exists" };
      const input = payload.openingInput as {
        openingBalance: number;
        openingDate: string;
        currency?: string;
      };
      if (
        !input ||
        typeof input.openingBalance !== "number" ||
        typeof input.openingDate !== "string"
      ) {
        return { status: "invalid", error: "missing openingInput" };
      }
      const r = await setOpeningBalanceUseCase(
        repos.cashboxRepo,
        input.openingBalance,
        input.openingDate,
        input.currency ?? "SYP",
        rctx,
      );
      if (!r.ok) return { status: "failed", error: r.error };
      return { status: "created" };
    }
    if (operation === "movement") {
      const movementId =
        typeof payload.movementId === "string" && isUuid(payload.movementId)
          ? payload.movementId
          : null;
      if (!movementId) return { status: "invalid", error: "missing movementId" };
      const list = await repos.cashboxRepo.listManualMovements(rctx);
      if (list.some((m) => m.id === movementId)) return { status: "exists" };
      const input = payload.movementInput as Record<string, unknown>;
      if (!input || typeof input !== "object")
        return { status: "invalid", error: "missing movementInput" };
      const r = await addManualMovementUseCase(
        repos.cashboxRepo,
        { ...(input as object), id: movementId } as never,
        rctx,
      );
      if (!r.ok) return { status: "failed", error: r.error };
      return { status: "created" };
    }
    if (operation === "movement-cancel") {
      const movementId =
        typeof payload.movementId === "string" && isUuid(payload.movementId)
          ? payload.movementId
          : null;
      if (!movementId) return { status: "invalid", error: "missing movementId" };
      const existing = await repos.cashboxRepo.listManualMovements(rctx);
      if (!existing.some((m) => m.id === movementId)) return { status: "exists" };
      const r = await deleteManualMovementUseCase(repos.cashboxRepo, movementId, rctx);
      if (!r.ok) return { status: "failed", error: r.error };
      return { status: "created" };
    }
    if (operation === "close") {
      const date = typeof payload.closeDate === "string" ? payload.closeDate : null;
      if (!date) return { status: "invalid", error: "missing closeDate" };
      if (await repos.cashboxRepo.isDayLocked(date, rctx)) return { status: "exists" };
      const input = payload.closeInput as Record<string, unknown>;
      if (!input || typeof input !== "object")
        return { status: "invalid", error: "missing closeInput" };
      const r = await closeDayUseCase(
        repos.cashboxRepo,
        { ...(input as object), date } as never,
        rctx,
      );
      if (!r.ok) {
        if (/already-closed|locked/i.test(r.error)) return { status: "exists" };
        return { status: "failed", error: r.error };
      }
      return { status: "created" };
    }
    return { status: "invalid", error: "unsupported cashbox operation" };
  } catch (err) {
    return {
      status: "failed",
      error: err instanceof Error ? err.message : "cashbox replay failed",
    };
  }
}

async function materializeAdminSnapshot(
  repos: SyncMaterializeRepos,
  entityType: "settings" | "company",
  payload: Record<string, unknown>,
  ctx: TenantContext,
): Promise<MaterializeResult> {
  const rctx = replayCtxFromPayload(payload, ctx);
  try {
    if (entityType === "settings") {
      const section = typeof payload.section === "string" ? payload.section : null;
      const data = payload.settingsData;
      if (!section || data === undefined)
        return { status: "invalid", error: "missing section/data" };
      const current = await repos.settingsRepo.getSettings(rctx);
      const incomingAt =
        typeof payload.updatedAt === "string" ? Date.parse(payload.updatedAt) : Number.NaN;
      const currentAt = current?.updatedAt ? Date.parse(current.updatedAt) : 0;
      if (Number.isFinite(incomingAt) && Number.isFinite(currentAt) && currentAt > incomingAt) {
        return { status: "exists" };
      }
      const curSection = (current as unknown as Record<string, unknown> | null)?.[section];
      if (curSection !== undefined) {
        try {
          if (JSON.stringify(curSection) === JSON.stringify(data)) return { status: "exists" };
        } catch {
          /* fall through to apply */
        }
      }
      const r = await updateSettingsUseCase(repos.settingsRepo, section, data, rctx);
      if (!r.ok) return { status: "failed", error: r.error };
      return { status: "created" };
    }
    const data =
      payload.companyData && typeof payload.companyData === "object"
        ? (payload.companyData as Record<string, unknown>)
        : null;
    if (!data) return { status: "invalid", error: "missing companyData" };
    const hub = await repos.companyRepo.findByTenant(rctx.tenantId);
    if (hub) {
      const incomingAt =
        typeof payload.updatedAt === "string" ? Date.parse(payload.updatedAt) : Number.NaN;
      const hubAt = hub.updatedAt instanceof Date ? hub.updatedAt.getTime() : Date.parse(String(hub.updatedAt));
      if (Number.isFinite(incomingAt) && Number.isFinite(hubAt) && hubAt > incomingAt) {
        return { status: "exists" };
      }
      const subset = Object.fromEntries(Object.entries(data).filter(([, v]) => v !== undefined));
      const same = Object.entries(subset).every(([k, v]) => {
        try {
          return (
            JSON.stringify((hub as unknown as Record<string, unknown>)[k] ?? null) ===
            JSON.stringify(v ?? null)
          );
        } catch {
          return false;
        }
      });
      if (same) return { status: "exists" };
    }
    await repos.companyRepo.upsert({ ...(data as object), tenantId: rctx.tenantId } as never);
    return { status: "created" };
  } catch (err) {
    return {
      status: "failed",
      error: err instanceof Error ? err.message : "admin snapshot failed",
    };
  }
}

async function materializeUser(
  payload: Record<string, unknown>,
  ctx: TenantContext,
): Promise<MaterializeResult> {
  const snap = payload.snapshot;
  if (!snap || typeof snap !== "object") return { status: "invalid", error: "missing user snapshot" };
  const s = snap as Record<string, unknown>;
  const id = typeof s.id === "string" && isUuid(s.id) ? s.id : null;
  const tenantId = ctx.tenantId;
  const email = typeof s.email === "string" ? s.email : null;
  const name = typeof s.name === "string" ? s.name : null;
  const role = typeof s.role === "string" ? s.role : null;
  const passwordHash = typeof s.passwordHash === "string" ? s.passwordHash : null;
  if (!id || !email || !name || !role || !passwordHash) {
    return { status: "invalid", error: "incomplete user snapshot" };
  }
  const pinHash = typeof s.pinHash === "string" ? s.pinHash : null;
  const active = s.active !== false;
  const updatedAt =
    typeof s.updatedAt === "string" && !Number.isNaN(Date.parse(s.updatedAt))
      ? s.updatedAt
      : new Date().toISOString();
  try {
    await pool.query(
      `INSERT INTO users (id, tenant_id, name, email, password_hash, pin_hash, role, active, updated_at, tokens_revoked_before)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::timestamptz, CASE WHEN $8 = false THEN now() ELSE NULL END)
       ON CONFLICT (id) DO UPDATE SET
         name = EXCLUDED.name,
         email = EXCLUDED.email,
         password_hash = EXCLUDED.password_hash,
         pin_hash = EXCLUDED.pin_hash,
         role = EXCLUDED.role,
         active = EXCLUDED.active,
         tokens_revoked_before = CASE WHEN EXCLUDED.active = false THEN now() ELSE users.tokens_revoked_before END,
         updated_at = EXCLUDED.updated_at
       WHERE users.tenant_id = EXCLUDED.tenant_id
         AND users.updated_at <= EXCLUDED.updated_at`,
      [id, tenantId, name, email, passwordHash, pinHash, role, active, updatedAt],
    );
    return { status: "created" };
  } catch (err) {
    return {
      status: "failed",
      error: err instanceof Error ? err.message : "user snapshot failed",
    };
  }
}
