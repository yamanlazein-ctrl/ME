import { eq, and, desc, sql } from "drizzle-orm";
import type { DB } from "../orm/drizzle.js";
import type { INotificationRepository } from "../../application/ports/INotificationRepository.js";
import { notifications } from "../orm/schemas/notification.table.js";
import { Notification } from "../../domain/entities/Notification.js";
import type {
  NotificationData,
  CreateNotificationInput,
} from "../../domain/entities/Notification.js";
import type { TenantContext, UUID } from "../../domain/types/index.js";

export class PostgresNotificationRepository implements INotificationRepository {
  constructor(private readonly db: DB) {}

  async findById(id: string, ctx: TenantContext): Promise<NotificationData | null> {
    const rows = await this.db
      .select()
      .from(notifications)
      .where(and(eq(notifications.id, id), eq(notifications.tenantId, ctx.tenantId)))
      .limit(1);
    if (rows.length === 0) return null;
    return this.toDomain(rows[0]);
  }

  async list(ctx: TenantContext): Promise<NotificationData[]> {
    const rows = await this.db
      .select()
      .from(notifications)
      .where(eq(notifications.tenantId, ctx.tenantId))
      .orderBy(desc(notifications.createdAt))
      .limit(100);
    return rows.map((r) => this.toDomain(r));
  }

  async create(input: CreateNotificationInput, ctx: TenantContext): Promise<NotificationData> {
    const [row] = await this.db
      .insert(notifications)
      .values({
        tenantId: ctx.tenantId,
        userId: input.userId ?? null,
        title: input.title,
        detail: input.detail,
        kind: input.kind,
        severity: input.severity ?? "info",
        targetPath: input.targetPath,
      })
      .returning();
    return this.toDomain(row);
  }

  async markRead(id: UUID, ctx: TenantContext): Promise<void> {
    await this.db
      .update(notifications)
      .set({ isRead: true })
      .where(and(eq(notifications.id, id), eq(notifications.tenantId, ctx.tenantId)));
  }

  async markAllRead(ctx: TenantContext): Promise<void> {
    await this.db
      .update(notifications)
      .set({ isRead: true })
      .where(eq(notifications.tenantId, ctx.tenantId));
  }

  async dismissAll(ctx: TenantContext): Promise<void> {
    await this.db
      .update(notifications)
      .set({ isDismissed: true })
      .where(eq(notifications.tenantId, ctx.tenantId));
  }

  async getUnreadCount(ctx: TenantContext): Promise<number> {
    const [row] = await this.db
      .select({ count: sql<number>`count(*)` })
      .from(notifications)
      .where(and(eq(notifications.tenantId, ctx.tenantId), eq(notifications.isRead, false)));
    return Number(row?.count ?? 0);
  }

  private toDomain(row: typeof notifications.$inferSelect): NotificationData {
    return Notification.reconstitute(this.mapRow(row)).toData();
  }

  private mapRow(row: typeof notifications.$inferSelect): NotificationData {
    const n = (v: string | null) => v ?? undefined;
    return {
      id: row.id,
      tenantId: row.tenantId,
      userId: n(row.userId),
      title: row.title,
      detail: n(row.detail),
      kind: row.kind as NotificationData["kind"],
      severity: row.severity as NotificationData["severity"],
      targetPath: n(row.targetPath),
      isRead: row.isRead,
      isDismissed: row.isDismissed,
      createdAt: row.createdAt.toISOString(),
    };
  }
}
