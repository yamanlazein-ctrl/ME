import { Result, Ok, Err } from "@/core/result";
import { ValidationError } from "@/domain/errors";
import { Party, PaymentTerms } from "@/domain/entities/Party";
import { TenantContext } from "@/domain/types";
import { IPartyRepository } from "@/application/ports/IPartyRepository";
import type { CreatePartyInput } from "@/core/dtos/PartyDTO";

export class CreatePartyUseCase {
  constructor(private readonly repo: IPartyRepository) {}

  async execute(
    input: CreatePartyInput,
    ctx: TenantContext,
  ): Promise<Result<Party, ValidationError>> {
    if (!input.name?.trim()) {
      return Err(new ValidationError("اسم الطرف مطلوب.", "name"));
    }

    const party = Party.create({
      ...input,
      tenantId: ctx.tenantId,
      kind: input.kind,
      createdBy: ctx.userName,
      paymentTerms: input.paymentTerms as PaymentTerms | undefined,
    });

    const saved = await this.repo.create(party, ctx);
    return Ok(saved);
  }
}
