import { TenantContext } from "@/domain/types";
import type {
  IDashboardRepository,
  DashboardDataDTO,
  TransactionDTO,
} from "@/application/ports/IDashboardRepository";
import { DashboardApiService } from "@/infrastructure/api";
import type { BackendDashboardResponse } from "@/infrastructure/api/DashboardApiService";

/**
 * Frontend adapter: maps the backend GET /api/dashboard response into the
 * existing DashboardDataDTO consumed by the dashboard components.
 *
 * Mapping rule: every DTO field is mapped ONLY when the backend response
 * provides a real source. Fields with no source are set to empty/zero and
 * are documented as NOT CONNECTED — never invented.
 */
export function mapDashboardResponse(raw: BackendDashboardResponse): DashboardDataDTO {
  return {
    store: {
      name: raw.store?.name ?? "", // real source (company profile)
      city: raw.store?.city ?? "", // real source (company profile)
    },
    // user.name/role/initials: not present in the dashboard response → NOT CONNECTED
    user: {
      name: "",
      role: "",
      initials: "",
      unreadNotifications: raw.unreadNotifications ?? 0, // real source
    },
    // Derive session status from cashbox opening data — the backend
    // dashboard response does not include a dedicated session object,
    // but the cashbox always carries openingBalance + openingDate
    // which serve as the authoritative session indicator.
    session: {
      open: !!raw.cashbox?.openingDate,
      openedAt: raw.cashbox?.openingDate ?? "",
    },
    cashBalance: {
      syp: raw.cashbox?.balance ?? 0, // real source (cashbox.balance)
      usd: 0, // no USD balance source → NOT CONNECTED
    },
    // Fix H-7: the backend now returns todayProfit.byCurrency (never a
    // single blended number). ProfitDTO only has one slot for
    // marginPercent/trend, so — same "map only a real source, never
    // invent/blend" rule this adapter already follows elsewhere — syp and
    // usd are read from their OWN currency buckets independently (never
    // summed together), and marginPercent/trend are taken from SYP's own
    // bucket specifically (documented here, not silently blended) since
    // this DTO shape has no per-currency slot for those two fields.
    todayProfit: {
      syp: raw.todayProfit?.byCurrency?.SYP?.today ?? 0, // real source, SYP only
      usd: raw.todayProfit?.byCurrency?.USD?.today ?? 0, // real source, USD only — was hardcoded 0/NOT CONNECTED before
      marginPercent: raw.todayProfit?.byCurrency?.SYP?.marginPercent ?? 0, // SYP bucket only
      trend: raw.todayProfit?.byCurrency?.SYP?.trend ?? "up", // SYP bucket only
    },
    todaySales: {
      syp: raw.todaySales?.byCurrency?.SYP?.total ?? 0, // real source (sale invoices, SYP only)
      usd: raw.todaySales?.byCurrency?.USD?.total ?? 0, // real source (sale invoices, USD only)
      changeVsYesterday: 0, // no source → NOT CONNECTED
    },
    activeRolls: {
      total: raw.activeRolls?.total ?? 0, // real source (in-stock rolls)
      fabricTypes: raw.activeRolls?.fabricTypes ?? 0, // real source
      colors: raw.activeRolls?.colors ?? 0, // real source
    },
    totalInventoryKg: raw.totalInventoryKg ?? 0, // real source (sum of remaining kg)
    activeTodayCustomers: raw.activeTodayCustomers ?? 0, // real source (distinct customers today)
    unpaidInvoices: {
      count: raw.unpaidInvoices?.count ?? 0,
      byCurrency: raw.unpaidInvoices?.byCurrency ?? {},
    },
    lowStockRolls: {
      low: raw.lowStockRolls?.low ?? 0, // real source (roll-level)
      outOfStock: raw.lowStockRolls?.outOfStock ?? 0, // real source
    },
    todayInvoices: {
      count:
        raw.todayInvoices?.count ??
        // no per-day invoice count source → NOT CONNECTED (counts come from useInvoicesList)
        0,
      returns: 0, // no source → NOT CONNECTED (returns come from useReturnsList)
    },
    recentTransactions: (raw.recentTransactions && raw.recentTransactions.length > 0
      ? raw.recentTransactions
      : legacyRecentTransactions(raw)
    ).map((t) => ({
      type: t.type,
      id: t.id,
      invoiceNo: t.invoiceNo,
      reference: t.reference,
      amount: t.amount,
      currency: t.currency,
      customer: t.customer,
      supplier: t.supplier,
      party: t.party,
      detail: t.detail,
      time: t.time,
    })),
    alerts: (raw.alerts ?? []).map((a) => ({
      category: a.category,
      level: a.level,
      fabric: a.fabric,
      color: a.color,
      colorCode: a.colorCode,
      rollNo: a.rollNo,
      remaining: a.remaining,
    })),
    // Fix H-7: the backend now returns revenueByCurrency (never a single
    // number that summed every currency's revenue for a fabric). TopFabricDTO
    // only has one numeric slot (salesK), so — same rule as above — this
    // reads the SYP bucket specifically and documents it, instead of
    // silently summing SYP + USD the way `f.revenue` used to.
    topFabrics: (raw.topFabrics ?? []).map((f) => ({
      name: f.name, // real source
      salesK: (f.revenueByCurrency?.SYP ?? 0) / 1000, // real source, SYP only (thousands of SYP)
    })),
    // Fix H-7: each day's point is now { label, byCurrency } from the
    // backend (never a single blended value). Project SYP specifically —
    // never sum across currencies — matching the topFabrics/todayProfit
    // fix above until the chart component itself is redesigned to render
    // a per-currency series.
    salesTrend: Object.fromEntries(
      Object.entries(raw.salesTrend ?? {}).map(([range, points]) => [
        range,
        points.map((p) => ({ label: p.label, value: p.byCurrency?.SYP ?? 0 })),
      ]),
    ),
  };
}

/**
 * Fallback: derive transaction rows from the legacy audit-activity source
 * (no amounts, approximate types). Used only when the backend does not yet
 * provide a real `recentTransactions` array.
 */
function legacyRecentTransactions(raw: BackendDashboardResponse): TransactionDTO[] {
  return (raw.recentActivity ?? []).map((a) => ({
    type: activityType(a.module, a.detail),
    id: "",
    invoiceNo: extractInvoiceNumber(a.detail) ?? undefined,
    detail: a.detail,
    time: a.timestamp ?? "",
    amount: 0, // activity carries no amount → NOT CONNECTED
    currency: "SYP",
  }));
}

function activityType(module: string, detail: string): TransactionDTO["type"] {
  if (module === "returns") return "return";
  if (module === "payments" || module === "vouchers") return "payment";
  if (module === "invoices") {
    if (/مرتجع/.test(detail)) return "return";
    if (/دخول|شراء/.test(detail)) return "entry";
  }
  return "sale";
}

function extractInvoiceNumber(detail: string): string | null {
  const m = detail?.match(/INV-\d{4}-\d+/);
  return m ? m[0] : null;
}

export class ApiDashboardRepository implements IDashboardRepository {
  constructor(private api: DashboardApiService) {}

  async getDashboardData(ctx: TenantContext): Promise<DashboardDataDTO> {
    const raw = await this.api.get();
    return mapDashboardResponse(raw);
  }
}
