import type { TenantContext } from "@/domain/types";

export interface StoreInfoDTO {
  name: string;
  city: string;
}

export interface UserSessionDTO {
  name: string;
  role: string;
  initials: string;
  unreadNotifications: number;
}

export interface SessionStatusDTO {
  open: boolean;
  openedAt: string;
}

export interface DualCurrencyAmountDTO {
  syp: number;
  usd: number;
}

export interface ProfitDTO {
  syp: number;
  usd: number;
  marginPercent: number;
  trend: "up" | "down";
}

export interface ActiveRollsDTO {
  total: number;
  fabricTypes: number;
  colors: number;
}

export interface UnpaidInvoicesDTO {
  count: number;
  byCurrency: Record<string, { count: number; totalDue: number }>;
}

export interface LowStockRollsDTO {
  low: number;
  outOfStock: number;
}

export interface TodayInvoicesDTO {
  count: number;
  returns: number;
}

export type TransactionDTO = {
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
};

export type AlertDTO = {
  category: "inventory" | "financial";
  level: "low" | "out" | "overdue";
  fabric?: string;
  color?: string;
  colorCode?: string;
  rollNo?: string;
  remaining?: string;
  customer?: string;
  invoiceNo?: string;
  amount?: number;
  currency?: string;
  daysOverdue?: number;
};

export interface TopFabricDTO {
  name: string;
  salesK: number;
}

export interface SalesTrendPointDTO {
  label: string;
  value: number;
}

export interface DashboardDataDTO {
  store: StoreInfoDTO;
  user: UserSessionDTO;
  session: SessionStatusDTO;
  cashBalance: DualCurrencyAmountDTO;
  todayProfit: ProfitDTO;
  todaySales: { syp: number; usd: number; changeVsYesterday: number };
  activeRolls: ActiveRollsDTO;
  totalInventoryKg: number;
  activeTodayCustomers: number;
  unpaidInvoices: UnpaidInvoicesDTO;
  lowStockRolls: LowStockRollsDTO;
  todayInvoices: TodayInvoicesDTO;
  recentTransactions: TransactionDTO[];
  alerts: AlertDTO[];
  topFabrics: TopFabricDTO[];
  salesTrend: Record<string, SalesTrendPointDTO[]>;
}

export interface IDashboardRepository {
  getDashboardData(ctx: TenantContext): Promise<DashboardDataDTO>;
}
