import { Result, Ok, Err } from "@/core/result";
import { ValidationError } from "@/domain/errors";
import { Fabric, FabricData } from "@/domain/entities/Fabric";
import { TenantContext } from "@/domain/types";
import { IInventoryRepository } from "@/application/ports";

export class CreateFabricUseCase {
  constructor(private readonly inventory: IInventoryRepository) {}

  async execute(
    input: Omit<FabricData, "id" | "tenantId" | "createdAt" | "createdBy">,
    ctx: TenantContext,
  ): Promise<Result<Fabric, ValidationError>> {
    if (!input.name?.trim()) {
      return Err(new ValidationError("اسم القماش مطلوب.", "name"));
    }

    const fabric = Fabric.create({
      ...input,
      tenantId: ctx.tenantId,
      createdBy: ctx.userName,
    });

    const saved = await this.inventory.createFabric(fabric, ctx);
    return Ok(saved);
  }
}
