import type { EndpointMeta, ApiError } from "./_shared";
import type { AppNotificationDTO } from "@/application/ports/INotificationRepository";

export type { AppNotificationDTO };

export type ListNotificationsResponse = AppNotificationDTO[];
export type ListNotificationsError = ApiError;
export const ListNotificationsEndpoint: EndpointMeta = {
  path: "/api/notifications",
  method: "GET",
  auth: { required: true, roles: ["admin", "accountant", "warehouse", "viewer"] },
  description: "List all active notifications",
};

export type DismissAllNotificationsError = ApiError;
export const DismissAllNotificationsEndpoint: EndpointMeta = {
  path: "/api/notifications/dismiss-all",
  method: "POST",
  auth: { required: true, roles: ["admin", "accountant", "warehouse", "viewer"] },
  description: "Dismiss all notifications",
};

export type GetUnreadCountResponse = { count: number };
export type GetUnreadCountError = ApiError;
export const GetUnreadCountEndpoint: EndpointMeta = {
  path: "/api/notifications/unread-count",
  method: "GET",
  auth: { required: true, roles: ["admin", "accountant", "warehouse", "viewer"] },
  description: "Get count of unread notifications",
};

export type MarkReadError = ApiError & { code: "NOT_FOUND" };
export const MarkReadEndpoint: EndpointMeta = {
  path: "/api/notifications/:id/read",
  method: "POST",
  auth: { required: true, roles: ["admin", "accountant", "warehouse", "viewer"] },
  description: "Mark a single notification as read",
};
