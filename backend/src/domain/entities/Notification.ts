import type { UUID, NotificationKind, NotificationSeverity } from "../types/index.js";

export interface NotificationData {
  id: UUID;
  tenantId: UUID;
  userId?: UUID;
  title: string;
  detail?: string;
  kind: NotificationKind;
  severity: NotificationSeverity;
  targetPath?: string;
  isRead: boolean;
  isDismissed: boolean;
  createdAt: string;
}

export class Notification {
  private constructor(private readonly data: NotificationData) {}

  static create(input: CreateNotificationInput): Notification {
    return new Notification({
      id: "" as UUID,
      tenantId: "" as UUID,
      userId: input.userId,
      title: input.title,
      detail: input.detail,
      kind: input.kind,
      severity: input.severity ?? "info",
      targetPath: input.targetPath,
      isRead: false,
      isDismissed: false,
      createdAt: "",
    });
  }

  static reconstitute(data: NotificationData): Notification {
    return new Notification(data);
  }

  markRead(): void {
    this.data.isRead = true;
  }
  dismiss(): void {
    this.data.isDismissed = true;
  }

  toData(): NotificationData {
    return { ...this.data };
  }
  get id(): UUID {
    return this.data.id;
  }
  get isRead(): boolean {
    return this.data.isRead;
  }
}

export interface CreateNotificationInput {
  userId?: UUID;
  title: string;
  detail?: string;
  kind: NotificationKind;
  severity?: NotificationSeverity;
  targetPath?: string;
}
