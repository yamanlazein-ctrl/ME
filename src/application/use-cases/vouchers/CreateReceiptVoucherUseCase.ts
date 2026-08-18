import { Result, Ok, Err } from "@/core/result";
import { ValidationError } from "@/domain/errors";
import { Voucher } from "@/domain/entities/Voucher";
import { LedgerEntry } from "@/domain/entities/LedgerEntry";
import { PaymentReceived } from "@/domain/events";
import { TenantContext } from "@/domain/types";
import { IVoucherRepository } from "@/application/ports/IVoucherRepository";
import { ILedgerRepository } from "@/application/ports/ILedgerRepository";
import type { CreateVoucherInput } from "@/core/dtos/VoucherDTO";

export class CreateReceiptVoucherUseCase {
  constructor(
    private readonly vouchers: IVoucherRepository,
    private readonly ledger: ILedgerRepository,
  ) {}

  async execute(
    input: CreateVoucherInput,
    ctx: TenantContext,
  ): Promise<Result<Voucher, ValidationError>> {
    if (!input.partyId) {
      return Err(new ValidationError("الطرف مطلوب.", "partyId"));
    }
    if (!input.amount || input.amount <= 0) {
      return Err(new ValidationError("المبلغ مطلوب ويجب أن يكون أكبر من الصفر.", "amount"));
    }

    const voucher = Voucher.receipt({
      ...input,
      tenantId: ctx.tenantId,
      partyKind: input.partyKind,
      createdBy: ctx.userName,
    });

    const saved = await this.vouchers.create(voucher, ctx);

    const ledgerEntry = LedgerEntry.credit({
      tenantId: ctx.tenantId,
      date: saved.date,
      type: "receipt_in",
      referenceType: "receipt_in",
      referenceId: saved.id,
      partyId: saved.partyId,
      partyKind: saved.partyKind,
      amount: saved.amount,
      currency: saved.currency,
      cashImpact: saved.method === "cash" ? "in" : "none",
      description: `سند قبض ${saved.number}`,
      createdBy: ctx.userName,
      referenceNumber: saved.number,
      invoiceId: saved.invoiceId,
      notesInternal: saved.notesInternal,
    });

    await this.ledger.write(ledgerEntry, ctx);

    const event = PaymentReceived(ctx.tenantId, {
      voucherId: saved.id,
      partyId: saved.partyId,
      amount: saved.amount,
      currency: saved.currency,
    });
    console.debug("[DomainEvent]", event.type, event.payload);

    return Ok(saved);
  }
}
