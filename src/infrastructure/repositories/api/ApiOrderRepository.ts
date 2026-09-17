import { Order, type OrderData } from "@/domain/entities/Order";
import { TenantContext, UUID, type PaginatedResult } from "@/domain/types";
import type {
  IOrderRepository,
  OrderFilter,
  PendingConflict,
  PendingConflictLine,
} from "@/application/ports/IOrderRepository";
import type { CreateOrderInput, UpdateOrderInput } from "@/core/dtos/OrderDTO";
import { OrderApiService } from "@/infrastructure/api";

export class ApiOrderRepository implements IOrderRepository {
  constructor(private api: OrderApiService) {}

  async findById(id: UUID, ctx: TenantContext): Promise<Order | null> {
    void ctx;
    try {
      const dto = await this.api.findById(id);
      return Order.reconstitute(dto as unknown as OrderData);
    } catch (e) {
      if (e instanceof Error && (e as unknown as { statusCode?: number }).statusCode === 404) return null;
      if ((e as unknown as { code?: string }).code === "NOT_FOUND") return null;
      throw e;
    }
  }

  async findByCode(code: string, ctx: TenantContext): Promise<Order | null> {
    void ctx;
    try {
      const dto = await this.api.findByCode(code);
      return Order.reconstitute(dto as unknown as OrderData);
    } catch (e) {
      if (e instanceof Error && (e as unknown as { statusCode?: number }).statusCode === 404) return null;
      if ((e as unknown as { code?: string }).code === "NOT_FOUND") return null;
      throw e;
    }
  }

  async list(filter: OrderFilter, ctx: TenantContext): Promise<PaginatedResult<Order>> {
    const res = await this.api.list(filter);
    const data = res.data.map((dto) => Order.reconstitute(dto as unknown as OrderData));
    return { data, total: res.meta.total, hasNext: res.meta.hasNext };
  }

  async create(input: CreateOrderInput, ctx: TenantContext): Promise<Order> {
    const dto = await this.api.create(input);
    return Order.reconstitute(dto as unknown as OrderData);
  }

  async update(id: UUID, patch: UpdateOrderInput, ctx: TenantContext): Promise<Order> {
    void ctx;
    const expectedVersion =
      typeof (patch as { version?: number }).version === "number"
        ? (patch as { version: number }).version
        : (await this.findById(id, ctx))?.version;
    if (typeof expectedVersion !== "number") {
      throw new Error("الإصدار المتوقع (expectedVersion) مطلوب لتحديث الطلب");
    }
    const dto = await this.api.update(id, { ...patch, expectedVersion });
    return Order.reconstitute(dto as unknown as OrderData);
  }

  async cancel(id: UUID, ctx: TenantContext, expectedVersion: number): Promise<Order> {
    void ctx;
    const dto = await this.api.cancel(id, expectedVersion);
    return Order.reconstitute(dto as unknown as OrderData);
  }

  async fulfill(id: UUID, invoiceId: UUID, ctx: TenantContext): Promise<Order> {
    const dto = await this.api.fulfill(id, invoiceId);
    return Order.reconstitute(dto as unknown as OrderData);
  }

  /** BUG-07 — informational only: pending orders wanting the same fabric/color. */
  async findPendingConflicts(
    lines: PendingConflictLine[],
    ctx: TenantContext,
  ): Promise<PendingConflict[]> {
    void ctx;
    const res = await this.api.pendingConflicts(lines);
    return res.data;
  }
}
