import {
  ArrowDownLeft,
  ArrowUpRight,
  Receipt,
  TrendingUp,
  Users,
  Truck,
  Wallet,
} from "lucide-react";
import { useLedgerEntries, useCashMovementsOn } from "@/presentation/hooks/useLedger";
import { useCashBalance } from "@/presentation/hooks/useCashbox";
import { useExpensesList } from "@/presentation/hooks/useExpenses";
import { useInvoicesList } from "@/presentation/hooks/useInvoices";
import { useVouchersList } from "@/presentation/hooks/useVouchers";
import { buildOutstanding } from "@/presentation/hooks/useLedger";
import { customers, suppliers, customerById, supplierById } from "@/presentation/hooks/useParties";
import { formatAmount } from "@/presentation/hooks/useCurrency";
import { KpiCard } from "./KpiCard";

export function AccountingKpiRow() {
  const { data: ledgerEntries = [] } = useLedgerEntries();
  const { data: invoicesData } = useInvoicesList();
  const invoices = invoicesData?.data ?? [];
  const { data: expensesData } = useExpensesList();
  const expenses = expensesData ?? [];
  const { data: vouchersData } = useVouchersList();
  const vouchers = vouchersData?.data ?? [];
  const { data: balanceData } = useCashBalance();
  const balance = balanceData ?? 0;
  const today = new Date().toISOString().slice(0, 10);
  const { data: cashMovementsData } = useCashMovementsOn(today);
  const { in: inToday, out: outToday } = cashMovementsData ?? { in: 0, out: 0 };

  // Fix C-10 (forensic audit 2026-08-15): every KPI below used to
  // `.reduce()` straight across currencies with no grouping — a SYP
  // expense and a USD expense were added into one number and rendered
  // labelled "SYP" (formatAmount(x, "SYP")). Group by currency instead,
  // and render via KpiCard's existing syp/usd dual-display mode (already
  // used elsewhere in this codebase) so SYP and USD are always shown as
  // two separate figures, never summed. EUR amounts are intentionally
  // excluded from both totals rather than silently folded into either —
  // KpiCard/DualCurrency has no third slot yet, so an EUR figure would
  // have nowhere correct to go; better to omit it than mislabel it.
  const byCurrency = <T,>(items: T[], amountOf: (x: T) => number, currencyOf: (x: T) => string) => {
    const out: Record<string, number> = { SYP: 0, USD: 0 };
    for (const it of items) {
      const c = currencyOf(it);
      if (c === "SYP" || c === "USD") out[c] += amountOf(it);
    }
    return out;
  };

  const todayExpensesActive = expenses.filter((e) => e.status === "active" && e.date === today);
  const todayExpensesByCurrency = byCurrency(
    todayExpensesActive,
    (e) => e.amount,
    (e) => e.currency,
  );
  const largestExpense = todayExpensesActive.sort((a, b) => b.amount - a.amount)[0];

  // AR / AP — buildOutstanding's rows carry their own `currency`; group by
  // it instead of adding every row's `remaining` into one blended total.
  let arCount = 0;
  const arTotalByCurrency: Record<string, number> = { SYP: 0, USD: 0 };
  for (const c of customers) {
    const outs = buildOutstanding(c.id, invoices, vouchers);
    if (outs.length) {
      arCount++;
      for (const r of outs) {
        if (r.currency === "SYP" || r.currency === "USD") arTotalByCurrency[r.currency] += r.remaining;
      }
    }
  }
  let apCount = 0;
  const apTotalByCurrency: Record<string, number> = { SYP: 0, USD: 0 };
  for (const s of suppliers) {
    const outs = buildOutstanding(s.id, invoices, vouchers);
    if (outs.length) {
      apCount++;
      for (const r of outs) {
        if (r.currency === "SYP" || r.currency === "USD") apTotalByCurrency[r.currency] += r.remaining;
      }
    }
  }

  const lastReceipt = vouchers.filter((v) => v.kind === "receipt" && v.status === "active")[0];
  const lastPayment = vouchers.filter((v) => v.kind === "payment" && v.status === "active")[0];

  // Sales invoices DEBIT the customer's account (customer owes us), so today's
  // sales are the sum of debits on active sales_invoice ledger entries —
  // grouped by currency, never blended.
  const salesTodayByCurrency = byCurrency(
    ledgerEntries.filter((e) => e.status === "active" && e.date === today && e.type === "sales_invoice"),
    (e) => e.debit,
    (e) => e.currency,
  );
  const netProfitByCurrency = {
    SYP: salesTodayByCurrency.SYP - todayExpensesByCurrency.SYP,
    USD: salesTodayByCurrency.USD - todayExpensesByCurrency.USD,
  };

  return (
    <div className="space-y-3">
      <h3 className="text-sm font-bold text-foreground">مؤشرات المحاسبة</h3>
      <div className="grid gap-3 md:grid-cols-3 xl:grid-cols-6">
        <KpiCard title="النقدية الحالية" icon={Wallet} primary={formatAmount(balance, "SYP")} />
        <KpiCard title="وارد اليوم" icon={ArrowDownLeft} primary={formatAmount(inToday, "SYP")} />
        <KpiCard title="صادر اليوم" icon={ArrowUpRight} primary={formatAmount(outToday, "SYP")} />
        <KpiCard
          title="مصاريف اليوم"
          icon={Receipt}
          syp={todayExpensesByCurrency.SYP}
          usd={todayExpensesByCurrency.USD}
          secondary={largestExpense ? `أكبر: ${largestExpense.category}` : undefined}
        />
        <KpiCard
          title="أرباح صافية اليوم"
          icon={TrendingUp}
          syp={netProfitByCurrency.SYP}
          usd={netProfitByCurrency.USD}
        />
        <KpiCard
          title="الذمم المدينة (عملاء)"
          icon={Users}
          syp={arTotalByCurrency.SYP}
          usd={arTotalByCurrency.USD}
          secondary={`${arCount} عميل`}
        />
        <KpiCard
          title="الذمم الدائنة (موردون)"
          icon={Truck}
          syp={apTotalByCurrency.SYP}
          usd={apTotalByCurrency.USD}
          secondary={`${apCount} مورد`}
        />
        <KpiCard
          title="آخر سند قبض"
          icon={ArrowDownLeft}
          primary={lastReceipt ? formatAmount(lastReceipt.amount, lastReceipt.currency) : "—"}
          secondary={lastReceipt ? customerById(lastReceipt.partyId)?.name : undefined}
        />
        <KpiCard
          title="آخر سند صرف"
          icon={ArrowUpRight}
          primary={lastPayment ? formatAmount(lastPayment.amount, lastPayment.currency) : "—"}
          secondary={lastPayment ? supplierById(lastPayment.partyId)?.name : undefined}
        />
      </div>
    </div>
  );
}
