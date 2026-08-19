import type { BaseHttpClient } from "@/infrastructure/http";

/**
 * Raw wire shape returned by GET /api/dashboard (backend contract).
 * Kept separate from the frontend DashboardDataDTO — the repository
 * maps this shape into the DTO consumed by the dashboard components.
 */
export interface BackendDashboardTransaction {
  type: "sale" | "payment" | "entry" | "return";
  id: string;
  invoiceNo?: string;
  reference?: string;
  amount: number;
  currency: string;
  customer?: string;
  supplier?: string;
  party?: string;
  detail: string;
  time: string;
}

export interface BackendDashboardResponse {
  store: { name: string; city: string };
  todaySales: { byCurrency: Record<string, { total: number; count: number }> };
  todayInvoices: { count: number };
  weekSales: { byCurrency: Record<string, { total: number; count: number }> };
  monthSales: { byCurrency: Record<string, { total: number; count: number }> };
  outstandingOrders: number;
  lowStockFabrics: number;
  lowStockRolls: { low: number; outOfStock: number };
  // Fix H-7: byCurrency breakdown, matching the backend fix — never a
  // single number that silently summed every currency's profit.
  todayProfit: {
    byCurrency: Record<string, { today: number; marginPercent: number; trend: "up" | "down" }>;
  };
  activeRolls: { total: number; fabricTypes: number; colors: number };
  totalInventoryKg: number;
  activeTodayCustomers: number;
  unpaidInvoices: {
    count: number;
    byCurrency: Record<string, { count: number; totalDue: number }>;
  };
  // Fix H-7: per-day byCurrency breakdown instead of one blended value.
  salesTrend: Record<string, Array<{ label: string; byCurrency: Record<string, number> }>>;
  alerts: Array<{
    category: "inventory" | "financial";
    level: "low" | "out" | "overdue";
    fabric?: string;
    color?: string;
    colorCode?: string;
    rollNo?: string;
    remaining?: string;
  }>;
  topCustomers: Array<{ partyId: string; name: string; revenue: number }>;
  // Fix H-7: revenueByCurrency instead of one number that summed every
  // currency's revenue for that fabric.
  topFabrics: Array<{
    fabricId: string;
    name: string;
    kgSold: number;
    revenueByCurrency: Record<string, number>;
  }>;
  cashbox: { balance: number; todayMovementCount: number; isLocked: boolean; openingDate?: string };
  // Fix H-7: byCurrency breakdown instead of one blended
  // receiptsThisMonth/paymentsThisMonth number.
  vouchers: {
    byCurrency: Record<string, { receipts: number; payments: number; count: number }>;
    count: number;
  };
  unreadNotifications: number;
  recentActivity: Array<{ module: string; action: string; detail: string; timestamp: string }>;
  recentTransactions: BackendDashboardTransaction[];
}

export class DashboardApiService {
  constructor(private client: BaseHttpClient) {}

  async get(): Promise<BackendDashboardResponse> {
    const res = await this.client.get<BackendDashboardResponse>("/api/dashboard");
    return res.data;
  }
}