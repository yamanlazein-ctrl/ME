import { eq, and, gte, lte, desc, sql } from "drizzle-orm";
import type { DB } from "../orm/drizzle.js";
import type { IAuditRepository, AuditLogFilter, AuditLogEntry } from "../../application/ports/IAuditRepository.js";
import type { TenantContext, PaginatedResult } from "../../domain/types/index.js";
import { auditLogs } from "../orm/schemas/audit-log.table.js";

export class PostgresAuditRepository implements IAuditRepository {
  constructor(private readonly db: DB) {}

  async create(data: {
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
  }): Promise<void> {
    await this.db.insert(auditLogs).values({
      tenantId: data.tenantId,
      actorId: data.actorId ?? null,
      actorName: data.actorName ?? null,
      module: data.module,
      action: data.action,
      entityType: data.entityType ?? null,
      entityId: data.entityId ?? null,
      detail: data.detail ?? null,
      beforeSnapshot: data.beforeSnapshot ? JSON.stringify(data.beforeSnapshot) : null,
      afterSnapshot: data.afterSnapshot ? JSON.stringify(data.afterSnapshot) : null,
      ipAddress: data.ipAddress ?? null,
    });
  }

  async list(filter: AuditLogFilter, ctx: TenantContext): Promise<PaginatedResult<AuditLogEntry>> {
    const conditions = [eq(auditLogs.tenantId, ctx.tenantId)];
    if (filter.entityType) conditions.push(eq(auditLogs.entityType, filter.entityType));
    if (filter.entityId) conditions.push(eq(auditLogs.entityId, filter.entityId));
    if (filter.actorId) conditions.push(eq(auditLogs.actorId, filter.actorId));
    if (filter.module) conditions.push(eq(auditLogs.module, filter.module));
    if (filter.action) conditions.push(eq(auditLogs.action, filter.action));
    if (filter.fromDate) conditions.push(gte(auditLogs.createdAt, new Date(filter.fromDate)));
    if (filter.toDate) conditions.push(lte(auditLogs.createdAt, new Date(filter.toDate)));

    const limit = Math.min(100, Math.max(1, filter.limit ?? 20));
    const offset = Math.max(0, filter.offset ?? 0);
    const where = and(...conditions);

    const [dataRows, countRows] = await Promise.all([
      this.db
        .select()
        .from(auditLogs)
        .where(where)
        .limit(limit)
        .offset(offset)
        .orderBy(desc(auditLogs.createdAt)),
      this.db
        .select({ count: sql<number>`count(*)` })
        .from(auditLogs)
        .where(where),
    ]);

    return {
      data: dataRows.map((r) => ({
        id: Number(r.id),
        tenantId: r.tenantId,
        actorId: r.actorId ?? undefined,
        actorName: r.actorName ?? undefined,
        module: r.module,
        action: r.action,
        entityType: r.entityType ?? undefined,
        entityId: r.entityId ?? undefined,
        detail: r.detail ?? undefined,
        beforeSnapshot: (r.beforeSnapshot as Record<string, unknown>) ?? undefined,
        afterSnapshot: (r.afterSnapshot as Record<string, unknown>) ?? undefined,
        ipAddress: r.ipAddress ?? undefined,
        createdAt: r.createdAt.toISOString(),
      })),
      meta: {
        total: Number(countRows[0]?.count ?? 0),
        page: Math.floor(offset / limit),
        limit,
        hasNext: offset + limit < Number(countRows[0]?.count ?? 0),
        totalPages: Math.ceil(Number(countRows[0]?.count ?? 0) / limit),
      },
    };
  }
}
