import { Result, Ok, Err } from "@/core/result";
import { ValidationError, NotFoundError } from "@/domain/errors";
import { Color, ColorData } from "@/domain/entities/Color";
import { TenantContext } from "@/domain/types";
import { IInventoryRepository } from "@/application/ports";

export class CreateColorUseCase {
  constructor(private readonly inventory: IInventoryRepository) {}

  async execute(
    input: Omit<ColorData, "id" | "tenantId" | "createdAt">,
    ctx: TenantContext,
  ): Promise<Result<Color, ValidationError | NotFoundError>> {
    if (!input.name?.trim()) {
      return Err(new ValidationError("اسم اللون مطلوب.", "name"));
    }
    if (!input.code?.trim()) {
      return Err(new ValidationError("رمز اللون مطلوب.", "code"));
    }

    const color = Color.create({
      ...input,
      tenantId: ctx.tenantId,
    });

    const saved = await this.inventory.createColor(color, ctx);
    return Ok(saved);
  }
}
