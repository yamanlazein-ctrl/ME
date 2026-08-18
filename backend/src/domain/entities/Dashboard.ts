export interface DashboardTransaction {
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

export interface DashboardData {
  store: { name: string; city: string };
  // FIX 1.1: per-currency breakdown only — money is NEVER mixed across currencies.
  // Frontend must read byCurrency[<code>] explicitly.
  todaySales: { byCurrency: Record<string, { total: number; count: number }> };
  todayInvoices: { count: number };
  weekSales: { byCurrency: Record<string, { total: number; count: number }> };
  monthSales: { byCurrency: Record<string, { total: number; count: number }> };
  recentTransactions: DashboardTransaction[];
  outstandingOrders: number;
  lowStockFabrics: number;
  lowStockRolls: { low: number; outOfStock: number };
  // Fix H-7 (forensic audit 2026-08-15): `syp` used to be a single number
  // that actually summed profit across every currency present, mislabeled
  // as if it were SYP-only. byCurrency reports each currency independently.
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
  // Fix H-7: groupBy(date) alone mixed every currency's sales into one
  // "value" per day. byCurrency reports each currency's own total per day.
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
  topCustomers: Array<{ partyId: string; name: string; revenue: number; currency: string }>;
  // Fix H-7: revenue used to be summed across every currency for a
  // fabric. revenueByCurrency reports each currency's revenue independently.
  topFabrics: Array<{
    fabricId: string;
    name: string;
    kgSold: number;
    revenueByCurrency: Record<string, number>;
  }>;
  cashbox: { balance: number; todayMovementCount: number; isLocked: boolean };
  // Fix H-7: receiptsThisMonth/paymentsThisMonth used to sum every
  // currency's vouchers into one number. byCurrency reports each
  // currency's receipts/payments/count independently.
  vouchers: {
    byCurrency: Record<string, { receipts: number; payments: number; count: number }>;
    count: number;
  };
  unreadNotifications: number;
  recentActivity: Array<{ module: string; action: string; detail: string; timestamp: string }>;
}
