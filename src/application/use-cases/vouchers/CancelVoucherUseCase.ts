import { Result, Ok, Err } from "@/core/result";
import { ValidationError, NotFoundError } from "@/domain/errors";
import { Voucher } from "@/domain/entities/Voucher";
import { VoucherCancelled } from "@/domain/events";
import { TenantContext, UUID } from "@/domain/types";
import { IVoucherRepository } from "@/application/ports/IVoucherRepository";
import { ILedgerRepository } from "@/application/ports/ILedgerRepository";

export class CancelVoucherUseCase {
  constructor(
    private readonly vouchers: IVoucherRepository,
    private readonly ledger: ILedgerRepository,
  ) {}

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

    await this.vouchers.cancel(id, ctx);

    await this.ledger.cancelByReference(id, ctx);

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
