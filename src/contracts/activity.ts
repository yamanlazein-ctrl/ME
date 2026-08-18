import type { EndpointMeta, ApiError, PaginationParams, SortParams } from "./_shared";
import type { ActivityEntryDTO } from "@/application/ports/ISettingsRepository";

export type { ActivityEntryDTO };

export interface ActivityFilter extends PaginationParams, SortParams {
  module?: string;
  action?: string;
  userId?: string;
  fromDate?: string;
  toDate?: string;
}
export type ListActivityResponse = { data: ActivityEntryDTO[]; total: number };
export type ListActivityError = ApiError;
export const ListActivityEndpoint: EndpointMeta = {
  path: "/api/activity",
  method: "GET",
  auth: { required: true, roles: ["admin", "accountant"] },
  description: "List audit log activity entries",
};

export type ClearActivityError = ApiError;
export const ClearActivityEndpoint: EndpointMeta = {
  path: "/api/activity",
  method: "DELETE",
  auth: { required: true, roles: ["admin"] },
  description: "Clear all audit log entries",
};

export interface LogActivityRequest {
  module: string;
  action: string;
  detail?: string;
}
export type LogActivityError = ApiError;
export const LogActivityEndpoint: EndpointMeta = {
  path: "/api/activity",
  method: "POST",
  auth: { required: true, roles: ["admin", "accountant", "warehouse"] },
  description: "Log an activity entry",
};
