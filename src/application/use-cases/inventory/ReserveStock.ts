import { Result, Ok, Err } from "@/core/result";
import {
  InsufficientStockError,
  NotFoundError,
  ConcurrentModificationError,
} from "@/domain/errors";
import { TenantContext } from "@/domain/types";
import { IInventoryRepository } from "@/application/ports";

export class ReserveStockUseCase {
  constructor(private readonly inventory: IInventoryRepository) {}

  async execute(
    rollId: string,
    quantityKg: number,
    expectedVersion: number,
    ctx: TenantContext,
  ): Promise<Result<void, InsufficientStockError | NotFoundError | ConcurrentModificationError>> {
    const result = await this.inventory.reserveStock(rollId, quantityKg, expectedVersion, ctx);
    return result;
  }
}
