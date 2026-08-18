import type { TenantContext, PaginatedResult, UUID } from "../../domain/types/index.js";

export interface AuditLogEntry {
  id: number;
  tenantId: string;
  actorId?: UUID | null;
  actorName?: string | null;
  module: string;
  action: string;
  entityType?: string | null;
  entityId?: UUID | null;
  detail?: string | null;
  beforeSnapshot?: Record<string, unknown> | null;
  afterSnapshot?: Record<string, unknown> | null;
  ipAddress?: string | null;
  createdAt: string;
}

export interface AuditLogFilter {
  entityType?: string;
  entityId?: string;
  actorId?: string;
  module?: string;
  action?: string;
  fromDate?: string;
  toDate?: string;
  limit?: number;
  offset?: number;
}

export interface IAuditRepository {
  create(data: {
    tenantId: string;
    actorId?: string;
    actorName?: string;
    module: string;
    action: string;
    entityType?: string;
    entityId?: string;
    detail?: string;
    beforeSnapshot?: Record<string, unknown>;
    afterSnapshot?: Record<string, unknown>;
    ipAddress?: string;
  }): Promise<void>;

  /** Query audit logs with filters. Supports invoice tracking (entityType=invoice, entityId=xxx). */
  list(filter: AuditLogFilter, ctx: TenantContext): Promise<PaginatedResult<AuditLogEntry>>;
}
