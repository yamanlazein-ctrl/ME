import type { TenantContext, UUID } from "@/domain/types";

export type NotificationKind = "credit" | "aging" | "stock" | "unpaid" | "cash" | "order";
export type NotificationSeverity = "info" | "warning" | "critical";

export interface AppNotificationDTO {
  id: UUID;
  title: string;
  detail?: string;
  kind: NotificationKind;
  severity: NotificationSeverity;
  to?: { path: string } | null;
  createdAt: string;
}

export interface INotificationRepository {
  list(ctx: TenantContext): Promise<AppNotificationDTO[]>;
  dismissAll(ctx: TenantContext): Promise<void>;
  getUnreadCount(ctx: TenantContext): Promise<number>;
  create(
    input: {
      title: string;
      detail?: string;
      kind?: string;
      severity?: string;
      targetPath?: string;
    },
    ctx: TenantContext,
  ): Promise<AppNotificationDTO>;
}
