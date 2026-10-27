// The phone's counterpart of the desktop ROUTE layer for documents. On the desktop, `invoice.route.ts` and
// `voucher.route.ts` call the use-case and then enqueue the sync unit in ONE `withTenantTx` (F-07: the document
// and its outbox unit commit together or not at all). The phone has no routes, so this module repeats exactly that
// orchestration, calling the same shared use-cases and the same `syncEnqueue` functions (constitution III: units are
// enqueued only through the existing enqueue path). Every exported function runs through `runSerial` (research R3).
import { randomUUID } from "node:crypto";
import { withTenantTx } from "@backend/infrastructure/orm/engine";
import * as invoiceUc from "@backend/application/use-cases/invoices/invoiceUseCases";
import * as voucherUc from "@backend/application/use-cases/vouchers/voucherUseCases";
import * as expenseUc from "@backend/application/use-cases/expenses/expenseUseCases";
import * as fabricUc from "@backend/application/use-cases/inventory/fabricUseCases";
import * as colorUc from "@backend/application/use-cases/inventory/colorUseCases";
import * as rollUc from "@backend/application/use-cases/inventory/rollUseCases";
import * as returnUc from "@backend/application/use-cases/returns/returnUseCases";
import * as orderUc from "@backend/application/use-cases/orders/orderUseCases";
import * as partyUc from "@backend/application/use-cases/parties/partyUseCases";
import * as cashboxUc from "@backend/application/use-cases/cashbox/cashboxUseCases";
import {
  changedFields,
  enqueueCashboxClose,
  enqueueCashboxMovement,
  enqueueExpenseCancel,
  enqueueExpenseCreate,
  enqueueInvoiceCancel,
  enqueueMasterCreate,
  enqueueMasterUpdate,
  enqueueOrderCancel,
  enqueueOrderCreate,
  enqueueOrderUpdate,
  enqueueReturnCancel,
  enqueueReturnCreate,
  enqueueRollAdjustment,
  enqueueVoucherCancel,
  enqueueVoucherCreate,
} from "@backend/application/use-cases/sync/syncEnqueue";
import { localDateISO, localToday } from "@backend/infrastructure/utils/localDate";
import { round2dp } from "@erp/shared";
import { BusinessRuleError } from "@backend/domain/errors/index";
import { inventoryCountHelpers } from "@backend/infrastructure/repositories/engineHelpers";
import type { CreateExpenseInput, ExpenseData } from "@backend/domain/entities/Expense";
import { enqueueInvoiceCreate } from "@backend/application/use-cases/sync/syncUseCases";
import {
  captureInvoiceSyncDependencies,
  capturePartySyncDependencies,
  captureReturnSyncDependencies,
} from "@backend/application/use-cases/sync/syncDependencySnapshots";
import type { CreateInvoiceInput, InvoiceData } from "@backend/domain/entities/Invoice";
import type { CreateReturnInput, ReturnData } from "@backend/domain/entities/Return";
import type { CreateVoucherInput, VoucherData } from "@backend/domain/entities/Voucher";
import type { CreateOrderInput, OrderData } from "@backend/domain/entities/Order";
import type { PartyData } from "@backend/domain/entities/Party";
import type { TenantContext } from "@backend/domain/types/index";
import type { PhoneRepositories } from "./container";
import { runSerial } from "./serialExecutor";

export type Outcome<T> = { ok: true; data: T } | { ok: false; error: string; code?: string };

export interface DocumentServices {
  repos: PhoneRepositories;
  /** The signed-in user on this phone, with the phone's sync device id. */
  context(): TenantContext;
}

export interface EntryLineInput {
  /** Existing fabric / colour ids win; otherwise the name is matched exactly or created inside the same save. */
  fabricId?: string;
  fabricName: string;
  colorId?: string;
  colorName: string;
  dyeBatch?: string;
  quantityKg: number;
  pieces: number;
  pricePerKg: number;
}

export interface EntryInvoiceInput {
  date: string;
  supplierId: string;
  currency: string;
  exchangeRate: number;
  lines: EntryLineInput[];
  discount?: number;
  tax?: number;
  shipping?: number;
  paid?: number;
  notes?: string;
}

const cleanName = (name: string): string => name.trim().replace(/\s+/g, " ");
const normName = (name: string): string => cleanName(name).toLowerCase();

/** The two request headers the shared enqueue functions read (`Idempotency-Key`, the device id), without an HTTP request. */
function syntheticRequest(opId: string, ctx: TenantContext) {
  return {
    headers: { "idempotency-key": opId } as Record<string, string>,
    tenantContext: { syncDeviceId: ctx.syncDeviceId ?? null },
  };
}

