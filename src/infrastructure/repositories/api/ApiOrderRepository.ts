import { Order, type OrderData } from "@/domain/entities/Order";
import { TenantContext, UUID, type PaginatedResult } from "@/domain/types";
import type { IOrderRepository, OrderFilter } from "@/application/ports/IOrderRepository";
import type { CreateOrderInput, UpdateOrderInput } from "@/core/dtos/OrderDTO";
import { OrderApiService } from "@/infrastructure/api";

export class ApiOrderRepository implements IOrderRepository {
  constructor(private api: OrderApiService) {}

  async findById(id: UUID, ctx: TenantContext): Promise<Order | null> {
    try {
      const dto = await this.api.findById(id);
      return Order.reconstitute(dto as unknown as OrderData);
    } catch (e) {
      console.warn("[ApiRepo] Order findById failed", e);
      return null;
    }
  }

  async findByCode(code: string, ctx: TenantContext): Promise<Order | null> {
    try {
      const dto = await this.api.findByCode(code);
      return Order.reconstitute(dto as unknown as OrderData);
    } catch (e) {
      console.warn("[ApiRepo] Order findByCode failed", e);
      return null;
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
    const dto = await this.api.update(id, patch as Record<string, unknown>);
    return Order.reconstitute(dto as unknown as OrderData);
  }

  async cancel(id: UUID, ctx: TenantContext): Promise<Order> {
    const dto = await this.api.cancel(id);
    return Order.reconstitute(dto as unknown as OrderData);
  }

  async fulfill(id: UUID, invoiceId: UUID, ctx: TenantContext): Promise<Order> {
    const dto = await this.api.fulfill(id, invoiceId);
    return Order.reconstitute(dto as unknown as OrderData);
  }
}
