import { Result, Ok, Err } from "@/core/result";
import { ValidationError, NotFoundError } from "@/domain/errors";
import { Voucher } from "@/domain/entities/Voucher";
import { VoucherCancelled } from "@/domain/events";
import { TenantContext, UUID } from "@/domain/types";
import { IVoucherRepository } from "@/application/ports/IVoucherRepository";

/**
 * ERP-007: the server's cancel endpoint reverses the ledger, the invoice's paid amount and enqueues
 * the sync unit in one transaction. The client must not try a second ledger cancellation — the API
 * ledger adapter refuses it by design, which used to fail every cancel AFTER it had succeeded.
 */
export class CancelVoucherUseCase {
  constructor(private readonly vouchers: IVoucherRepository) {}

  async execute(
    id: UUID,
    ctx: TenantContext,
  ): Promise<Result<Voucher, NotFoundError | ValidationError>> {
    const voucher = await this.vouchers.findById(id, ctx);
    if (!voucher) {
      return Err(new NotFoundError("Voucher", id));
    }

    if (!voucher.canCancel()) {
      return Err(new ValidationError("السند ملغى بالفعل."));
    }

    await this.vouchers.cancel(id, ctx, voucher.version);

    const event = VoucherCancelled(ctx.tenantId, {
      voucherId: voucher.id,
      number: voucher.number,
      cancelledBy: ctx.userName,
    });
    console.debug("[DomainEvent]", event.type, event.payload);

    const cancelled = await this.vouchers.findById(id, ctx);
    return Ok(cancelled!);
  }
}
