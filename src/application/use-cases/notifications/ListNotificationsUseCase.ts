import { TenantContext } from "@/domain/types";
import {
  INotificationRepository,
  AppNotificationDTO,
} from "@/application/ports/INotificationRepository";

export class ListNotificationsUseCase {
  constructor(private readonly notifications: INotificationRepository) {}

  async execute(ctx: TenantContext): Promise<AppNotificationDTO[]> {
    return this.notifications.list(ctx);
  }

  async getUnreadCount(ctx: TenantContext): Promise<number> {
    return this.notifications.getUnreadCount(ctx);
  }

  async dismissAll(ctx: TenantContext): Promise<void> {
    return this.notifications.dismissAll(ctx);
  }

  async create(
    input: {
      title: string;
      detail?: string;
      kind?: string;
      severity?: string;
      targetPath?: string;
    },
    ctx: TenantContext,
  ): Promise<AppNotificationDTO> {
    return this.notifications.create(
      {
        title: input.title,
        detail: input.detail,
        kind: (input.kind ?? "info") as never,
        severity: (input.severity ?? "info") as never,
        targetPath: input.targetPath,
      },
      ctx,
    );
  }
}
