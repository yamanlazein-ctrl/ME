import type { EndpointMeta, ApiError } from "./_shared";
import type { DashboardDataDTO } from "@/application/ports/IDashboardRepository";

export type { DashboardDataDTO };

export type GetDashboardError = ApiError;
export const GetDashboardEndpoint: EndpointMeta = {
  path: "/api/dashboard",
  method: "GET",
  auth: { required: true, roles: ["admin", "accountant", "warehouse", "viewer"] },
  description: "Get dashboard overview data",
};
