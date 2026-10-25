// The phone's counterpart of the desktop ROUTE layer for documents. On the desktop, `invoice.route.ts` and
// `voucher.route.ts` call the use-case and then enqueue the sync unit in ONE `withTenantTx` (F-07: the document
// and its outbox unit commit together or not at all). The phone has no routes, so this module repeats exactly that
// orchestration, calling the same shared use-cases and the same `syncEnqueue` functions (constitution III: units are
// enqueued only through the existing enqueue path). Every exported function runs through `runSerial` (research R3).
import { randomUUID } from "node:crypto";
import { withTenantTx } from "@backend/infrastructure/orm/engine";
import * as invoiceUc from "@backend/application/use-cases/invoices/invoiceUseCases";
import * as voucherUc from "@backend/application/use-cases/vouchers/voucherUseCases";
import {
  enqueueInvoiceCancel,
  enqueueVoucherCancel,
  enqueueVoucherCreate,
} from "@backend/application/use-cases/sync/syncEnqueue";
import { enqueueInvoiceCreate } from "@backend/application/use-cases/sync/syncUseCases";
import {
  captureInvoiceSyncDependencies,
  capturePartySyncDependencies,
} from "@backend/application/use-cases/sync/syncDependencySnapshots";
import type { CreateInvoiceInput, InvoiceData } from "@backend/domain/entities/Invoice";
import type { CreateVoucherInput, VoucherData } from "@backend/domain/entities/Voucher";
import type { TenantContext } from "@backend/domain/types/index";
import type { PhoneRepositories } from "./container";
import { runSerial } from "./serialExecutor";

export type Outcome<T> = { ok: true; data: T } | { ok: false; error: string; code?: string };

export interface DocumentServices {
  repos: PhoneRepositories;
  /** The signed-in user on this phone, with the phone's sync device id. */
  context(): TenantContext;
}

export interface WriteOptions {
  /** Durable operation id for the sync unit; re-sending the same id never duplicates (constitution III). */
  opId?: string;
}

class Refused extends Error {}

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

  return { createInvoice, cancelInvoice, createVoucher, cancelVoucher, replaceVoucher };
}

export type Documents = ReturnType<typeof createDocuments>;
