import { Link } from "@tanstack/react-router";
import {
  ArrowLeftRight,
  ChevronLeft,
  PackagePlus,
  RotateCcw,
  ShoppingCart,
  Wallet,
} from "lucide-react";
import { useDashboard } from "@/presentation/hooks/useDashboard";
import { type TransactionDTO } from "@/application/ports/IDashboardRepository";
import { formatAmount, type Currency } from "@/presentation/hooks/useCurrency";

const META: Record<
  TransactionDTO["type"],
  { label: string; icon: typeof ShoppingCart; tone: string }
> = {
  sale: { label: "فاتورة مبيع", icon: ShoppingCart, tone: "bg-primary/15 text-primary" },
  payment: { label: "دفعة مقبوضة", icon: Wallet, tone: "bg-success/15 text-success" },
  entry: { label: "فاتورة الدخول", icon: PackagePlus, tone: "bg-chart-3/20 text-chart-3" },
  return: { label: "مرتجع", icon: RotateCcw, tone: "bg-destructive/15 text-destructive" },
};

function partyOf(t: TransactionDTO): string {
  if (t.type === "payment") return t.party ?? "";
  if (t.type === "entry") return t.supplier ?? t.party ?? "";
  return t.customer ?? t.party ?? "";
}

function refOf(t: TransactionDTO): string {
  return t.type === "payment" || t.type === "return" ? (t.reference ?? "") : (t.invoiceNo ?? "");
}

function detailOf(t: TransactionDTO): string {
  if (t.type === "payment") return `تسديد على ${t.reference ?? ""}`;
  return t.detail;
}

export function RecentTransactionsList() {
  const { data } = useDashboard();
  const items = data?.recentTransactions ?? [];
  return (
    <div className="rounded-xl border border-border bg-card shadow-soft">
      <div className="flex items-center justify-between border-b border-border px-5 py-4">
        <div className="flex items-center gap-2">
          <ArrowLeftRight className="h-4 w-4 text-muted-foreground" />
          <h3 className="text-sm font-semibold text-foreground">آخر العمليات</h3>
        </div>
        <Link to="/invoices" className="text-xs font-medium text-primary hover:underline">
          عرض الكل
        </Link>
      </div>
      <ul className="max-h-[24rem] overflow-y-auto divide-y divide-border">
        {items.map((t, i) => {
          const meta = META[t.type];
          const Icon = meta.icon;
          const isInvoice = t.type === "sale" || t.type === "entry";
          const row = (
            <div className="group flex items-center gap-4 px-5 py-4 hover:bg-secondary/60 transition cursor-pointer">
              <div className={`grid h-10 w-10 place-items-center rounded-lg ${meta.tone}`}>
                <Icon className="h-4.5 w-4.5" strokeWidth={2} />
              </div>

              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-semibold text-foreground truncate">
                    {partyOf(t)}
                  </span>
                  <span className="rounded-md bg-secondary px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground tabular-nums">
                    {refOf(t)}
                  </span>
                </div>
                <div className="mt-0.5 flex items-center gap-2 text-xs text-muted-foreground truncate">
                  <span>{meta.label}</span>
                  <span className="text-border">•</span>
                  <span className="truncate">{detailOf(t)}</span>
                </div>
              </div>

              <div className="text-left shrink-0">
                {/* Fix C-9 (forensic audit 2026-08-15): this used to convert
                    every non-SYP amount through a hardcoded EXCHANGE_RATES
                    guess and display it as if it were a real SYP amount.
                    Show the transaction's own real amount in its own real
                    currency — no invented conversion. */}
                <span className="font-bold tabular-nums">
                  {formatAmount(t.amount, t.currency as Currency)}
                </span>
                <div className="mt-0.5 text-[11px] text-muted-foreground text-start">{t.time}</div>
              </div>

              <ChevronLeft className="h-4 w-4 text-muted-foreground opacity-0 group-hover:opacity-100 transition" />
            </div>
          );
          return (
            <li key={i}>
              {isInvoice ? (
                <Link to="/invoices/$id" params={{ id: t.id }} className="block">
                  {row}
                </Link>
              ) : (
                row
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
