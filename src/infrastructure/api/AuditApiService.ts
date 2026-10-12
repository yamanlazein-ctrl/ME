import type { BaseHttpClient } from "@/infrastructure/http";

/** Audit-log row as returned by GET /api/audit-logs/invoice/:id. */
export type AuditLogDTO = {
  id: number;
  actorId?: string | null;
  actorName?: string | null;
  module: string;
  action: string;
  entityType?: string | null;
  entityId?: string | null;
  detail?: string | null;
  beforeSnapshot?: Record<string, unknown> | null;
  afterSnapshot?: Record<string, unknown> | null;
  createdAt: string;
};

export class AuditApiService {
  constructor(private client: BaseHttpClient) {}

  /**
   * Invoice-tracking feature: full audit timeline for one invoice,
   * newest first (see backend audit.route.ts).
   */
  async listByInvoice(invoiceId: string): Promise<AuditLogDTO[]> {
    const res = await this.client.get<{ data?: AuditLogDTO[] } | AuditLogDTO[]>(
      `/api/audit-logs/invoice/${invoiceId}`,
    );
    const body = res.data;
    return Array.isArray(body) ? body : (body.data ?? []);
  }

  /**
   * The tenant's durable audit trail, newest first, one page at a time (hermes F-016: the activity
   * screen used to show a device-local array that vanished on reload). The route caps `limit` at 100.
   */
  async listPage(offset: number, limit = 100): Promise<{ data: AuditLogDTO[]; total: number }> {
    const res = await this.client.get<{ data?: AuditLogDTO[]; meta?: { total?: number } }>(
      `/api/audit-logs`,
      { params: { offset: String(offset), limit: String(limit) } },
    );
    return { data: res.data.data ?? [], total: Number(res.data.meta?.total ?? 0) };
  }

  /** Every audit row of one module, newest first (e.g. "inventory_adjustments"). */
  // The route caps `limit` at 100 (200 made «تعديلات المخزون» fail to load).
  async listByModule(module: string, limit = 100): Promise<AuditLogDTO[]> {
    const res = await this.client.get<{ data?: AuditLogDTO[] } | AuditLogDTO[]>(`/api/audit-logs`, {
      params: { module, limit: String(limit) },
    });
    const body = res.data;
    return Array.isArray(body) ? body : (body.data ?? []);
  }
}
