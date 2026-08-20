import { Result, Ok, Err } from "@/core/result";
import { ValidationError } from "@/domain/errors";
import { Party, PaymentTerms } from "@/domain/entities/Party";
import { TenantContext } from "@/domain/types";
import { IPartyRepository } from "@/application/ports/IPartyRepository";
import type { CreatePartyInput } from "@/core/dtos/PartyDTO";
import { createPartySchema } from "@erp/shared";

export class CreatePartyUseCase {
  constructor(private readonly repo: IPartyRepository) {}

  async execute(
    input: CreatePartyInput,
    ctx: TenantContext,
  ): Promise<Result<Party, ValidationError>> {
    const parsed = createPartySchema.safeParse(input);
    if (!parsed.success) {
      const first = parsed.error.issues[0];
      return Err(new ValidationError(first.message, first.path.join(".")));
    }

    const party = Party.create({
      ...(parsed.data as unknown as CreatePartyInput),
      tenantId: ctx.tenantId,
      kind: parsed.data.kind,
      createdBy: ctx.userName,
      paymentTerms: parsed.data.paymentTerms as unknown as PaymentTerms | undefined,
    } as unknown as Parameters<typeof Party.create>[0]);

    const saved = await this.repo.create(party, ctx);
    return Ok(saved);
  }
}
