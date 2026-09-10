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
}
