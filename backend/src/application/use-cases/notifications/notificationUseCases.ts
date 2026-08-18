import type { INotificationRepository } from "../../ports/INotificationRepository.js";
import type { TenantContext, UUID } from "../../../domain/types/index.js";
import type {
  NotificationData,
  CreateNotificationInput,
} from "../../../domain/entities/Notification.js";

type Result<T> = { ok: true; data: T } | { ok: false; error: string };

export async function createNotificationUseCase(
  repo: INotificationRepository,
  input: CreateNotificationInput,
  ctx: TenantContext,
): Promise<Result<NotificationData>> {
  try {
    return { ok: true, data: await repo.create(input, ctx) };
  } catch (e) {
    return { ok: false, error: "فشل إنشاء الإشعار" };
  }
}

export async function listNotificationsUseCase(
  repo: INotificationRepository,
  ctx: TenantContext,
): Promise<Result<NotificationData[]>> {
  try {
    return { ok: true, data: await repo.list(ctx) };
  } catch (e) {
    return { ok: false, error: "فشل عرض الإشعارات" };
  }
}

export async function markReadUseCase(
  repo: INotificationRepository,
  id: UUID,
  ctx: TenantContext,
): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    await repo.markRead(id, ctx);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: "فشل" };
  }
}

export async function markAllReadUseCase(
  repo: INotificationRepository,
  ctx: TenantContext,
): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    await repo.markAllRead(ctx);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: "فشل" };
  }
}

export async function dismissAllUseCase(
  repo: INotificationRepository,
  ctx: TenantContext,
): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    await repo.dismissAll(ctx);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: "فشل" };
  }
}

export async function getUnreadCountUseCase(
  repo: INotificationRepository,
  ctx: TenantContext,
): Promise<Result<number>> {
  try {
    return { ok: true, data: await repo.getUnreadCount(ctx) };
  } catch (e) {
    return { ok: false, error: "فشل" };
  }
}
