import type { BaseHttpClient } from "@/infrastructure/http";
import type { AppNotificationDTO, ListNotificationsResponse } from "@/contracts/notifications";

export class NotificationApiService {
  constructor(private client: BaseHttpClient) {}

  async list(): Promise<ListNotificationsResponse> {
    const res = await this.client.get<ListNotificationsResponse>("/api/notifications");
    return res.data;
  }

  async markRead(id: string): Promise<void> {
    await this.client.post(`/api/notifications/${id}/read`);
  }

  async markAllRead(): Promise<void> {
    await this.client.post("/api/notifications/mark-all-read");
  }

  async dismissAll(): Promise<void> {
    await this.client.post("/api/notifications/dismiss-all");
  }

  async getUnreadCount(): Promise<number> {
    const res = await this.client.get<{ count: number }>("/api/notifications/unread-count");
    return res.data.count;
  }

  async create(input: {
    title: string;
    detail?: string;
    kind?: string;
    severity?: string;
    targetPath?: string;
  }): Promise<AppNotificationDTO> {
    const res = await this.client.post<AppNotificationDTO>("/api/notifications", input);
    return res.data;
  }
}
