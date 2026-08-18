import type { TenantContext, PaginatedResult, UUID } from "../../domain/types/index.js";
import type {
  NotificationData,
  CreateNotificationInput,
} from "../../domain/entities/Notification.js";

export interface INotificationRepository {
  findById(id: string, ctx: TenantContext): Promise<NotificationData | null>;
  list(ctx: TenantContext): Promise<NotificationData[]>;
  create(input: CreateNotificationInput, ctx: TenantContext): Promise<NotificationData>;
  markRead(id: UUID, ctx: TenantContext): Promise<void>;
  markAllRead(ctx: TenantContext): Promise<void>;
  dismissAll(ctx: TenantContext): Promise<void>;
  getUnreadCount(ctx: TenantContext): Promise<number>;
}
