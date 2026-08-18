import { TenantContext, UUID } from "@/domain/types";
import type {
  INotificationRepository,
  AppNotificationDTO,
} from "@/application/ports/INotificationRepository";
import { NotificationApiService } from "@/infrastructure/api";

export class ApiNotificationRepository implements INotificationRepository {
  constructor(private api: NotificationApiService) {}

  async list(ctx: TenantContext): Promise<AppNotificationDTO[]> {
    return this.api.list();
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
    return this.api.create(input);
  }

  async dismissAll(ctx: TenantContext): Promise<void> {
    await this.api.markAllRead();
  }

  async getUnreadCount(ctx: TenantContext): Promise<number> {
    return this.api.getUnreadCount();
  }
}