export interface WriteOptions {
  /** Durable operation id for the sync unit; re-sending the same id never duplicates (constitution III). */
  opId?: string;
}

class Refused extends Error {}

const isAdminLikeRole = (role: string | undefined) => role === "admin" || role === "accountant";

function failure(error: unknown): { ok: false; error: string } {
  return { ok: false, error: error instanceof Error ? error.message : String(error) };
}

export function createDocuments(services: DocumentServices) {
  const { repos } = services;

  async function partyDeps(partyId: string, ctx: TenantContext) {
    return capturePartySyncDependencies(repos.partyRepo, [partyId], ctx);
  }

  const createInvoice = (input: CreateInvoiceInput, options: WriteOptions = {}) =>
    runSerial<Outcome<InvoiceData>>(async () => {
      const ctx = services.context();
      try {
        return await withTenantTx(ctx.tenantId, async () => {
          const created = await invoiceUc.createInvoiceUseCase(
            repos.invoiceRepo,
            repos.auditRepo,
            input,
            ctx,
          );
          if (!created.ok) return created;
          const dependencies = await captureInvoiceSyncDependencies(repos, input, ctx);
          await enqueueInvoiceCreate(
            repos.syncOutboxRepo,
            {
              id: created.data.id,
              type: created.data.type,
              number: created.data.number,
              partyId: created.data.partyId,
              linkedVoucherId: created.data.linkedVoucherId ?? null,
              lines: created.data.lines.map((l) => ({
                rollId: l.rollId,
                quantityKg: l.quantityKg,
                pieces: l.pieces ?? 0,
                costPerKg: l.costPerKg ?? null,
              })),
            },
            input,
            ctx,
            ctx.syncDeviceId ?? null,
            options.opId ?? randomUUID(),
            dependencies,
          );
          return created;
        });
      } catch (error) {
        return failure(error);
      }
    });

  const cancelInvoice = (id: string, expectedVersion: number, options: WriteOptions = {}) =>
    runSerial<Outcome<InvoiceData>>(async () => {
      const ctx = services.context();
      try {
        return await withTenantTx(ctx.tenantId, async () => {
          const cancelled = await invoiceUc.cancelInvoiceUseCase(
            repos.invoiceRepo,
            repos.auditRepo,
            id,
            ctx.userId,
            ctx,
            expectedVersion,
          );
          if (!cancelled.ok) return cancelled;
          await enqueueInvoiceCancel(
            repos.syncOutboxRepo,
            { id: cancelled.data.id, number: cancelled.data.number, type: cancelled.data.type },
            ctx,
            ctx.syncDeviceId ?? null,
            options.opId ?? randomUUID(),
            expectedVersion,
          );
          return cancelled;
        });
      } catch (error) {
        return failure(error);
      }
    });

  const createVoucher = (
    kind: "receipt" | "payment",
    body: Omit<CreateVoucherInput, "kind">,
    options: WriteOptions = {},
  ) =>
    runSerial<Outcome<VoucherData>>(async () => {
      const ctx = services.context();
      const input = { ...body, kind } as CreateVoucherInput;
      try {
        return await withTenantTx(ctx.tenantId, async () => {
          const created = await voucherUc.createVoucherUseCase(
            repos.voucherRepo,
            repos.auditRepo,
            input,
            ctx,
          );
          if (!created.ok) return created;
          await enqueueVoucherCreate(
            repos.syncOutboxRepo,
            {
              id: created.data.id,
              kind: created.data.kind,
              number: created.data.number,
              partyId: created.data.partyId,
            },
            input,
            ctx,
            ctx.syncDeviceId ?? null,
            options.opId ?? randomUUID(),
            await partyDeps(created.data.partyId, ctx),
          );
          return created;
        });
      } catch (error) {
        return failure(error);
      }
    });

  const cancelVoucher = (id: string, expectedVersion: number, options: WriteOptions = {}) =>
    runSerial<Outcome<VoucherData>>(async () => {
      const ctx = services.context();
      try {
        return await withTenantTx(ctx.tenantId, async () => {
          const cancelled = await voucherUc.cancelVoucherUseCase(
            repos.voucherRepo,
            repos.auditRepo,
            id,
            ctx.userId,
            ctx,
            expectedVersion,
          );
          if (!cancelled.ok) return cancelled;
          await enqueueVoucherCancel(
            repos.syncOutboxRepo,
            { id: cancelled.data.id, number: cancelled.data.number },
            ctx,
            ctx.syncDeviceId ?? null,
            options.opId ?? randomUUID(),
            expectedVersion,
          );
          return cancelled;
        });
      } catch (error) {
        return failure(error);
      }
    });

  /**
   * Voucher amend = cancel the original + create the replacement as ONE transaction (ERP-008, constitution II): both
   * outbox units commit with them, and any refusal rolls the cancel back so the original keeps its effect.
   */
  const replaceVoucher = (
    id: string,
    kind: "receipt" | "payment",
    expectedVersion: number,
    body: Omit<CreateVoucherInput, "kind">,
    options: WriteOptions = {},
  ) =>
    runSerial<Outcome<VoucherData>>(async () => {
      const ctx = services.context();
      const input = { ...body, kind } as CreateVoucherInput;
      const original = await repos.voucherRepo.findById(id, ctx);
      if (!original) return { ok: false, error: "غير موجود", code: "NOT_FOUND" };
      if (original.kind !== kind) return { ok: false, error: "نوع السند لا يطابق المسار" };
      try {
        return await withTenantTx(ctx.tenantId, async () => {
          const cancelled = await voucherUc.cancelVoucherUseCase(
            repos.voucherRepo,
            repos.auditRepo,
            id,
            ctx.userId,
            ctx,
            expectedVersion,
          );
          if (!cancelled.ok) throw new Refused(cancelled.error);
          await enqueueVoucherCancel(
            repos.syncOutboxRepo,
            { id: cancelled.data.id, number: cancelled.data.number },
            ctx,
            ctx.syncDeviceId ?? null,
            undefined, // its own op id
            expectedVersion,
          );
          const made = await voucherUc.createVoucherUseCase(
            repos.voucherRepo,
            repos.auditRepo,
            input,
            ctx,
          );
          if (!made.ok) throw new Refused(made.error);
          await enqueueVoucherCreate(
            repos.syncOutboxRepo,
            {
              id: made.data.id,
              kind: made.data.kind,
              number: made.data.number,
              partyId: made.data.partyId,
            },
            input,
            ctx,
            ctx.syncDeviceId ?? null,
            options.opId ?? randomUUID(),
            await partyDeps(made.data.partyId, ctx),
          );
          return made;
        });
      } catch (error) {
        return failure(error);
      }
    });

  /** Same orchestration as `POST /expenses` (F-07): the expense and its sync unit commit together. */
  const createExpense = (input: CreateExpenseInput, options: WriteOptions = {}) =>
    runSerial<Outcome<ExpenseData>>(async () => {
      const ctx = services.context();
      try {
        return await withTenantTx(ctx.tenantId, async () => {
          const created = await expenseUc.createExpenseUseCase(
            repos.expenseRepo,
            repos.auditRepo,
            input,
            undefined,
            ctx,
          );
          if (!created.ok) return created;
          await enqueueExpenseCreate(
            repos.syncOutboxRepo,
            { id: created.data.id, number: created.data.number },
            input,
            ctx,
            ctx.syncDeviceId ?? null,
            options.opId ?? randomUUID(),
          );
          return created;
        });
      } catch (error) {
        return failure(error);
      }
    });

  const cancelExpense = (id: string, expectedVersion: number, options: WriteOptions = {}) =>
    runSerial<Outcome<ExpenseData>>(async () => {
      const ctx = services.context();
      try {
        return await withTenantTx(ctx.tenantId, async () => {
          const cancelled = await expenseUc.cancelExpenseUseCase(
            repos.expenseRepo,
            repos.auditRepo,
            id,
            ctx.userId,
            ctx,
            expectedVersion,
          );
          if (!cancelled.ok) return cancelled;
          await enqueueExpenseCancel(
            repos.syncOutboxRepo,
            { id: cancelled.data.id, number: cancelled.data.number },
            ctx,
            ctx.syncDeviceId ?? null,
            options.opId ?? randomUUID(),
            expectedVersion,
          );
          return cancelled;
        });
      } catch (error) {
        return failure(error);
      }
    });

  /** Same as the customer/supplier create routes: party, opening journal and sync unit in one transaction. */
  const createParty = (
    kind: "customer" | "supplier",
    body: Record<string, unknown>,
    options: WriteOptions = {},
  ) =>
    runSerial<Outcome<PartyData>>(async () => {
      const ctx = services.context();
      const input = { ...body, kind } as Parameters<typeof partyUc.createPartyUseCase>[1];
      try {
        return await withTenantTx(ctx.tenantId, async () => {
          const result = await partyUc.createPartyUseCase(repos.partyRepo, input, ctx);
          if (!result.ok) return result;
          const p = result.data;
          await enqueueMasterCreate(
            repos.syncOutboxRepo,
            "party",
            p.id,
            {
              id: p.id,
              kind: p.kind,
              code: p.code ?? null,
              name: p.name,
              companyName: p.companyName ?? null,
              commercialReg: p.commercialReg ?? null,
              category: p.category ?? null,
              salesRep: p.salesRep ?? null,
              phone: p.phone ?? null,
              mobile: p.mobile ?? null,
              whatsapp: p.whatsapp ?? null,
              altPhone: p.altPhone ?? null,
              email: p.email ?? null,
              website: p.website ?? null,
              address: p.address ?? null,
              city: p.city ?? null,
              country: p.country ?? null,
              taxNumber: p.taxNumber ?? null,
              currency: p.currency,
              paymentTerms: p.paymentTerms ?? null,
              paymentMethod: p.paymentMethod ?? null,
              defaultDiscount: p.defaultDiscount,
              vat: p.vat,
              status: p.status,
              notes: p.notes ?? null,
              openingBalance: p.openingBalance ?? 0,
              openingDate: p.openingDate ?? localDateISO(new Date(p.createdAt ?? Date.now())),
              openingCurrency: p.openingCurrency ?? null,
              openingNote: p.openingNote ?? null,
            },
            ctx,
            ctx.syncDeviceId ?? null,
            options.opId ?? randomUUID(),
          );
          return result;
        });
      } catch (error) {
        return failure(error);
      }
    });

  const updateParty = (
    id: string,
    body: Record<string, unknown>,
    expectedVersion: number,
    options: WriteOptions = {},
  ) =>
    runSerial<Outcome<PartyData>>(async () => {
      const ctx = services.context();
      try {
        return await withTenantTx(ctx.tenantId, async () => {
          const before = await repos.partyRepo.findById(id, ctx);
          const result = await partyUc.updatePartyUseCase(
            repos.partyRepo,
            id,
            body,
            ctx,
            expectedVersion,
          );
          if (!result.ok) return result;
          await enqueueMasterUpdate(
            repos.syncOutboxRepo,
            "party",
            id,
            changedFields(body, before as unknown as Record<string, unknown> | null),
            ctx,
            ctx.syncDeviceId ?? null,
            options.opId ?? randomUUID(),
            { version: (before as { version?: number } | null)?.version ?? null },
          );
          return result;
        });
      } catch (error) {
        return failure(error);
      }
    });

  /** Manual cashbox movement: id pre-allocated so a replay on the hub converges (SYNC-12). */
  const addCashboxMovement = (input: Record<string, unknown>, options: WriteOptions = {}) =>
    runSerial<Outcome<{ id?: string }>>(async () => {
      const ctx = services.context();
      try {
        return await withTenantTx(ctx.tenantId, async () => {
          const id = randomUUID();
          const added = await cashboxUc.addManualMovementUseCase(
            repos.cashboxRepo,
            { ...input, id } as never,
            ctx,
          );
          if (!added.ok) return added;
          await enqueueCashboxMovement(
            repos.syncOutboxRepo,
            { id: added.data.id ?? id },
            input,
            ctx,
            ctx.syncDeviceId ?? null,
            options.opId ?? randomUUID(),
          );
          return added as Outcome<{ id?: string }>;
        });
      } catch (error) {
        return failure(error);
      }
    });

  /**
   * Manual quantity correction of one roll (desktop route POST /inventory/rolls/:id/adjust): an adjustment stock movement,
   * the P&L leg at cost and an audit row in one transaction, plus one roll/adjust sync unit. The remaining kg never goes
   * below zero.
   */
  const adjustRoll = (
    rollId: string,
    input: { newKg?: number; newPieces?: number; reason: string; expectedVersion?: number },
    options: WriteOptions = {},
  ) =>
    runSerial<Outcome<{ rollId: string; beforeKg: number; afterKg: number }>>(async () => {
      const ctx = services.context();
      try {
        return await withTenantTx(ctx.tenantId, async (tx) => {
          if (input.newKg === undefined && input.newPieces === undefined) {
            throw new BusinessRuleError("أدخل الكمية أو عدد الأثواب الجديد");
          }
          if ((input.newKg ?? 0) < 0 || (input.newPieces ?? 0) < 0) {
            throw new BusinessRuleError("لا يمكن أن تكون الكمية أقل من صفر");
          }
          if (input.reason.trim().length < 2) throw new BusinessRuleError("اكتب سبب التعديل");
          const roll = await repos.rollRepo.findById(rollId, ctx);
          if (!roll) throw new BusinessRuleError("اللفة غير موجودة.");
          const refId = randomUUID();
          const adjustment = {
            rollId,
            deltaKg:
              input.newKg === undefined ? 0 : round2dp(input.newKg - Number(roll.remainingKg ?? 0)),
            deltaPieces:
              input.newPieces === undefined ? 0 : input.newPieces - (roll.remainingPieces ?? 0),
            reason: input.reason.trim(),
            date: localToday(),
            referenceType: "inventory_adjustment" as const,
            referenceId: refId,
            referenceNumber: `ADJ-${refId.slice(0, 8).toUpperCase()}`,
            expectedVersion: input.expectedVersion ?? null,
          };
          const applied = await (
            await inventoryCountHelpers()
          ).applyRollAdjustment(tx as never, ctx, adjustment);
          await enqueueRollAdjustment(
            repos.syncOutboxRepo,
            ctx,
            adjustment,
            syntheticRequest(options.opId ?? randomUUID(), ctx),
          );
          return { ok: true as const, data: applied };
        });
      } catch (error) {
        return failure(error);
      }
    });

  /** Price (or note) edit of a roll through the same use-case as the desktop; refused after the first sale (frozen cost). */
  const updateRoll = (rollId: string, input: Record<string, unknown>, options: WriteOptions = {}) =>
    runSerial<Outcome<{ id: string }>>(async () => {
      const ctx = services.context();
      try {
        return await withTenantTx(ctx.tenantId, async () => {
          const before = await repos.rollRepo.findById(rollId, ctx);
          const updated = await rollUc.updateRollUseCase(
            repos.rollRepo,
            rollId,
            input as never,
            ctx,
          );
          if (!updated.ok) return updated;
          await enqueueMasterUpdate(
            repos.syncOutboxRepo,
            "roll",
            rollId,
            changedFields(input, before as unknown as Record<string, unknown> | null),
            ctx,
            ctx.syncDeviceId ?? null,
            options.opId ?? randomUUID(),
            { version: (before as unknown as { version?: number } | null)?.version ?? null },
          );
          return updated as Outcome<{ id: string }>;
        });
      } catch (error) {
        return failure(error);
      }
    });

  /** Writes the physical count of one roll (local working line; nothing leaves the phone until it is posted). */
  const recordCount = (input: {
    year: number;
    rollId: string;
    countedKg: number | null;
    countedPieces?: number | null;
    reason?: string;
  }) =>
    runSerial<Outcome<{ rollId: string; diffKg: number | null }>>(async () => {
      const ctx = services.context();
      try {
        if (!isAdminLikeRole(ctx.userRole)) {
          throw new BusinessRuleError("الجرد متاح للمدير والمحاسب فقط");
        }
        const data = await withTenantTx(ctx.tenantId, async (tx) =>
          (await inventoryCountHelpers()).recordCount(
            tx as never,
            ctx,
            input.year,
            input.rollId,
            input.countedKg,
            input.countedPieces ?? null,
            input.reason,
          ),
        );
        return { ok: true as const, data };
      } catch (error) {
        return failure(error);
      }
    });

  /** Posts a count variance: a real stock movement + P&L leg, and one roll/adjust sync unit (desktop POST counts/post). */
  const postCount = (countId: string, options: WriteOptions = {}) =>
    runSerial<Outcome<{ rollId: string; diffKg: number }>>(async () => {
      const ctx = services.context();
      try {
        if (!isAdminLikeRole(ctx.userRole)) {
          throw new BusinessRuleError("الجرد متاح للمدير والمحاسب فقط");
        }
        const data = await withTenantTx(ctx.tenantId, async (tx) => {
          const posted = await (
            await inventoryCountHelpers()
          ).postCountVariance(tx as never, ctx, countId);
          if (posted.adjustment) {
            await enqueueRollAdjustment(
              repos.syncOutboxRepo,
              ctx,
              posted.adjustment,
              syntheticRequest(options.opId ?? randomUUID(), ctx),
            );
          }
          return { rollId: posted.rollId, diffKg: posted.diffKg };
        });
        return { ok: true as const, data };
      } catch (error) {
        return failure(error);
      }
    });

  /**
   * Purchase (entry) invoice (FR-16). Any new fabric, colour and roll is created INSIDE the same transaction as the invoice,
   * each with its own master-create sync unit queued before the invoice unit (the order the desktop produces by creating them
   * first). A refusal anywhere throws, so nothing of the save survives: no fabric, colour, roll, ledger entry or movement.
   */
  const createEntryInvoice = (input: EntryInvoiceInput, options: WriteOptions = {}) =>
    runSerial<Outcome<InvoiceData>>(async () => {
      const ctx = services.context();
      const device = ctx.syncDeviceId ?? null;
      try {
        return await withTenantTx(ctx.tenantId, async () => {
          if (input.lines.length === 0) throw new BusinessRuleError("أضف بنداً واحداً على الأقل");
          const fabricByName = new Map<string, string>();
          const colorByName = new Map<string, string>();
          const lines: CreateInvoiceInput["lines"] = [];
          for (const l of input.lines) {
            if (!(l.quantityKg > 0)) throw new BusinessRuleError("الكمية يجب أن تكون أكبر من صفر");
            if (!(l.pricePerKg >= 0)) throw new BusinessRuleError("السعر غير صحيح");
            if (!l.fabricName.trim() || !l.colorName.trim()) {
              throw new BusinessRuleError("اكتب اسم القماش واللون");
            }
            let fabricId = l.fabricId ?? fabricByName.get(normName(l.fabricName));
            if (!fabricId) {
              const found = await repos.fabricRepo.list(
                { search: cleanName(l.fabricName), limit: 50 },
                ctx,
              );
              fabricId = found.data.find((f) => normName(f.name) === normName(l.fabricName))?.id;
            }
            if (!fabricId) {
              const made = await fabricUc.createFabricUseCase(
                repos.fabricRepo,
                { name: cleanName(l.fabricName), minStockKg: 0 },
                ctx,
              );
              if (!made.ok) throw new BusinessRuleError(made.error);
              const f = made.data;
              await enqueueMasterCreate(
                repos.syncOutboxRepo,
                "fabric",
                f.id,
                {
                  id: f.id,
                  name: f.name,
                  category: f.category ?? null,
                  minStockKg: f.minStockKg,
                  unit: f.unit ?? null,
                  notes: f.notes ?? null,
                  imageUrl: f.imageUrl ?? null,
                },
                ctx,
                device,
                randomUUID(),
              );
              fabricId = f.id;
            }
            fabricByName.set(normName(l.fabricName), fabricId);

            const colorKey = `${fabricId}|${normName(l.colorName)}`;
            let colorId = l.colorId ?? colorByName.get(colorKey);
            if (!colorId) {
              const found = await repos.colorRepo.list(
                { fabricId, search: cleanName(l.colorName), limit: 50 },
                ctx,
              );
              colorId = found.data.find((c) => normName(c.name) === normName(l.colorName))?.id;
            }
            if (!colorId) {
              const made = await colorUc.createColorUseCase(
                repos.colorRepo,
                { fabricId, name: cleanName(l.colorName) },
                ctx,
              );
              if (!made.ok) throw new BusinessRuleError(made.error);
              const c = made.data;
              await enqueueMasterCreate(
                repos.syncOutboxRepo,
                "color",
                c.id,
                {
                  id: c.id,
                  fabricId: c.fabricId,
                  name: c.name,
                  code: c.code ?? null,
                  hex: c.hex ?? null,
                  imageUrl: c.imageUrl ?? null,
                },
                ctx,
                device,
                randomUUID(),
              );
              colorId = c.id;
            }
            colorByName.set(colorKey, colorId);

            // The roll is born empty; the entry invoice raises its remaining kg (the desktop's own sequence).
            const madeRoll = await rollUc.createRollUseCase(
              repos.rollRepo,
              {
                colorId,
                rollNo: `R-${randomUUID().slice(0, 8).toUpperCase()}`,
                ...(l.dyeBatch?.trim() ? { dyeBatch: l.dyeBatch.trim() } : {}),
                initialKg: l.quantityKg,
                remainingKg: 0,
                pieces: l.pieces,
                pricePerKg: l.pricePerKg,
                currency: input.currency,
                supplierId: input.supplierId,
                entryDate: input.date,
              },
              ctx,
            );
            if (!madeRoll.ok) throw new BusinessRuleError(madeRoll.error);
            const roll = madeRoll.data;
            await enqueueMasterCreate(
              repos.syncOutboxRepo,
              "roll",
              roll.id,
              {
                id: roll.id,
                colorId: roll.colorId,
                rollNo: roll.rollNo,
                dyeBatch: roll.dyeBatch ?? null,
                initialKg: roll.initialKg,
                remainingKg: roll.remainingKg,
                pieces: roll.pieces,
                remainingPieces: roll.remainingPieces,
                pricePerKg: roll.pricePerKg,
                salePricePerKg: roll.salePricePerKg ?? null,
                currency: roll.currency,
                supplierId: roll.supplierId ?? null,
                entryDate: roll.entryDate,
                widthCm: roll.widthCm ?? null,
                weightGsm: roll.weightGsm ?? null,
                status: roll.status,
              },
              ctx,
              device,
              randomUUID(),
            );
            lines.push({
              fabricId,
              colorId,
              rollId: roll.id,
              quantityKg: l.quantityKg,
              pieces: l.pieces,
              pricePerKg: l.pricePerKg,
            } as CreateInvoiceInput["lines"][number]);
          }

          const createInput = {
            type: "entry",
            date: input.date,
            partyId: input.supplierId,
            partyType: "supplier",
            currency: input.currency,
            exchangeRate: input.exchangeRate,
            lines,
            discount: input.discount ?? 0,
            tax: input.tax ?? 0,
            shipping: input.shipping ?? 0,
            paid: input.paid ?? 0,
            ...(input.notes ? { notes: input.notes } : {}),
          } as CreateInvoiceInput;
          const created = await invoiceUc.createInvoiceUseCase(
            repos.invoiceRepo,
            repos.auditRepo,
            createInput,
            ctx,
          );
          if (!created.ok) throw new BusinessRuleError(created.error);
          const dependencies = await captureInvoiceSyncDependencies(repos, createInput, ctx);
          await enqueueInvoiceCreate(
            repos.syncOutboxRepo,
            {
              id: created.data.id,
              type: created.data.type,
              number: created.data.number,
              partyId: created.data.partyId,
              linkedVoucherId: created.data.linkedVoucherId ?? null,
              lines: created.data.lines.map((l) => ({
                rollId: l.rollId,
                quantityKg: l.quantityKg,
                pieces: l.pieces ?? 0,
                costPerKg: l.costPerKg ?? null,
              })),
            },
            createInput,
            ctx,
            device,
            options.opId ?? randomUUID(),
            dependencies,
          );
          return created;
        });
      } catch (error) {
        return failure(error);
      }
    });

  /** Sale or entry return against a source invoice (desktop POST /returns): the use-case values it and writes the reversals. */
  const createReturn = (input: CreateReturnInput, options: WriteOptions = {}) =>
    runSerial<Outcome<ReturnData>>(async () => {
      const ctx = services.context();
      try {
        if (!isAdminLikeRole(ctx.userRole)) {
          throw new BusinessRuleError("المرتجعات متاحة للمدير والمحاسب فقط");
        }
        return await withTenantTx(ctx.tenantId, async () => {
          const created = await returnUc.createReturnUseCase(
            repos.returnRepo,
            repos.auditRepo,
            input,
            ctx,
          );
          if (!created.ok) return created;
          const dependencies = await captureReturnSyncDependencies(repos, input, ctx);
          await enqueueReturnCreate(
            repos.syncOutboxRepo,
            {
              id: created.data.id,
              number: created.data.number,
              kind: created.data.kind,
              partyId: created.data.partyId,
            },
            input,
            ctx,
            ctx.syncDeviceId ?? null,
            options.opId ?? randomUUID(),
            dependencies,
          );
          return created;
        });
      } catch (error) {
        return failure(error);
      }
    });

  const cancelReturn = (id: string, expectedVersion: number, options: WriteOptions = {}) =>
    runSerial<Outcome<ReturnData>>(async () => {
      const ctx = services.context();
      try {
        if (!isAdminLikeRole(ctx.userRole)) {
          throw new BusinessRuleError("المرتجعات متاحة للمدير والمحاسب فقط");
        }
        return await withTenantTx(ctx.tenantId, async () => {
          const cancelled = await returnUc.cancelReturnUseCase(
            repos.returnRepo,
            repos.auditRepo,
            id,
            ctx.userId,
            ctx,
            expectedVersion,
          );
          if (!cancelled.ok) return cancelled;
          await enqueueReturnCancel(
            repos.syncOutboxRepo,
            { id: cancelled.data.id, number: cancelled.data.number },
            ctx,
            ctx.syncDeviceId ?? null,
            options.opId ?? randomUUID(),
            expectedVersion,
          );
          return cancelled;
        });
      } catch (error) {
        return failure(error);
      }
    });

  /** A customer order (desktop POST /orders): the code comes from this device's number block inside the same transaction. */
  const createOrder = (input: CreateOrderInput, options: WriteOptions = {}) =>
    runSerial<Outcome<OrderData>>(async () => {
      const ctx = services.context();
      try {
        return await withTenantTx(ctx.tenantId, async () => {
          const created = await orderUc.createOrderUseCase(repos.orderRepo, input, undefined, ctx);
          if (!created.ok) return created;
          await enqueueOrderCreate(
            repos.syncOutboxRepo,
            { id: created.data.id, code: created.data.code },
            input,
            ctx,
            ctx.syncDeviceId ?? null,
            options.opId ?? randomUUID(),
            input.customerId ? await partyDeps(input.customerId, ctx) : null,
          );
          return created;
        });
      } catch (error) {
        return failure(error);
      }
    });

  const cancelOrder = (id: string, expectedVersion: number, options: WriteOptions = {}) =>
    runSerial<Outcome<OrderData>>(async () => {
      const ctx = services.context();
      try {
        return await withTenantTx(ctx.tenantId, async () => {
          const cancelled = await orderUc.cancelOrderUseCase(
            repos.orderRepo,
            id,
            ctx,
            expectedVersion,
          );
          if (!cancelled.ok) return cancelled;
          await enqueueOrderCancel(
            repos.syncOutboxRepo,
            { id: cancelled.data.id, code: cancelled.data.code },
            ctx,
            ctx.syncDeviceId ?? null,
            options.opId ?? randomUUID(),
            expectedVersion,
          );
          return cancelled;
        });
      } catch (error) {
        return failure(error);
      }
    });

  /** Marks an open order fulfilled by an existing invoice (desktop POST /orders/:id/fulfill). */
  const fulfillOrder = (id: string, invoiceId: string, options: WriteOptions = {}) =>
    runSerial<Outcome<OrderData>>(async () => {
      const ctx = services.context();
      try {
        return await withTenantTx(ctx.tenantId, async () => {
          const before = await repos.orderRepo.findById(id, ctx);
          const done = await orderUc.fulfillOrderUseCase(repos.orderRepo, id, invoiceId, ctx);
          if (!done.ok) return done;
          await enqueueOrderUpdate(
            repos.syncOutboxRepo,
            { id: done.data.id, code: done.data.code },
            {},
            invoiceId,
            ctx,
            ctx.syncDeviceId ?? null,
            options.opId ?? randomUUID(),
            { version: before?.version ?? null },
          );
          return done;
        });
      } catch (error) {
        return failure(error);
      }
    });

  /** Closes a day's cashbox (desktop POST /cashbox/close-day). Only the date, the counted amount and the currency are sent. */
  const closeCashboxDay = (
    input: { date: string; counted: number; currency: string },
    options: WriteOptions = {},
  ) =>
    runSerial<Outcome<{ date: string }>>(async () => {
      const ctx = services.context();
      try {
        if (!isAdminLikeRole(ctx.userRole)) {
          throw new BusinessRuleError("إقفال اليوم متاح للمدير والمحاسب فقط");
        }
        if (!(input.counted >= 0)) throw new BusinessRuleError("اكتب المبلغ المعدود");
        const payload = { date: input.date, counted: input.counted, currency: input.currency };
        return await withTenantTx(ctx.tenantId, async () => {
          const closed = await cashboxUc.closeDayUseCase(repos.cashboxRepo, payload as never, ctx);
          if (!closed.ok) return closed as Outcome<{ date: string }>;
          await enqueueCashboxClose(
            repos.syncOutboxRepo,
            input.date,
            payload,
            ctx,
            ctx.syncDeviceId ?? null,
            options.opId ?? randomUUID(),
          );
          return { ok: true as const, data: { date: input.date } };
        });
      } catch (error) {
        return failure(error);
      }
    });

  return {
    closeCashboxDay,
    createOrder,
    cancelOrder,
    fulfillOrder,
    createReturn,
    cancelReturn,
    createEntryInvoice,
    adjustRoll,
    updateRoll,
    recordCount,
    postCount,
    createInvoice,
    cancelInvoice,
    createVoucher,
    cancelVoucher,
    replaceVoucher,
    createExpense,
    cancelExpense,
    createParty,
    updateParty,
    addCashboxMovement,
  };
}

export type Documents = ReturnType<typeof createDocuments>;
