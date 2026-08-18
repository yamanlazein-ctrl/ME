import { Result } from "@/core/result";
import { NotFoundError } from "@/domain/errors";
import { TenantContext } from "@/domain/types";
import { IInventoryRepository, InventoryFilter } from "@/application/ports";

export class ListFabricsUseCase {
  constructor(private readonly inventory: IInventoryRepository) {}

  execute(filter: InventoryFilter, ctx: TenantContext) {
    return this.inventory.listFabrics(filter, ctx);
  }
}

export class ListColorsUseCase {
  constructor(private readonly inventory: IInventoryRepository) {}

  execute(filter: InventoryFilter, ctx: TenantContext) {
    return this.inventory.listColors(filter, ctx);
  }
}

export class ListRollsUseCase {
  constructor(private readonly inventory: IInventoryRepository) {}

  execute(filter: InventoryFilter, ctx: TenantContext) {
    return this.inventory.listRolls(filter, ctx);
  }
}
